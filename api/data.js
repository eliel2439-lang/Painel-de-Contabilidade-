import Redis from "ioredis";
import crypto from "crypto";

// Um só painel, um só registro compartilhado — todo mundo lê/escreve a mesma chave.
const CHAVE = "prospeccao-tracking-v3";
const PREFIXO_BACKUP = CHAVE + ":bak:";
const INDICE_BACKUP = CHAVE + ":bak:indice";
const MAX_BACKUPS = 60; // ~ quantos "pontos de restauração" mantemos
const INTERVALO_MIN_ENTRE_BACKUPS_MS = 2 * 60 * 1000; // não cria um backup novo a cada clique, só a cada 2 min no máximo

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "BRESILVA";

function adminTokenEsperado() {
  // O segredo real fica somente no servidor. ADMIN_TOKEN_SECRET é opcional; se não
  // existir, usamos REDIS_URL como material secreto porque ela também só existe no
  // ambiente do Vercel. O token nunca é colocado no código enviado ao navegador.
  const segredo = process.env.ADMIN_TOKEN_SECRET || process.env.REDIS_URL || "prospeccao-admin-server";
  return crypto.createHmac("sha256", segredo).update("admin:" + ADMIN_PASSWORD).digest("hex");
}

function tokenAdminValido(req) {
  const recebido = String(req.headers?.["x-admin-token"] || "");
  const esperado = adminTokenEsperado();
  if (!recebido || recebido.length !== esperado.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado));
  } catch (e) {
    return false;
  }
}

