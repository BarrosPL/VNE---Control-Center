# Roadmap

## Fase 0 — Inventário e baseline

Objetivo:
conhecer o ambiente antes de construir.

Entregas:
- schema completo das tabelas `vne_*`;
- mapa dos workflows;
- mapa de integrações;
- mapa dos agentes existentes;
- mapa de pipelines/status/tags;
- volume de dados;
- riscos.

Nenhuma alteração produtiva.

## Fase 1 — Fundação

Criar:
- acc_organizations
- acc_business_units
- acc_users
- acc_teams
- acc_team_members
- acc_agents
- acc_agent_versions
- acc_capabilities
- acc_agent_capabilities
- acc_tools
- acc_agent_tools
- acc_integrations
- acc_agent_integrations

Criar autenticação e RBAC básico.

## Fase 2 — Control Center read-only

Construir:
- layout;
- Command Center;
- Agents;
- Agent Detail;
- Integrations.

Inicialmente pode usar dados seed para agents + dados reais `vne_*` somente em leitura.

## Fase 3 — Lead 360

Integrar:
- vne_leads_snapshot
- vne_mensagens
- vne_eventos_crm
- vne_chat_map
- vne_janela_meta

Criar timeline unificada em consulta/view/API.

## Fase 4 — Observabilidade de agentes

Criar:
- agent_sessions
- agent_runs
- agent_events

Instrumentar um agente piloto antes de todos.

## Fase 5 — Human-in-the-loop

Criar:
- agent_requests
- agent_request_messages
- agent_assignments
- routing_rules

Fluxos:
- abrir request;
- assumir;
- thread;
- responder;
- retomar agente;
- fechar;
- audit.

## Fase 6 — Controle operacional

Criar:
- entity_agent_bindings
- automation_controls

Features:
- pause global;
- pause agent;
- read-only;
- pause entity;
- human takeover;
- return to AI.

## Fase 7 — Knowledge Hub

Criar:
- knowledge_items
- knowledge_versions
- knowledge_permissions

Conectar primeiro em leitura.

## Fase 8 — Incidents & Health

Criar:
- incidents
- integration_health

Health checks e alertas.

## Fase 9 — Analytics

Métricas:
- volume;
- latency;
- tool errors;
- human escalation;
- SLA;
- takeover;
- conversão quando disponível;
- custos de modelo.

## Fase 10 — Multi-business-unit

Expandir configuração para outras unidades do ecossistema sem alterar núcleo.
