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

## Atualização — métricas no Acesso 2
- O vendedor responsável pelo estado volta a enxergar o próprio painel de desempenho.
- Exibe mensagens de hoje, semana e mês, além da meta diária.
- Exibe solicitações de site de hoje, semana e mês.
- Calcula taxa de solicitação por período e destaca a taxa mensal.
- Mostra o equivalente "X solicitações a cada 100 mensagens".
- Os últimos 7 dias mostram mensagens, meta, solicitações e taxa diária.
- No Acesso 2, a API devolve somente as solicitações do vendedor atribuído ao estado; vendas e dados de outros vendedores não são enviados ao navegador.
- O polling de 20 segundos preserva esses dados privados e os atualiza pelo endpoint protegido do estado.

## Atualização — módulo avançado de comissões
- Nova página **Comissões** exclusiva do Acesso 1.
- Cadastro de venda por vendedor, cliente, telefone, data e valor vendido.
- Comissão por valor fixo ou percentual; percentual calcula automaticamente e permite exceção manual auditável.
- Parcelamento em até 24 parcelas, com vencimentos editáveis e validação de soma total.
- Calendário mensal de comissões com valores e status por dia.
- Status derivados automaticamente: programada, a receber, paga, vencida e cancelada.
- Registro de pagamentos parciais ou integrais, com data, forma de pagamento e observação.
- Correção de pagamento preservando histórico de auditoria.
- Cancelamento preserva venda, pagamentos já feitos e trilha financeira.
- Dashboard com vendido no mês/ano/histórico, comissão gerada, paga, aberta, vencida e previsões de 7/15/30/60 dias.
- Rankings separados por valor vendido, quantidade de vendas e comissão gerada.
- Filtros por vendedor, período, status e busca por cliente/telefone/vendedor.
- Proteção contra venda possivelmente duplicada, com confirmação explícita para cadastrar mesmo assim.
- Dados financeiros separados em hashes Redis de vendas, parcelas, pagamentos e histórico; gravações financeiras usam lock + MULTI.
- Pagamentos usam identificador idempotente: retry de rede não duplica pagamento.
- Leitura financeira é feita sob o mesmo lock das gravações para evitar snapshot misturado.
- Nova página **Minhas Comissões** no Acesso 2 após desbloquear o estado. A API identifica o vendedor pelo estado e devolve somente os dados financeiros desse vendedor.
- Vendedor tem acesso somente de leitura às próprias vendas, parcelas, valores pagos, em aberto, calendário e próximo pagamento.

## Correção consolidada — tela preta + auditoria financeira (22/09/2026)
- O módulo de comissões deixou de ser importado de forma estática na inicialização do painel. Ele agora usa `React.lazy` + `Suspense`, então um problema exclusivo de comissões não impede mapa/login/prospecção de abrir.
- Removidas do caminho inicial dependências novas de ícones que não existiam na versão estável anterior do painel.
- Adicionado Error Boundary global: um erro de interface passa a mostrar a mensagem de diagnóstico em vez de deixar somente uma tela escura.
- Formulário de comissão não é mais reinicializado pelo polling enquanto o administrador está digitando.
- Pagamento parcial conserva o mesmo `requestId` mesmo quando o usuário tenta novamente manualmente após uma falha de rede.
- Leituras financeiras via Redis pipeline agora validam erro por comando; erro de leitura nunca mais vira coleção vazia silenciosamente.
- Geração de parcelas nos dias 29/30/31 foi corrigida para respeitar o último dia real do mês.
- Datas financeiras recebem validação de calendário real (ex.: 31/02 é rejeitado).
- Valores aceitam formatos numéricos usuais e formato brasileiro no backend.
- Edição de venda/comissão usa versão otimista: se outra sessão alterar antes, retorna conflito em vez de sobrescrever silenciosamente.
- Exclusão de contato + atualização do índice global de telefone ocorre de forma coordenada; retries também reparam índice órfão.
- Backup cria uma fotografia coerente bloqueando novas gravações por uma janela curta e validando todas as leituras Redis.
- Restauração valida o backup antes de aplicar e mantém snapshot de rollback; se a aplicação falhar, tenta restaurar automaticamente o banco anterior.
- Locks têm renovação enquanto a operação estiver viva, reduzindo risco de expirar no meio de operação pesada.
- Rate limit de vendedor/estado passou a considerar IP + navegador/dispositivo, evitando que um erro de um vendedor no mesmo Wi‑Fi bloqueie todos os demais.
- Histórico de auditoria financeira teve a retenção ampliada para 10.000 eventos, mantendo limite para não recriar risco de OOM.