function senhaAdminValida(senha) {
  const a = Buffer.from(String(senha || "").trim());
  const b = Buffer.from(String(ADMIN_PASSWORD));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

function valorCampoAdmin(obj, campo) {
  if (campo === "vendedores") return obj?.[campo] || [];
  if (campo === "meta") return Number(obj?.[campo] || 0);
  return obj?.[campo] || {};
}

function campoAdminIgual(a, b, campo) {
  return JSON.stringify(valorCampoAdmin(a, campo)) === JSON.stringify(valorCampoAdmin(b, campo));
}

const CAMPOS_ADMIN = [
  "vendedores",
  "atribuicoes",
  "senhasEstado",
  "metasVendedor",
  "metaAlteracoesVendedor",
  "meta",
];

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
      if (req.query.validarAdmin) {
        res.status(tokenAdminValido(req) ? 200 : 401).json({ ok: tokenAdminValido(req) });
        return;
      }
      // Backups são administrativos. Um vendedor comum não pode listar nem ler
      // pontos de restauração do painel.
      if (req.query.listarBackups) {
        if (!tokenAdminValido(req)) { res.status(401).json({ error: "acesso administrativo necessário" }); return; }
        const timestamps = await client.lrange(INDICE_BACKUP, 0, MAX_BACKUPS - 1);
        res.status(200).json({ backups: timestamps });
        return;
      }
      if (req.query.backupTs) {
        if (!tokenAdminValido(req)) { res.status(401).json({ error: "acesso administrativo necessário" }); return; }
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

      if (body?.action === "adminLogin") {
        if (!senhaAdminValida(body?.password)) {
          res.status(401).json({ error: "senha administrativa incorreta" });
          return;
        }
        res.status(200).json({ ok: true, token: adminTokenEsperado() });
        return;
      }

      // Restaurar backup é ação administrativa e recebe revisão nova.
      if (body?.restaurarBackup) {
        if (!tokenAdminValido(req)) { res.status(401).json({ error: "acesso administrativo necessário" }); return; }
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
        // Restauração recebe uma revisão NOVA. Assim qualquer navegador que estava
        // aberto antes da restauração é obrigado a detectar conflito e sincronizar,
        // em vez de conseguir gravar por cima do backup restaurado silenciosamente.
        let revAtual = 0;
        try { revAtual = Number(JSON.parse(atual || "{}")?._rev || 0); } catch (e) {}
        let objBackup;
        let objAtual = {};
        try { objBackup = JSON.parse(valorBackup); } catch (e) {
          res.status(500).json({ error: "o backup existe, mas o conteúdo está corrompido" });
          return;
        }
        try { objAtual = atual ? JSON.parse(atual) : {}; } catch (e) {}

        // Nem uma restauração pode fazer um segmento desaparecer. Segmentos criados
        // depois do backup são mantidos com o conteúdo atual e entram no fim da ordem.
        const segmentosRestaurados = { ...(objBackup.segmentos || {}) };
        const ordemRestaurada = [...(objBackup.ordemSegmentos || [])];
        for (const [nome, conteudo] of Object.entries(objAtual.segmentos || {})) {
          if (!Object.prototype.hasOwnProperty.call(segmentosRestaurados, nome)) segmentosRestaurados[nome] = conteudo;
          if (!ordemRestaurada.includes(nome)) ordemRestaurada.push(nome);
        }
        objBackup = { ...objBackup, segmentos: segmentosRestaurados, ordemSegmentos: ordemRestaurada };

        const novaRev = Math.max(Date.now(), revAtual + 1);
        const restaurado = JSON.stringify({ ...objBackup, _rev: novaRev });
        await client.set(CHAVE, restaurado);
        res.status(200).json({ ok: true, rev: novaRev });
        return;
      }

      if (typeof body?.value !== "string") {
        res.status(400).json({ error: "faltou o valor a salvar" });
        return;
      }

      // --- Salvamento normal, com compare-and-set ATÔMICO no próprio Redis ---
      // Não usamos WATCH aqui. WATCH é ligado à conexão e uma Function quente pode
      // atender requisições simultâneas reaproveitando a mesma conexão, o que deixa
      // uma requisição interferir na outra. O script Lua abaixo faz a comparação da
      // revisão e o SET como UMA única operação atômica dentro do Redis.
      const atualStr = await client.get(CHAVE);

      // Proteções que existem NO SERVIDOR, não só na interface.
      // 1) segmento existente nunca pode ser removido por uma gravação comum;
      // 2) campos administrativos só podem mudar com token de administrador.
      let atualObj = {};
      let novoObj = {};
      try { atualObj = atualStr ? JSON.parse(atualStr) : {}; } catch (e) {}
      try { novoObj = JSON.parse(body.value); } catch (e) {
        res.status(400).json({ error: "o valor enviado não é um JSON válido" });
        return;
      }

      // Se o cliente já está em uma revisão antiga, responde conflito ANTES de
      // comparar permissões. Senão, uma mudança administrativa feita por outra
      // pessoa poderia parecer uma tentativa do vendedor de alterar campo protegido.
      const revAtualLida = atualObj?._rev ?? null;
      const revEsperadaLida = body?.ifRev ?? null;
      if (String(revAtualLida ?? "__NULL__") !== String(revEsperadaLida ?? "__NULL__")) {
        res.status(409).json({
          error: "o banco mudou desde a última leitura; sincronize e reaplique a alteração",
          currentRev: revAtualLida,
        });
        return;
      }

      const segmentosAtuais = Object.keys(atualObj?.segmentos || {});
      const segmentosNovos = new Set(Object.keys(novoObj?.segmentos || {}));
      const ordemNova = new Set(novoObj?.ordemSegmentos || []);
      const removeuSegmento = segmentosAtuais.some((nome) => !segmentosNovos.has(nome) || !ordemNova.has(nome));
      if (removeuSegmento) {
        res.status(403).json({ error: "segmentos não podem ser apagados nem escondidos" });
        return;
      }

      const mexeuEmCampoAdmin = CAMPOS_ADMIN.some((campo) => !campoAdminIgual(atualObj, novoObj, campo));
      if (mexeuEmCampoAdmin && !tokenAdminValido(req)) {
        res.status(403).json({ error: "essa alteração exige acesso administrativo" });
        return;
      }

      await talvezFazerBackup(client, atualStr);

      const esperado = body?.ifRev == null ? "__NULL__" : String(body.ifRev);
      const scriptCas = `
        local atual = redis.call("GET", KEYS[1])
        local rev = "__NULL__"
        if atual then
          local achou = string.match(atual, '"_rev"%s*:%s*([0-9]+)')
          if achou then rev = achou end
        end
        if rev ~= ARGV[1] then
          return {0, rev}
        end
        redis.call("SET", KEYS[1], ARGV[2])
        return {1, rev}
      `;

      const resultado = await client.eval(scriptCas, 1, CHAVE, esperado, body.value);
      const gravou = Array.isArray(resultado) && Number(resultado[0]) === 1;
      if (!gravou) {
        res.status(409).json({
          error: "outra pessoa salvou uma alteração antes desta. O painel vai baixar a versão mais nova, reaplicar sua alteração e tentar novamente automaticamente.",
          currentRev: Array.isArray(resultado) ? resultado[1] : null,
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
