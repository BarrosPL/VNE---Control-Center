# Arquitetura-Alvo

## 1. Visão

```
External Systems
  Kommo / Calendar / Drive / Gmail / ZapSign / etc.
                 |
                 v
            DATA PLANE
  vne_mensagens / vne_eventos_crm /
  vne_leads_snapshot / other sources
                 |
                 v
            AGENT PLANE
  agents -> versions -> sessions -> runs
      |         |          |        |
  capabilities tools    events   requests
                 |
                 v
           CONTROL PLANE
 Dashboard / Lead 360 / HITL / Incidents /
 Knowledge / Routing / Audit / Integrations
```

## 2. Fronteiras

### Data Plane
Fatos externos e operacionais.

### Agent Plane
Execução e estado dos agentes.

### Control Plane
Governança e intervenção.

## 3. Integração com n8n

n8n continua como orquestrador importante.

O Control Center não deve tentar substituir workflows n8n no MVP.

O backend deve receber eventos de n8n e oferecer endpoints/commands para:
- registrar runs;
- registrar tool calls;
- abrir requests;
- consultar controle de automação;
- registrar resultados;
- emitir comandos de pause/resume/handoff quando integrado.

## 4. Correlação

Todos os fluxos novos devem propagar quando possível:

- `correlation_id`
- `agent_id`
- `agent_version_id`
- `session_id`
- `run_id`
- `entity_type`
- `entity_id`
- `lead_id` quando aplicável.

## 5. Eventual consistency

Kommo, n8n, PostgreSQL e agentes não formam uma transação única.

A arquitetura deve aceitar consistência eventual.

Por isso:
- idempotência;
- timestamps;
- correlation IDs;
- retry policy;
- estados intermediários;
- auditoria.

## 6. Control modes

Global:
- active
- read_only
- paused

Per agent:
- active
- read_only
- paused
- degraded
- disabled

Per entity:
- ai_active
- human_takeover
- paused
- manual_only
- handoff_pending

A regra mais restritiva aplicável prevalece.

## 7. Realtime

Requisitos:
- novas solicitações humanas devem aparecer sem refresh manual;
- incidentes críticos devem aparecer rapidamente;
- sessões devem atualizar atividade.

Não escolher tecnologia antes de inventariar hosting atual.

Opções:
- WebSocket;
- SSE;
- PostgreSQL LISTEN/NOTIFY;
- Redis pub/sub;
- serviço gerenciado.

## 8. Escalabilidade

Evitar:
- polling agressivo;
- queries N+1;
- timeline montada com dezenas de requests;
- blobs enormes por run;
- JSONB como substituto de schema.

Preparar paginação e filtros desde o início.
