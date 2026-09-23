# Fase 0 — Inventário técnico (baseline de 23/09/2026)

Consultas somente leitura (transação `READ ONLY`). Nenhuma alteração produtiva. Segredos não
são registrados aqui.

## Ambiente

- PostgreSQL 17.10 no EasyPanel, UTC, ~4 GB, extensões `uuid-ossp`, `pgcrypto`, `vector`,
  `btree_gist`.
- É o **mesmo banco do n8n**: tabelas internas (`workflow_entity`, `execution_entity`,
  `credentials_entity`, `agents`, `agent_*` etc.) convivem em `public` com `vne_*` e tabelas de
  negócio. Schemas: `public`, `arvisx`, `content`, `vne_portal` (portal de nacionalidade, outro app).
- Nenhum objeto `acc_*` nem schema `acc` existia (sem conflito de prefixo).
- Stack do Control Center: a mesma do projeto `app-cidadania-e-vistos-vne` (Next.js 16, React 19,
  TypeScript estrito, Tailwind 4, Zod 4, `pg`, Vitest, npm).

## Tabelas `vne_*` (todas em `public`, sem RLS, sem FKs entre si)

| Tabela | Linhas | Chave / observações |
|---|---:|---|
| `vne_mensagens` | 684 | PK `id`; único parcial `kommo_message_id`; índices por lead, contato, talk |
| `vne_eventos_crm` | 341 | PK `id`; `event_key` único; índice `(lead_id, occurred_at desc)` |
| `vne_leads_snapshot` | 99 | PK `lead_id` |
| `vne_chat_map` | 186 | PK `talk_id` |
| `vne_janela_meta` | 802 | PK `lead_id` |
| `vne_lead_locks` | 623 | único `(lead_id, bucket, agente)` |
| `vne_send_lock` | 47 | lock de envio por workflow/lead; `timestamp` sem zona |
| `vne_recovery_higor` | 10 | máquina de estados com CHECKs e únicos parciais |
| `vne_fallback_cooldown` | 6 | |
| `vne_fallback_processed_messages` | 15 | |

- Os dados começam em **2026-09-21** (≈2 dias) e crescem rápido.
- IDs do Kommo são `int8`. Nas tabelas de lock/fallback há `timestamp` sem zona; tratar ao
  correlacionar.
- `vne_higor_ajusta_horario` é referenciada pelo Dispatcher Recovery Higor mas **não existe**.

## Workflows n8n (348 no total, 13 ativos)

| Workflow | Nodes | 7 dias (erros) | Papel |
|---|---:|---|---|
| Eventos CRM Kommo (`zwGbOPvFlkJ9vO7I`) | 5 | 406 (4) | infra: grava `vne_eventos_crm`, `vne_leads_snapshot` |
| Histórico de Conversas Kommo (`swEkCwoS56t8R7e7`) | 13 | 774 (8) | infra: grava mensagens, chat_map, janela_meta, snapshot |
| Sophia Agente de Atendimentos (`uhnA44V465M38Hhk`) | 60 | 817 (17) | agente; `gpt-4.1-mini`; grava `vne_janela_meta` |
| Agente de Reaquecimento Higor (`5KTLuyhMJRxC6nRv`) | 52 | 722 (33) | agente; `gpt-4.1-mini`; atualiza `vne_recovery_higor` |
| Dispatcher Recovery Higor (`raWoQAC3lhkghb6N`) | 25 | 18 (3) | orquestração; insere/atualiza `vne_recovery_higor` |
| Tool Reservar e Criar Reunião (`vLZwa92qql9MOuUK`) | 14 | 2 (0) | tool (Google Calendar + Kommo) |
| Tool Reagendar Reunião (`P2fajqlxgeKG9QTX`) | 14 | 1 (0) | tool |
| Cancelar Reunião (`JAwcteOmCLTCSr2t`) | 8 | 0 | tool |

