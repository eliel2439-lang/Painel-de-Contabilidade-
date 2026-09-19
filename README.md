# Painel de Prospecção — Acesso 1 + Acesso 2 + senha por estado

Esta versão mantém os dados e a estrutura Redis existentes e altera apenas o fluxo de acesso dos vendedores.

## Fluxo de acesso

### Acesso 1 — administrador
- Entrada pela senha administrativa validada exclusivamente em `api/data.js` no servidor.
- Mantém Painel Geral, Vendedores, metas, conversões, mensagens, importação, exclusão, configuração de senhas por estado, backups e demais controles administrativos.
- A senha do Acesso 1 não existe em `src/` nem em `index.html`.

### Acesso 2 — vendedores
- Entrada pela senha geral do Acesso 2, validada exclusivamente no servidor.
- Não pede mais nome de vendedor.
- Depois de entrar, o vendedor vê os segmentos e o mapa/lista de estados.
- Ao selecionar um estado, precisa digitar a senha específica daquele estado.
- Somente depois da validação da senha do estado a API libera cidades/contatos daquele estado.
- O vendedor responsável é identificado automaticamente pela atribuição configurada no Painel Geral.
- O Acesso 2 continua sem Painel Geral, lista de vendedores, edição da mensagem-padrão, importação, inclusão/exclusão de contatos ou configurações administrativas.

## Segurança das senhas
- Senhas reais de Acesso 1, Acesso 2 e senha padrão de compatibilidade dos estados não aparecem no bundle React/HTML.
- Acesso 1 e Acesso 2 usam cookies HttpOnly/SameSite=Strict.
- A senha do estado é validada na API e gera apenas um token temporário limitado àquele segmento/UF.
- O token de estado não contém a senha.
- O token de estado só funciona enquanto a sessão HttpOnly do Acesso 2 também estiver válida.
- Alterar a senha do estado ou trocar o vendedor atribuído invalida os tokens antigos daquele estado.
- Um novo login explícito no Acesso 2 limpa os desbloqueios anteriores e exige novamente a senha do estado.
- Tentativas incorretas possuem limite temporário por origem/estado.

## Identificação do vendedor
O vendedor que recebe a contagem de mensagens não é informado pelo navegador. A API consulta a atribuição atual `segmento + estado -> vendedor` no banco no momento do envio. Assim, depois de entrar no estado correto, o envio é creditado automaticamente ao vendedor configurado para ele.

## Banco / dados
Não é necessário apagar, recriar ou migrar manualmente o Redis. As senhas de estado e atribuições já existentes continuam sendo utilizadas.

## Publicação
Publique no mesmo projeto e mantenha o Redis atual. Não é necessário criar variável nova no Vercel para esta versão.
