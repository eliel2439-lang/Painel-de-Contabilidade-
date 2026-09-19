import Redis from "ioredis";
import { gzipSync, gunzipSync } from "node:zlib";

// Um só painel, um só registro compartilhado — todo mundo lê/escreve a mesma chave.
const CHAVE = "prospeccao-tracking-v3";
const PREFIXO_BACKUP = CHAVE + ":bak:";
const INDICE_BACKUP = CHAVE + ":bak:indice";

// IMPORTANTE: o painel guarda milhares de contatos. Cada backup antigo era uma cópia
// COMPLETA do painel e chegávamos a manter 60 cópias. Isso pode estourar o maxmemory
// do Redis e bloquear TODOS os salvamentos com erro OOM. Agora mantemos poucos
// backups, bem mais espaçados e compactados.
const MAX_BACKUPS = 3;
const INTERVALO_MIN_ENTRE_BACKUPS_MS = 12 * 60 * 60 * 1000; // no máximo 1 backup a cada 12h
const PREFIXO_GZIP = "__gzip_base64_v1__:";

let redis;
function getRedis() {
  if (!redis) {
    if (!process.env.REDIS_URL) {
      throw new Error("REDIS_URL não está definida nas variáveis de ambiente deste projeto no Vercel");
    }
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      connectTimeout: 8000,
      lazyConnect: false,
    });
    redis.on("error", () => {});
  }
  return redis;
}

function descartarConexao() {
  try { redis?.disconnect(); } catch (e) {}
  redis = null;
}

function compactarBackup(valor) {
  try {
    return PREFIXO_GZIP + gzipSync(Buffer.from(valor, "utf8"), { level: 9 }).toString("base64");
  } catch (e) {
    // Se por qualquer motivo a compactação falhar, não derruba o painel.
    return valor;
  }
}

function descompactarBackup(valor) {
  if (typeof valor !== "string" || !valor.startsWith(PREFIXO_GZIP)) return valor;
  const base64 = valor.slice(PREFIXO_GZIP.length);
  return gunzipSync(Buffer.from(base64, "base64")).toString("utf8");
}

async function apagarBackupMaisAntigo(client) {
  const antigo = await client.rpop(INDICE_BACKUP);
  if (!antigo) return false;
  await client.del(PREFIXO_BACKUP + antigo);
  return true;
}

async function apararBackups(client, limite = MAX_BACKUPS) {
  let tamanho = Number(await client.llen(INDICE_BACKUP)) || 0;
  while (tamanho > limite) {
    const apagou = await apagarBackupMaisAntigo(client);
    if (!apagou) break;
    tamanho -= 1;
  }
}

function ehErroOOM(err) {
  return /OOM command not allowed|maxmemory|out of memory/i.test(String(err?.message || err));
}

async function talvezFazerBackup(client, valorAtual) {
  if (valorAtual == null) return;

  // Primeiro libera espaço dos backups antigos. No código anterior a limpeza só
  // acontecia DEPOIS de criar outro backup; quando o Redis já estava cheio, nem
  // chegávamos à etapa que apagava os antigos.
  await apararBackups(client, MAX_BACKUPS);

  const ultimoTs = await client.lindex(INDICE_BACKUP, 0);
  const agora = Date.now();
  const ultimoMs = ultimoTs ? new Date(ultimoTs).getTime() : 0;
  const precisaBackup = !ultimoTs || !Number.isFinite(ultimoMs) || agora - ultimoMs > INTERVALO_MIN_ENTRE_BACKUPS_MS;
  if (!precisaBackup) return;

  const ts = new Date().toISOString();
  try {
    await client.set(PREFIXO_BACKUP + ts, compactarBackup(valorAtual));
    await client.lpush(INDICE_BACKUP, ts);
    await apararBackups(client, MAX_BACKUPS);
  } catch (err) {
    // Backup nunca pode impedir o dado principal de ser salvo. Se o banco já estiver
    // lotado, removemos backups antigos e seguimos sem criar um novo neste momento.
    if (ehErroOOM(err)) {
      await apararBackups(client, 1);
      try { await client.del(PREFIXO_BACKUP + ts); } catch (e) {}
      return;
    }
    throw err;
  }
}

