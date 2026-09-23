# Contrato de telemetria de agentes (schema_version 1)

Status: **implementado e testado localmente; nenhum produtor conectado em produção.**
Código: `src/domain/telemetry.ts` (contrato), `src/server/telemetry/ingest.ts` (ingestão),
`src/server/telemetry/n8n-collector.ts` (coletor somente-leitura), migration `0007_agent_telemetry`.

## 1. Princípios

- **Agnóstico de agente.** O agente é um `slug` cadastrado (dado). Nada no contrato, no schema ou no serviço conhece um agente específico.
- **Entidade genérica.** `entity = { type, id, lead_id? }`. `lead_id` é só atalho indexado quando a entidade é um lead do Kommo; IDs externos nunca são chaves internas.
- **Sem PII e sem segredos.** Mensagens são referenciadas por id (`payload.message_ref` → `vne_mensagens.id`), nunca copiadas. O contrato rejeita chaves como `text`, `content`, `prompt`, `email`, `token`… em qualquer nível de `payload`/`metadata`; payload ≤ 8 KB; resumos ≤ 2000 caracteres. O banco repete os limites (CHECK).
- **Idempotência.** `run.key` (ex.: id da execução no n8n) é único por agente; cada evento tem `event_key` (informado ou derivado de forma determinística) único por `source`. Reenviar o mesmo envelope não duplica nada.
- **Append-only.** `acc_agent_events` rejeita UPDATE/DELETE/TRUNCATE (trigger, vale até para o dono). Runs têm estado terminal final.
- **Versão imutável.** A primeira sessão/run/evento que referencia uma versão de agente a **sela** (migration 0005); depois disso a configuração daquela versão não é reescrita.

## 2. Envelope

```jsonc
{
  "schema_version": 1,
  "organization": "vne",                 // slug da organização
  "source": "n8n",                       // quem produziu (n8n, synthetic, ...)
  "agent": "<slug do agente>",           // dado cadastrado em acc_agents
  "version": {                           // como resolver agent_version_id (uma das formas)
    "config_hash": "<sha256>",           //   preferida
    "workflow_version_id": "<n8n>",      //   casa com source_revision (…#<versionId>)
    "workflow_external_id": "<id n8n>"   //   versão de produção ativa desse workflow
  },
  "correlation_id": "n8n:12345",
  "entity": { "type": "lead", "id": "1001", "lead_id": 1001 },   // opcional
  "session": { "start": true },          // opcional; exige entity
  "run": {
    "key": "n8n:12345", "trigger_type": "webhook", "started_at": "2026-09-23T15:00:00Z",
    "completed_at": "…", "status": "succeeded|failed|cancelled|timed_out|running",
    "model_provider": "openai", "model_name": "…",
    "usage": { "input_tokens": 0, "output_tokens": 0, "estimated_cost": 0 },
    "error": { "code": "…", "message": "…" },       // só em failed/timed_out
    "input_summary": "…", "output_summary": "…", "metadata": {}
  },
  "events": [
    { "type": "TOOL_CALLED", "occurred_at": "…", "tool": { "code": "consultar_agenda" },
      "integration": "google_calendar", "key": "opcional", "payload": { "message_ref": 77 } }
  ]
}
```

O serviço **deriva** `RUN_STARTED` e `RUN_SUCCEEDED`/`RUN_FAILED` a partir da run (o produtor não precisa enviá-los).
Cancelamento vira `RUN_FAILED` com `level=warn` e `payload.status="cancelled"`.

## 3. Taxonomia inicial (tabela `acc_event_types`, estendida por INSERT em migration)

