# Estado Atual

## 1. Data Plane já existente

O PostgreSQL já recebe dados do Kommo através de workflows n8n.

### Tabelas conhecidas

#### `vne_eventos_crm`
Histórico de eventos operacionais do Kommo.

#### `vne_leads_snapshot`
Estado consolidado/atual de cada lead.

#### `vne_mensagens`
Histórico de mensagens recebidas e enviadas.

#### `vne_chat_map`
Relaciona `talk_id` com lead/contact/chat/origin.

#### `vne_janela_meta`
Mantém contexto temporal da última mensagem do cliente e metadados usados por automações como Higor.

## 2. Workflow — Eventos CRM Kommo

Nome:
`VNE - Eventos CRM Kommo`

Entrada:
POST webhook `kommo-eventos-crm`

Normaliza eventos de:
- lead;
- notes;
- tasks;
- talks.

Eventos identificados:
- lead_created
- lead_updated
- lead_status_changed
- lead_responsible_changed
- lead_deleted
- lead_restored
- lead_note_added
- task_created
- task_updated
- task_completed
- task_responsible_changed
- task_deleted
- talk_added
- talk_updated

Persiste evento em `vne_eventos_crm`.

Mantém `vne_leads_snapshot`.

Possui idempotência baseada em `event_key`.

## 3. Workflow — Histórico de Conversas Kommo

Nome:
`VNE - Histórico de Conversas Kommo`

Entrada:
POST webhook `kommo-historico-mensagens`

Normaliza:
- incoming;
- outgoing;
- texto;
- anexos;
- autor;
- origem;
- timestamps;
- talk/chat IDs.

Outgoing que não possui lead direto tenta:
1. `vne_chat_map`;
2. Kommo talk API.

Persiste:
- `vne_mensagens`
- `vne_chat_map`
- `vne_janela_meta`
- `vne_leads_snapshot`

Classifica outgoing como:
- bot;
- humano;
- empresa.

## 4. Consequência arquitetural

O Control Center não precisa reconstruir captura de CRM/conversas.

Primeiro deve consumir essa infraestrutura como fonte.

## 5. Pontos ainda não inventariados

Antes da fase de integração produtiva, levantar:

- schema real completo das tabelas;
- índices;
- constraints;
- volume de registros;
- retenção;
- timezone;
- versão PostgreSQL;
- provider/host;
- estratégia de backup;
- usuários/roles do banco;
- outros workflows que escrevem nas mesmas tabelas;
- workflows Sophia/Higor/Pós-venda e futuros agentes;
- forma atual de autenticação do Kommo;
- IDs de pipelines/status/tags;
- forma atual de deploy do n8n;
- logs/monitoramento atuais.

Não presumir respostas.
