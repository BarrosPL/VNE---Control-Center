# Decisões arquiteturais (ADR curto)

## D-001 — Stack (23/09/2026)
Mesma do `app-cidadania-e-vistos-vne`: Next.js 16, React 19, TypeScript estrito, Tailwind 4, Zod 4,
`pg` sem ORM, Vitest, npm. Migrations em SQL puro com par `up`/`down`.

## D-002 — Namespace e schema
Tabelas `acc_*` no schema `public` (CLAUDE.md §2.4), no mesmo Postgres do n8n. Nomes com
prefixo evitam colisão com `public.agents`/`agent_*` do n8n. A aplicação usará um **role limitado**
(sem superusuário) criado em etapa própria, com aprovação.

## D-003 — Migrations
- Runner próprio (`scripts/migrate.mjs`), lê **apenas** `ACC_MIGRATE_URL`; nunca `DATABASE_URL`.
- Destino remoto exige `--confirm-host=<host>` idêntico ao host da URL.
- `apply` em transação por migration, advisory lock, checksum anti-drift (`acc_migrations`).
- `down` desfaz só a última migration e recusa se as tabelas tiverem linhas (`--force` explícito).
  Migrations de seed marcam `-- @allow-data` no `.down.sql`.
- `up` é somente aditivo (testado estaticamente: sem DROP/TRUNCATE/DELETE/ALTER TABLE).

## D-004 — Integridade
- FKs `RESTRICT` (sem cascade → sem hard delete de dados auditáveis).
- Business unit deve pertencer à mesma organização (FK composta) em `acc_teams` e `acc_agents`.
- No máximo uma versão `active` por agente e ambiente (índice único parcial).
- Defaults seguros: agente nasce `draft`/`paused`; tool nasce `disabled` para o agente.
- `entity_id` (fases futuras) será `text`, com `lead_id bigint` como atalho indexado, pois IDs do
  Kommo são `int8` e a entidade pode não ser lead.

## D-005 — Conjuntos fechados
Enums como `CHECK` (não `ENUM` do Postgres, para evolução por migration simples):
`operational_mode`, `permission_mode`, `role`, `status`, `risk_level`, `mutation_level`,
`environment`. Valores de `operational_mode`, `permission_mode` e `role` seguem o CLAUDE.md;
os demais são escolhas desta fase e podem ser estendidos por migration.

## D-006 — Teste de migrations
`npm run test:migration:db` sobe um Postgres real descartável (`embedded-postgres`, porta livre,
127.0.0.1), aplica up/down, valida constraints e prova que tabelas `vne_*` não são tocadas.

## D-007 — Hardening de privilégios (achado em 23/09/2026)
O banco de produção tem *default privileges* globais: tabelas criadas pelo `postgres` concedem
`arwd` ao role `arvisx_app` (outro app, já com acesso a 91 tabelas de `public`). Sem correção,
as tabelas `acc_*` (usuários, auditoria, requests) nasceriam acessíveis a esse role. O runner
executa `hardenTables` após cada migration (e na tabela `acc_migrations`), revogando todo grant
de não-donos nas tabelas criadas. Coberto por teste que reproduz o cenário.

## D-008 — Role limitado da aplicação
`scripts/setup-app-role.mjs` (preview/apply, mesmo guard de host): role `acc_app` sem
superusuário/DDL, `statement_timeout=15s`, SELECT/INSERT/UPDATE em `acc_*` (sem DELETE e sem
`acc_migrations`) e SELECT apenas em `vne_leads_snapshot`, `vne_mensagens`, `vne_eventos_crm`,
`vne_chat_map`, `vne_janela_meta`. Sem acesso a tabelas do n8n. Senha gerada localmente, gravada
em `.env.local` (ignorado pelo git) e nunca impressa. Reexecutar após cada migration que crie
tabelas para conceder as novas.

## D-009 — Autenticação e sessões (23/09/2026)
- Login por e-mail + senha (scrypt N=2^15, salt por senha, parâmetros no hash). Sem terceiros.
- Sessão opaca de 256 bits em cookie `acc_session` (httpOnly, SameSite=Lax, Secure em produção);
  só o sha256 do token é persistido (`acc_sessions`). Expira em 12h (absoluto) e 2h de inatividade;
  revogável por sessão ou por usuário; usuário inativo invalida sessões imediatamente.
- Rate limit por e-mail (hash) em `acc_login_attempts`: 5 falhas em 15 min bloqueiam, mesmo com senha
  correta; login bem-sucedido zera. Mensagens genéricas (sem enumeração de usuários) e verificação
  de hash "dummy" quando o e-mail não existe.
- `login`, `logout`, `revokeAllSessions` e `createUserWithPassword` gravam sessão e auditoria no
  MESMO statement (CTE): ou os dois existem ou nenhum.
- Pendências conscientes: troca/reset de senha, MFA, limpeza periódica de `acc_login_attempts`/sessões
  expiradas (o role da aplicação não tem DELETE; usar job administrativo), rate limit por IP na borda.

## D-010 — Autorização em camadas
- `proxy.ts` é só otimização (redireciona quando não há cookie). A verdade está no Data Access Layer
  (`src/server/guards.ts`): `requireUser` valida a sessão no banco em cada página; `requirePermission`
  aplica RBAC (`src/domain/rbac.ts`, fail-closed) e deve ser chamado por toda Server Action/Route Handler.
