import Redis from "ioredis";

// Um só painel, um só registro compartilhado — todo mundo lê/escreve a mesma chave.
const CHAVE = "prospeccao-tracking-v3";
const PREFIXO_BACKUP = CHAVE + ":bak:";
const INDICE_BACKUP = CHAVE + ":bak:indice";
const MAX_BACKUPS = 60; // ~ quantos "pontos de restauração" mantemos
const INTERVALO_MIN_ENTRE_BACKUPS_MS = 2 * 60 * 1000; // não cria um backup novo a cada clique, só a cada 2 min no máximo

// Reaproveita a conexão entre chamadas "quentes" da função serverless. Se a conexão
// quebrar (ex: Redis reiniciou, timeout de rede), descartamos ela e criamos uma nova
// na próxima chamada, em vez de continuar tentando usar um socket morto.
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
    redis.on("error", () => {
      // silencioso aqui — cada chamada já trata erro no try/catch; isso só evita
      // que um erro de conexão "solto" derrube o processo da function.
    });
  }
  return redis;
}

function descartarConexao() {
  try { redis?.disconnect(); } catch (e) {}
  redis = null;
}

async function talvezFazerBackup(client, valorAtual) {
  if (valorAtual == null) return; // nada salvo ainda, não tem o que guardar
  const ultimoTs = await client.lindex(INDICE_BACKUP, 0);
  const agora = Date.now();
  const precisaBackup = !ultimoTs || agora - new Date(ultimoTs).getTime() > INTERVALO_MIN_ENTRE_BACKUPS_MS;
  if (!precisaBackup) return;

  const ts = new Date().toISOString();
  await client.set(PREFIXO_BACKUP + ts, valorAtual);
  await client.lpush(INDICE_BACKUP, ts);
  const tamanho = await client.llen(INDICE_BACKUP);
  if (tamanho > MAX_BACKUPS) {
    const antigo = await client.rpop(INDICE_BACKUP);
    if (antigo) await client.del(PREFIXO_BACKUP + antigo);
  }
}

export default async function handler(req, res) {
  let client;
  try {
    client = getRedis();

    if (req.method === "GET") {
      // Listar os pontos de restauração disponíveis.
      if (req.query.listarBackups) {
        const timestamps = await client.lrange(INDICE_BACKUP, 0, MAX_BACKUPS - 1);
        res.status(200).json({ backups: timestamps });
        return;
      }
      // Ver o conteúdo de um backup específico (sem aplicar ainda).
      if (req.query.backupTs) {
        const valor = await client.get(PREFIXO_BACKUP + req.query.backupTs);
        res.status(200).json({ value: valor ?? null });
        return;
      }
      const valor = await client.get(CHAVE);
      res.status(200).json({ value: valor ?? null });
      return;
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      // Restaurar um backup como se fosse o estado atual (e faz backup do que tinha antes de restaurar, por segurança).
      if (body?.restaurarBackup) {
        const valorBackup = await client.get(PREFIXO_BACKUP + body.restaurarBackup);
        if (valorBackup == null) {
          res.status(404).json({ error: "esse backup não existe mais" });
          return;
        }
        const atual = await client.get(CHAVE);
        if (atual != null) {
          const ts = new Date().toISOString();
          await client.set(PREFIXO_BACKUP + ts, atual);
          await client.lpush(INDICE_BACKUP, ts);
        }
        await client.set(CHAVE, valorBackup);
        res.status(200).json({ ok: true });
        return;
      }

      if (typeof body?.value !== "string") {
        res.status(400).json({ error: "faltou o valor a salvar" });
        return;
      }

      // --- Salvamento normal, protegido contra duas escritas ao mesmo tempo ---
      // 1) WATCH a chave: se ela mudar entre agora e o EXEC lá embaixo, a transação
      //    inteira é cancelada sozinha pelo próprio Redis (fecha a brecha de duas
      //    pessoas salvando no mesmíssimo instante, que o simples "confere e depois
      //    salva" não fechava).
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

      const resultado = await client.multi().set(CHAVE, body.value).exec();
      if (resultado === null) {
        // a chave mudou entre o WATCH e o EXEC — outra escrita ganhou na hora exata
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
    // Se o erro aconteceu no meio de um WATCH (entre o watch() e o exec()), limpa
    // esse estado da conexão — senão ele "vaza" e pode atrapalhar o próximo pedido
    // que reaproveitar essa mesma conexão.
    if (client) {
      try { await client.unwatch(); } catch (e) {}
    }
    // Erros de conexão (Redis caiu, timeout, socket fechado) — descarta a conexão
    // guardada pra próxima chamada começar do zero, em vez de ficar presa num
    // estado quebrado.
    if (/connect|ECONNRESET|ETIMEDOUT|Connection is closed|Stream isn't writeable/i.test(mensagem)) {
      descartarConexao();
    }
    res.status(500).json({
      error: "erro ao acessar o banco de dados: " + mensagem,
    });
  }
}
