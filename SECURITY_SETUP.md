# Configuração de segurança

Esta versão não contém senhas reais no HTML, JavaScript do navegador ou código-fonte do backend.

## Variáveis obrigatórias no servidor

Configure na hospedagem:

- `ADMIN_PASSWORD`: senha do Acesso 1, mínimo 8 caracteres.
- `SELLER_PASSWORD`: senha geral do Acesso 2, mínimo 8 caracteres.
- `SESSION_SECRET`: segredo aleatório com pelo menos 32 caracteres. Não reutilize nenhuma senha de usuário.
- `REDIS_URL`: conexão já utilizada pelo painel.

Na Vercel: Project Settings > Environment Variables. Cadastre as variáveis para Production (e Preview, se usar) e faça um novo deploy.

## Senhas por estado

As senhas dos estados passam a ser armazenadas como hash + salt. O navegador recebe apenas `true/false` informando se há senha configurada. O administrador pode substituir uma senha, mas não consegue visualizar a senha antiga.

Estados sem senha configurada ficam bloqueados até o administrador definir uma senha com pelo menos 8 caracteres.

## Rotação recomendada

Como versões antigas continham credenciais fixas no código, trate essas credenciais antigas como expostas: escolha novas senhas para Acesso 1 e Acesso 2 e gere um novo `SESSION_SECRET`.
