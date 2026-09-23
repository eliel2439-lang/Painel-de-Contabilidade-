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
Atualização 2026-09-22
- Portal de comissões do vendedor deixado mais completo e visualmente mais claro.
- Novos blocos: comparação mês atual vs mês passado, previsão de recebimentos 7/15/30/60/90 dias, calendário de vendas, calendário de recebimentos, relatório dos últimos 6 meses e lista detalhada de clientes/vendas.
Atualização mobile 2026-09-22
- Portal do vendedor otimizado para celular.
- Prioridade no topo para: tenho a receber, comissão do mês, já recebi no mês e vendido no mês.
- Seções recolhíveis para evitar página longa/confusa no celular: previsão, comparativo, calendários, clientes e últimos 6 meses.
- Cards de clientes reorganizados em formato mobile.
