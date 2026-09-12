import Redis from "ioredis";

// Um só painel, um só registro compartilhado — todo mundo lê/escreve a mesma chave.
const CHAVE = "prospeccao-tracking-v3";

// Reaproveita a conexão entre chamadas "quentes" da função serverless.
let redis;
function getRedis() {
  if (!redis) {
    if (!process.env.REDIS_URL) {
      throw new Error("REDIS_URL não está definida nas variáveis de ambiente deste projeto no Vercel");
    }
    redis = new Redis(process.env.REDIS_URL);
  }
  return redis;
}

export default async function handler(req, res) {
  try {
    const client = getRedis();

    if (req.method === "GET") {
      const valor = await client.get(CHAVE);
      res.status(200).json({ value: valor ?? null });
      return;
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      await client.set(CHAVE, body?.value ?? "");
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "método não permitido" });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "erro ao acessar o banco de dados: " + (err?.message || String(err)),
    });
  }
}
