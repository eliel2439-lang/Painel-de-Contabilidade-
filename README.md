# Painel de Prospecção (Contabilidade / WhatsApp)

Projeto pronto pra rodar sozinho fora do claude.ai (GitHub + Vercel), com os
dados salvos num banco compartilhado — funciona igual em qualquer navegador
ou celular que abrir o link.

## Passo a passo completo

### 1. Criar o banco de dados no Vercel (só uma vez)
1. Entra no seu projeto no Vercel (o `painel-prospeccao` que já existe).
2. No menu da esquerda, clica em **"Armazenar"** (Storage).
3. Clica em **"Criar banco de dados"** (Create Database).
4. Procura por **Redis** (fornecido pela Upstash) e clica em criar / conectar.
5. Deixa no plano gratuito, confirma, e espera ficar "disponível".
6. Isso já conecta sozinho ao projeto e cria as variáveis de ambiente
   necessárias (`KV_REST_API_URL`, `KV_REST_API_TOKEN`) — você não precisa
   copiar nada manualmente.

### 2. Subir os arquivos no GitHub
No repositório `eliel2439-lang/painel-pro...`:
- Apague os arquivos antigos que estiverem lá (se houver).
- "Add file" → "Upload files".
- Arraste TODOS os arquivos e pastas dessa pasta (`package.json`,
  `index.html`, `vite.config.js`, `tailwind.config.js`, `postcss.config.js`,
  `.gitignore`, este `README.md`, e as pastas `src` e `api` inteiras).
- Commit changes na branch `principal`/`main`.

### 3. O Vercel publica sozinho
Assim que você commita no GitHub, o Vercel builda e publica de novo
automaticamente — já usando o banco de dados que você criou no passo 1.
Em 1-2 minutos o link já está funcionando com os dados compartilhados.

### Se preferir usar o terminal/Git em vez do site do GitHub
```bash
cd painel-prospeccao   # pasta que você baixou e descompactou
git init
git remote add origin https://github.com/eliel2439-lang/painel-pro....git
git add .
git commit -m "painel atualizado"
git branch -M main
git push -u origin main --force
```
(troque a URL pelo endereço real do seu repositório, que aparece no GitHub)

## Rodando local pra testar antes de subir (opcional)
```bash
npm install
vercel dev
```
Usar `vercel dev` (não `npm run dev`) pra testar local, porque ele também
roda a pasta `api/` — sem isso o salvamento não funciona no seu computador
(só depois de publicado).

