import { kv } from "@vercel/kv";

// Um só painel, um só registro compartilhado — todo mundo lê/escreve a mesma chave.
const CHAVE = "prospeccao-tracking-v3";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const valor = await kv.get(CHAVE);
      res.status(200).json({ value: valor ?? null });
      return;
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      await kv.set(CHAVE, body?.value ?? "");
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "método não permitido" });
  } catch (err) {
    console.error(err);
    const semEnv = !process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN;
    res.status(500).json({
      error: semEnv
        ? "o banco de dados (KV/Redis) não está conectado a este projeto — vá em Storage no Vercel e crie/conecte um banco Redis"
        : "erro ao acessar o banco de dados: " + (err?.message || String(err)),
    });
  }
}