async function setPrincipalComRecuperacaoOOM(client, valor) {
  let resultado = await client.multi().set(CHAVE, valor).exec();
  if (resultado === null) return null;

  let erro = resultado?.[0]?.[0];
  if (!erro) return resultado;

  if (!ehErroOOM(erro)) throw erro;

  // Ainda ficou sem memória mesmo depois da limpeza normal: libera todos os backups
  // e tenta uma única vez de novo. É melhor perder pontos de restauração antigos do
  // que bloquear o painel inteiro e perder as alterações atuais.
  await apararBackups(client, 0);
  resultado = await client.multi().set(CHAVE, valor).exec();
  if (resultado === null) return null;
  erro = resultado?.[0]?.[0];
  if (erro) throw erro;
  return resultado;
}

export default async function handler(req, res) {
  let client;
  try {
    client = getRedis();

    // Auto-reparo: a primeira chamada depois do deploy já remove o excesso antigo
    // (o projeto anterior podia manter até 60 snapshots completos).
    await apararBackups(client, MAX_BACKUPS);

    if (req.method === "GET") {
      if (req.query.listarBackups) {
        const timestamps = await client.lrange(INDICE_BACKUP, 0, MAX_BACKUPS - 1);
        res.status(200).json({ backups: timestamps });
        return;
      }

      if (req.query.backupTs) {
        const valorArmazenado = await client.get(PREFIXO_BACKUP + req.query.backupTs);
        const valor = valorArmazenado == null ? null : descompactarBackup(valorArmazenado);
        res.status(200).json({ value: valor });
        return;
      }

      const valor = await client.get(CHAVE);
      res.status(200).json({ value: valor ?? null });
      return;
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      if (body?.restaurarBackup) {
        const valorArmazenado = await client.get(PREFIXO_BACKUP + body.restaurarBackup);
        if (valorArmazenado == null) {
          res.status(404).json({ error: "esse backup não existe mais" });
          return;
        }

        const valorBackup = descompactarBackup(valorArmazenado);
        const atual = await client.get(CHAVE);

        // Tenta guardar o estado atual antes da restauração, mas nunca deixa um
        // problema de espaço impedir a restauração solicitada.
        if (atual != null) {
          try { await talvezFazerBackup(client, atual); } catch (e) {}
        }

        // A restauração não usa WATCH porque é uma ação administrativa explícita.
        try {
          await client.set(CHAVE, valorBackup);
        } catch (err) {
          if (!ehErroOOM(err)) throw err;
          await apararBackups(client, 0);
          await client.set(CHAVE, valorBackup);
        }

        res.status(200).json({ ok: true });
        return;
      }

      if (typeof body?.value !== "string") {
        res.status(400).json({ error: "faltou o valor a salvar" });
        return;
      }

      await client.watch(CHAVE);
      const atualStr = await client.get(CHAVE);
      let revAtual = null;
      if (atualStr) {
        try { revAtual = JSON.parse(atualStr)?._rev ?? null; } catch (e) {}
      }

      if (body?.ifRev !== undefined && body.ifRev !== revAtual) {
        await client.unwatch();
        res.status(409).json({
          error: "outra pessoa (ou outra aba/aparelho) salvou uma alteração nesse meio tempo. Atualiza a página (F5) antes de tentar salvar de novo, pra não perder o que já foi salvo.",
        });
        return;
      }

      await talvezFazerBackup(client, atualStr);

      const resultado = await setPrincipalComRecuperacaoOOM(client, body.value);
      if (resultado === null) {
        res.status(409).json({
          error: "duas pessoas tentaram salvar exatamente ao mesmo tempo. Tenta salvar de novo — se continuar, atualiza a página (F5) primeiro.",
        });
        return;
      }

      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "método não permitido" });
  } catch (err) {
    console.error(err);
    const mensagem = String(err?.message || err);

    if (client) {
      try { await client.unwatch(); } catch (e) {}
    }

    if (/connect|ECONNRESET|ETIMEDOUT|Connection is closed|Stream isn't writeable/i.test(mensagem)) {
      descartarConexao();
    }

    const dicaOOM = ehErroOOM(err)
      ? " O Redis atingiu o limite de memória. Esta versão tenta limpar automaticamente backups antigos; se o erro continuar após publicar esta versão, o plano/limite do Redis precisa ser aumentado."
      : "";

    res.status(500).json({
      error: "erro ao acessar o banco de dados: " + mensagem + dicaOOM,
    });
  }
}
