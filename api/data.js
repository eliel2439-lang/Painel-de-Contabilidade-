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
    res.status(500).json({ error: "erro ao acessar o banco de dados — o Redis/KV foi criado e conectado no Vercel?" });
  }
}
