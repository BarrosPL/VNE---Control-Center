# Como rodar (desenvolvimento)

```powershell
npm ci
npm run typecheck
npm test                      # unitários: RBAC, senha, tokens, auditoria, guardrails de migrations
npm run test:db               # serviço de auth em Postgres descartável, como role limitado
npm run test:smoke            # ponta a ponta do app (requer build); cria admin de teste
npm run test:all              # tudo acima em sequência
npm run test:migration:db     # integração em Postgres descartável (não usa produção)
npm run build
npm run dev                   # http://127.0.0.1:3000
```

## Migrations

O runner só usa `ACC_MIGRATE_URL`. Sem ela, `preview` lista o que seria aplicado (sem conectar) e
`apply`/`verify`/`down` recusam executar.

```powershell
npm run db:migrate:preview            # planejamento; --sql imprime o SQL completo
npm run db:migrate:apply              # aplica pendentes (destino local por padrão)
npm run db:migrate:verify             # confere tabelas e checksums (somente leitura)
npm run db:migrate:down               # desfaz a última; recusa se houver dados
```

Destino remoto (homologação/produção) exige `--confirm-host=<host>` e **aprovação prévia**
(alteração, risco, rollback, diff) conforme CLAUDE.md §22. Nunca aponte `ACC_MIGRATE_URL` para
produção sem essa aprovação.

## Variáveis (arquivos ignorados pelo git; modelo em `.env.example`)

- `.env.admin`: credenciais administrativas (inventário/migrations). **Não** é carregado pelo Next. Use
  `node --env-file=.env.admin ...`.
- `ACC_MIGRATE_URL`: alvo explícito das migrations/role (defina no comando, nunca em `.env`).
- `.env.local`: `ACC_APP_DATABASE_URL` (role limitado) e `SESSION_SECRET` — usados pela aplicação.

## Role da aplicação

```powershell
npm run db:app-role:preview   # somente leitura: mostra o que seria criado/concedido
npm run db:app-role:apply     # cria acc_app e grava ACC_APP_DATABASE_URL em .env.local
```

Mesmas regras de destino das migrations (`ACC_MIGRATE_URL` + `--confirm-host` para remoto).

## Primeiro administrador

```powershell
npm run db:admin:create -- --email=voce@empresa.com --name="Seu Nome"
```

Gera a senha, grava em `.admin-credentials` (ignorado pelo git) e **não a imprime**. Em destino remoto
exige `--confirm-host=<host>` e aprovação prévia (escrita em banco real).

## Registro de agentes (dados, não código)

```powershell
npm run db:registry:preview   # executa em transação e faz ROLLBACK; mostra o que seria criado/alterado
npm run db:registry:apply     # aplica (idempotente; não sobrescreve estados de controle)
```

Edite `registry/vne.registry.json` para cadastrar/atualizar agentes, tools e integrações. Em destino
remoto exige `--confirm-host=<host>` e aprovação prévia. Dependências de migration:

- Registro **v1** (schema 1): migrations 0003/0004 (a importação grava auditoria).
- Registro **v2** (schema 2: versões com `config_hash`/`source_revision`, estado observado de tools e integrações) **depende da migration 0005**. Sem ela o importador e as telas de agente falham (`column ... observed_state does not exist`).
- Catálogo de integrações (`db:catalog:*`, nomes no Lead 360): migration 0006.
- Telemetria (`/live`, timeline do Lead 360, coletor n8n): migration 0007.

Ordem obrigatória em qualquer ambiente: **migrations → role/grants → registro → código**. O código novo lê colunas novas; nunca suba a aplicação antes das migrations. Catálogo e telemetria degradam com segurança (tabela ausente = "indisponível"), o registro v2 não.

## Demonstracao local (sem tocar em producao)

```powershell
npm run demo    # banco descartavel + todas as migrations + registro + catalogo ficticio + telemetria sintetica; abre em http://127.0.0.1:3000
```

Credenciais fictícias impressas no terminal (valem só nesse banco). Ctrl+C encerra e apaga tudo.

## Inventario, catalogo, telemetria e ensaio

```powershell
npm run inventory:agents          # le workflows do n8n (SOMENTE LEITURA) e gera docs/inventory/agents-<data>.json (hashes, sem prompts)
npm run db:catalog:gaps           # IDs do Kommo observados sem nome no catalogo
npm run db:catalog:preview -- --file=registry/catalogs/kommo.json
npm run db:catalog:apply   -- --file=registry/catalogs/kommo.json
npm run db:synthetic              # telemetria sintetica (recusa qualquer banco que nao seja local)
npm run rehearse:prod             # ENSAIO local: copia (leitura) o registro de producao, aplica migrations e importa o registry
```

## CI

`.github/workflows/ci.yml` roda typecheck, testes unitarios, testes de banco, testes de migrations, build e smoke, sem deploy e sem segredos.
`npm run test:all` executa localmente o mesmo conjunto.

## Privacidade do diretório

Nomes de usuários internos do CRM só aparecem para perfis com a permissão `directory:read` (specialist, manager, admin). O visualizador vê etapas e funis, mas usuários aparecem como "Restrito ao seu perfil" (sem nome e sem ID).