`MESSAGE_RECEIVED`, `RUN_STARTED`, `TOOL_CALLED`, `TOOL_SUCCEEDED`, `TOOL_FAILED`, `MESSAGE_SENT`,
`HUMAN_REQUESTED`, `RUN_SUCCEEDED`, `RUN_FAILED`, `ERROR`. Eventos `TOOL_*` exigem `tool.code`
(o nome observado é gravado mesmo que a tool não esteja cadastrada; `tool_id` só é preenchido quando existe no registry).
Os demais tipos do CLAUDE.md (`AGENT_PAUSED`, `HUMAN_TAKEOVER`, …) entram por migration quando suas fases chegarem.

## 4. O que é observável HOJE sem alterar nenhum workflow (medido em 23/09/2026)

| Fato | Fonte | Observável? |
|---|---|---|
| Início, fim, status e modo de cada execução do workflow do agente | `execution_entity` (`id`, `workflowId`, `status`, `mode`, `startedAt`, `stoppedAt`) | **Sim** (≈1.563 execuções/7 dias nos 2 agentes) |
| **Qual versão do workflow** rodou | `execution_entity."workflowVersionId"` → `source_revision` do registry | **Sim** (versões antigas ficam “não resolvidas”, sinalizadas) |
| Erros como código de status (`error`, `crashed`, `canceled`) | `execution_entity.status` | Sim (sem mensagem) |
| Lead/entidade da execução, gatilho detalhado, mensagem de erro | `execution_data` (payload; contém conteúdo de mensagens/PII) | **Não** — o coletor nunca lê `execution_data` |
| Chamadas de **tool** (`TOOL_*`) | — | **Não por metadados.** `tracingContext` é sempre nulo (0 de 1.563): não há vínculo execução-do-agente ↔ execução-da-tool. Tools de sub-workflow rodam raramente (3 execuções/7 dias) e as tools inline (HTTP, Postgres, Calendar) não têm execução própria |
| `MESSAGE_RECEIVED`/`MESSAGE_SENT` | `vne_mensagens` (já correlacionável por lead/tempo, não por run) | Parcial: só por correlação temporal, não confiável como prova de autoria |
| `HUMAN_REQUESTED` | — | Não (depende da Fase 5) |

Consequência: nesta fase o coletor gera **runs + RUN_STARTED/RUN_SUCCEEDED/RUN_FAILED** por versão. Tool calls e autoria de mensagens
exigem instrumentação (níveis abaixo) e **não são assumidos**.

## 5. Níveis de instrumentação (cada um exige aprovação própria; nenhum foi aplicado)

- **Nível A — coleta somente-leitura (proposto para a Fase 4B).** Job lê `execution_entity` por um role dedicado com `SELECT` **por coluna**
  (`id, "workflowId", status, mode, "startedAt", "stoppedAt", "workflowVersionId", "deletedAt"`), nunca `execution_data`. Não altera n8n.
- **Nível B — emissão explícita no fim/início do workflow do agente.** Um node HTTP (ou sub-workflow reutilizável) chama a ingestão
  com `entity`, `message_ref`, tokens e resumo. Altera o workflow do agente (aprovação com diff/risco/rollback).
- **Nível C — eventos por tool.** Exige envolver cada tool (toolWorkflow: node de emissão no sub-workflow; inline HTTP/Postgres/Calendar: reestruturar
  para sub-workflow ou parsear `runData`). Só depois de B e com decisão explícita por tool. Tools mutáveis de risco alto primeiro.

## 6. Endpoint de ingestão (desenho, não implementado)

`POST /api/ingest/telemetry` com `Authorization: Bearer <service token>`; corpo = envelope. Requer tabela de tokens de serviço
(hash, escopo por agente/source, expiração, revogação, auditoria) e limite de taxa. Só é necessário a partir do Nível B; o Nível A não usa HTTP.

## 7. Retenção e volume

Volume esperado hoje: ~1.600 runs/semana e ~4–8 eventos/run ⇒ dezenas de milhares de linhas/mês. Eventos são append-only (o role da aplicação não apaga).
Retenção futura: particionar `acc_agent_events` por mês e descartar partições antigas por rotina administrativa. Reavaliar quando passar de ~10 M de linhas.
