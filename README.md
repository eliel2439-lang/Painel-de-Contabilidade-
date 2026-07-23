# Painel de Prospecção (Contabilidade / WhatsApp)

Projeto pronto pra rodar sozinho fora do claude.ai (GitHub + Vercel).

## O que foi ajustado nesse pacote

O arquivo original era um "artifact" do Claude, que usa uma função interna
(`window.storage`) pra salvar os dados — isso só existe dentro do claude.ai.
Pra funcionar hospedado no Vercel, troquei por `localStorage` do navegador
(ver início do `src/App.jsx`).

**Atenção com isso:** `localStorage` fica salvo no navegador de cada
aparelho/pessoa. Ou seja, o que a Carolina marcar no celular dela NÃO
aparece automaticamente no celular do Eliel, e vice-versa — cada um vê só
os dados que ele mesmo digitou no próprio navegador. Se no futuro vocês
quiserem que os dois vejam a mesma coisa em tempo real, dá pra trocar por
um banco de dados compartilhado (ex: Firebase, Supabase) — é um passo a mais.

## Passo a passo pra subir no GitHub e no Vercel

### 1. Subir os arquivos no GitHub
Você já tem o repositório `eliel2439-lang/painel-pro...` conectado ao Vercel.
No próprio site do GitHub (github.com), abra esse repositório e:
- Delete os arquivos antigos que estiverem lá dentro (se houver).
- Clique em "Add file" → "Upload files".
- Arraste TODOS os arquivos e pastas de dentro dessa pasta que você baixou
  (package.json, index.html, vite.config.js, tailwind.config.js,
  postcss.config.js, .gitignore, README.md e a pasta `src` inteira).
- Escreva uma mensagem tipo "painel atualizado" e clique em "Commit changes"
  direto na branch `principal` (ou `main`, dependendo de como seu repo se chama).

### 2. O Vercel publica sozinho
Como seu projeto no Vercel já está conectado a esse repositório, assim que
você faz o commit no GitHub, o Vercel detecta automaticamente e já builda e
publica a versão nova — não precisa fazer mais nada no Vercel. Em 1-2
minutos o link `painel-prospeccao-six.vercel.app` já está atualizado.

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
npm run dev
```
Abre em `http://localhost:5173`