- Papéis: viewer < specialist < manager < admin (hierarquia monotônica testada). Restrições por
  business unit / team / agente (CLAUDE.md §19) ficam para quando houver telas de dados por escopo.

## D-011 — Auditoria append-only
`acc_audit_log` rejeita UPDATE/DELETE/TRUNCATE por trigger (até para o dono); o role da aplicação só
tem SELECT/INSERT. `sanitizeForAudit` redige chaves com aparência de segredo antes de gravar. O rollback
da migration recusa se houver linhas (proteção da trilha).

## D-012 — Segredos administrativos fora do ambiente da aplicação
Credenciais de superusuário ficam em `.env.admin` (gitignored, nunca carregado pelo Next). `.env.local`
contém apenas `ACC_APP_DATABASE_URL` (role limitado) e `SESSION_SECRET`.

## D-013 — Registro declarativo de agentes (Fase 2, 23/09/2026)
- `registry/vne.registry.json` descreve integrações, capabilities, tools e agentes **como dados**
  (validado por `src/domain/registry.ts`: sem duplicados, sem referências inexistentes, sem chaves com
  aparência de segredo, agente deve declarar as integrações que suas tools usam).
- `importRegistry` é idempotente e **não sobrescreve estados de controle** (`agent.status`,
  `operational_mode`, `version.status`, `agent_tools.permission_mode`, `integration.status`): esses
  pertencem ao Control Center. Nunca remove nada (itens ausentes viram "órfãos" no relatório).
  Grava auditoria (`AGENT_REGISTERED`, `REGISTRY_IMPORTED`) na mesma transação.
- Conteúdo inicial derivado do inventário (workflows n8n em leitura). Capabilities são inferidas e
  marcadas "revisar com o responsável". Avisos gerados: tool `escalar_passagem_diogo` aponta para
  workflow inativo; `mover_para_follow_up` só faz GET (nome sugere mutação); `consultar_agendamentos_postgres`
  tem UPDATE no SQL (tratada como mutável).

## D-014 — UI de leitura: honestidade dos dados
- Métricas cuja fonte ainda não existe (sessões, requests, incidentes, runs) aparecem como
  "Indisponível" com a fase prevista — nunca como zero. Integrações mostram "Não monitorada".
- Banner permanente "Modo informativo": estados exibidos refletem o cadastro; ainda não são impostos
  aos workflows (Fase 6).
- Sem `loading.tsx` no grupo autenticado: com ele o Next envia 200 antes de `notFound()`. As páginas fazem
  poucas consultas; o status HTTP correto (404) foi priorizado.
- Cartão "dados operacionais" lê `vne_*` (somente leitura, timeout 15 s). Os `count` de 24h hoje varrem a
  tabela (volume baixo); criar índice em `created_at_kommo`/`received_at` exigiria alterar tabelas `vne_*`
  (requer aprovação) — reavaliar quando o volume crescer.

## D-015 - Lead 360 (Fase 3, 23/09/2026)
- Correlaciona vne_leads_snapshot, vne_mensagens, vne_eventos_crm, vne_chat_map e vne_janela_meta por consulta (UNION ALL ordenado por tempo, limitado e sempre delimitado por lead_id, usando os indices existentes). Nada e copiado nem materializado. Sem escrita em tabelas vne_*.
- Menor privilegio para dados pessoais: nova permissao conversations:read (specialist, manager, admin). Sem ela, o texto das mensagens, nomes de anexos e texto de tarefas NAO saem do banco (filtrados no proprio SQL); o viewer ve quem, quando e por qual canal. O payload bruto dos eventos nunca e selecionado.
- Auditoria: exibir conteudo de conversa grava ENTITY_VIEWED (deduplicado por usuario+lead em 10 min).
- Vinculo com agentes por dado: vne_janela_meta.ultimo_workflow e comparado ao slug em acc_agents (sem nomes de agente no codigo). Valores sem agente cadastrado (ex.: um workflow de captura) aparecem como "nao cadastrado".
- Campos vne_mensagens.workflow_origem e delivery_status sao sempre nulos hoje: nao usados. autor_classificacao (cliente/bot/humano) e a fonte confiavel do tipo de autor.
- A lista parte do snapshot (100 leads hoje); um lead so com mensagens abre por ID direto. 64% dos leads ainda nao tem pipeline/etapa (mostrados como "-", sem inventar). Nomes de pipeline/etapa/responsavel seguem pendentes do mapeamento do Kommo (pendencia da Fase 0): a tela mostra IDs.
- Janela de 24h: derivada da ultima mensagem do cliente (regra do WhatsApp); rotulada como derivado.
- Controle IA/humano, timeline dos agentes e requests internos aparecem como "Indisponivel" ate as Fases 4-6.
- Desempenho medido em producao: lista 285 ms; cabecalho 98 ms; timeline de 44 itens 52 ms.
- Bugs encontrados por teste durante o desenvolvimento: alias de colunas na UNION (visao so-eventos) e normalizacao de limite negativo; ambos com cobertura.
