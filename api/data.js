import { createClient } from "redis";

// Um só painel, um só registro compartilhado — todo mundo lê/escreve a mesma chave.
const CHAVE = "prospeccao-tracking-v3";

let client;
async function getClient() {
    if (!client) {
          client = createClient({ url: process.env.REDIS_URL });
          client.on("error", (err) => console.error("Redis Client Error", err));
    }
    if (!client.isOpen) {
          await client.connect();
    }
    return client;
}

export default async function handler(req, res) {
    try {
          const redis = await getClient();

      if (req.method === "GET") {
              const valor = await redis.get(CHAVE);
              res.status(200).json({ value: valor ?? null });
              return;
      }

      if (req.method === "POST") {
              const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
              await redis.set(CHAVE, body?.value ?? "");
              res.status(200).json({ ok: true });
              return;
      }

      res.status(405).json({ error: "método não permitido" });
    } catch (err) {
          console.error(err);
          const semEnv = !process.env.REDIS_URL;
          res.status(500).json({
                  error: semEnv
                    ? "o banco de dados (Redis) não está conectado a este projeto — vá em Storage no Vercel e crie/conecte um banco Redis"
                            : "erro ao acessar o banco de dados: " + (err?.message || String(err)),
          });
    }
}
