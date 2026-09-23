# Initial Backlog

## Sprint 0 — Inventário

### ACC-001
Inspecionar estrutura atual do repositório/projeto.

### ACC-002
Documentar conexão com PostgreSQL sem revelar secrets.

### ACC-003
Extrair schema de:
- vne_mensagens
- vne_eventos_crm
- vne_leads_snapshot
- vne_chat_map
- vne_janela_meta

### ACC-004
Listar índices, PKs, uniques e FKs dessas tabelas.

### ACC-005
Medir volumes:
- rows;
- crescimento;
- range temporal.

### ACC-006
Inventariar workflows n8n que leem/escrevem nessas tabelas.

### ACC-007
Inventariar agentes atuais:
- nome;
- função;
- workflow;
- modelo;
- prompt/version;
- tools;
- integrações;
- owner.

## Sprint 1 — Fundação

### ACC-010
Criar migration inicial `acc_*` da fundação.

### ACC-011
Seed organization VNE.

### ACC-012
Seed business units iniciais somente confirmadas.

### ACC-013
Implementar users/teams/RBAC.

### ACC-014
Implementar Agent Registry.

### ACC-015
Implementar Tool Registry.

### ACC-016
Implementar Integration Registry.

## Sprint 2 — UI read-only

### ACC-020
Shell da aplicação.

### ACC-021
Command Center.

### ACC-022
Agents list.

### ACC-023
Agent detail.

### ACC-024
Integrations.

## Sprint 3 — Lead 360

### ACC-030
API snapshot de lead.

### ACC-031
API mensagens.

### ACC-032
API eventos CRM.

### ACC-033
Timeline unificada.

### ACC-034
Tela Lead 360.

## Sprint 4 — Instrumentação

### ACC-040
agent_sessions.

### ACC-041
agent_runs.

### ACC-042
agent_events.

### ACC-043
SDK/helper interno para registrar execução.

### ACC-044
Instrumentar primeiro agente piloto.

## Sprint 5 — Human-in-the-loop

### ACC-050
agent_requests.

### ACC-051
request messages/thread.

### ACC-052
routing rules.

### ACC-053
Human Inbox.

### ACC-054
Assumir com lock transacional.

### ACC-055
Responder request.

### ACC-056
Retomada do agente.

### ACC-057
Audit completo.

## Critério

Não iniciar Sprint 5 antes de termos:
- autenticação;
- RBAC;
- audit;
- identificação confiável de agent/session/entity.