Webhooks ativos: `kommo-eventos-crm`, `kommo-historico-mensagens`, `higor`,
`higor-dispatcher-recovery`, `kommo-zapsign`. Existem versões antigas/arquivadas da Sophia
(`_ZOMBIE_…`, "EM ATUALIZAÇÃO"): mapear via `acc_agent_versions.workflow_external_id`.

## Implicações

- Sophia e Higor operam sem `run`/`event` centralizados: instrumentação (Fase 4) exige alterar
  workflows produtivos → somente com aprovação explícita (alteração, risco, rollback, diff).
- `vne_lead_locks`, `vne_send_lock`, `vne_recovery_higor` são estado operacional existente; o
  Control Center deve **ler**, não duplicar.
- Com este volume, a timeline do Lead 360 por consulta/view é suficiente (sem materialização).

## Pendências da Fase 0

- Pipelines/status/tags do Kommo (IDs).
- Tools/integrações declaradas por Sophia e Higor (para cadastro no registry).
- Estratégia de backup, retenção e monitoramento do Postgres/n8n.
- Outros workflows que escrevem em `vne_*` (varredura estática mostrou apenas os listados).

## Estado aplicado em produção (23/09/2026 15:24–15:25 UTC)

- `0001_foundation` e `0002_seed_vne_organization` aplicadas (14 tabelas `acc_*` incl. `acc_migrations`; seed: organização `vne`). `verify` sem problemas.
- Hardening confirmado: `arvisx_app` e o role do portal (`vne_portal_*`) sem qualquer privilégio em `acc_*`; ACL das tabelas = somente `postgres`.
- Role `acc_app` criado (sem superusuário/DDL; SELECT/INSERT/UPDATE em `acc_*`; SELECT em 5 tabelas `vne_*`). Verificado conectando como `acc_app`: acessos permitidos e negados conforme desenho (DELETE, DDL, `acc_migrations`, tabelas do n8n e `vne_portal` negados).
- Contadores `vne_*` continuaram crescendo normalmente após o apply (workflows não afetados).
- Rollback disponível: `npm run db:migrate:down` (x2) e `DROP OWNED BY acc_app; DROP ROLE acc_app;`.

## Estado aplicado em producao (23/09/2026 16:03-16:05 UTC) - auth e auditoria

- Migrations 0003_auth e 0004_audit_log aplicadas (18 tabelas acc_*, verify sem problemas). Hardening confirmado: arvisx_app e o role do portal sem privilegios nas tabelas novas.
- Grants do role acc_app concedidos as tabelas novas (acc_audit_log somente SELECT/INSERT).
- Usuario administrador TEMPORARIO criado (admin@teste.com, papel admin) com o role limitado; senha gerada localmente em .admin-credentials (gitignored), nunca impressa. Auditoria: USER_CREATED. Substituir por administrador real antes de uso efetivo (nao ha ainda troca/reset de senha).
- Registro de agentes ainda NAO importado (preview com rollback: 2 agentes, 14 tools, 5 integracoes, 3 capabilities, 26 vinculos de tools).
- Rollback: npm run db:migrate:down (2x, recusa se houver dados de auditoria/sessoes; usar --force apenas com aprovacao). Desativar o admin temporario: UPDATE acc_users SET status = 'inactive'.

## Registro de agentes importado em producao (23/09/2026 16:07 UTC)

- npm run db:registry:apply (role acc_app, --confirm-host): 5 integracoes, 3 capabilities, 14 tools, 2 agentes (sophia, higor), 2 versoes baseline, 4 capabilities e 26 tools vinculadas, 10 dependencias de integracao. Segunda execucao: nada a criar/alterar (idempotente).
- Auditoria: AGENT_REGISTERED x2, REGISTRY_IMPORTED x1.
- Estados cadastrados refletem a realidade (active/active) mas NAO sao impostos aos workflows (modo informativo ate a Fase 6).
- Avisos de revisao ativos: escalar_passagem_diogo (workflow alvo inativo), mover_para_follow_up (so GET), consultar_agendamentos_postgres (UPDATE no SQL).
- Rollback: sem hard delete pela aplicacao; para desfazer usar o down das migrations (exige --force por haver dados) ou desativar agentes por status (archived).
