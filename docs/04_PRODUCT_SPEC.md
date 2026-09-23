# Product Spec

## 1. Command Center

Objetivo:
entender a saúde do ecossistema em segundos.

Cards:
- agentes ativos;
- agentes degradados;
- sessões ativas;
- requests pendentes;
- urgentes;
- tools com erro;
- integrações degradadas;
- incidentes abertos;
- runs últimas 24h.

Listas:
- atividade recente;
- requests mais antigos;
- incidentes críticos;
- agentes com maior erro.

## 2. Agents

Lista:
- nome;
- unidade;
- tipo;
- status;
- modo;
- versão ativa;
- sessões;
- requests pendentes;
- erros recentes.

Ações conforme permissão:
- abrir;
- pausar;
- read-only;
- retomar.

## 3. Agent Detail

Tabs:
- Overview
- Versions
- Sessions
- Runs
- Tools
- Capabilities
- Integrations
- Requests
- Incidents
- Audit

Overview:
- status;
- version;
- model;
- owner;
- current health;
- dependências;
- volume recente.

## 4. Live Operations

Tabela atualizada em realtime:
- horário;
- agent;
- entity;
- session;
- run;
- event;
- status;
- latency;
- link de detalhe.

Filtros:
- agent;
- status;
- event type;
- team;
- business unit.

## 5. Lead 360 / Entity 360

### Cabeçalho
- identificação;
- Kommo lead id;
- pipeline/status;
- responsável;
- agent atual;
- modo IA/humano.

### Conversation
Fonte:
`vne_mensagens`

Exibir:
- direção;
- autor;
- bot/humano;
- timestamp;
- anexos;
- origem.

### CRM Timeline
Fonte:
`vne_eventos_crm`

### Agent Timeline
Fonte:
`acc_agent_events`

### Controls
- pause AI;
- human takeover;
- return to AI;
- change assigned agent;
- create internal request.

### Open Kommo
Link externo quando configurado.

## 6. Human Inbox

Colunas:
- priority;
- age;
- agent;
- request type;
- entity/client;
- team;
- assignee;
- status.

Detalhe:
- contexto;
- pergunta do cliente;
- pergunta do agente;
- conversa recente;
- timeline;
- thread humano-agente;
- assumir;
- transferir;
- responder;
- fechar;
- salvar como conhecimento.

## 7. Knowledge Hub

Busca por:
- texto;
- categoria;
- serviço;
- país;
- unidade;
- status.

Exibir:
- versão atual;
- origem;
- autor;
- aprovador;
- validade;
- agentes autorizados.

## 8. Incident Center

- severity;
- agent;
- integration/tool;
- first seen;
- latest occurrence;
- impacted sessions/entities;
- status.

Actions:
- acknowledge;
- assign;
- resolve;
- link related incidents.

## 9. Integrations

Cada integração:
- status;
- environment;
- last health check;
- agents depending on it;
- recent errors.

Nunca mostrar secrets.

## 10. Audit

Filtros:
- actor;
- action;
- target;
- date;
- agent;
- entity.

Detalhe:
- before;
- after;
- reason;
- correlation id.

## 11. Settings

- Organizations
- Business Units
- Users
- Teams
- Routing
- Policies
- Agent Registry
- Tool Registry
- Integration Registry

## 12. UX principles

- desktop-first, responsivo;
- estado e risco sempre visíveis;
- ações destrutivas com confirmação;
- tela operacional não deve exigir navegar por 5 níveis;
- IDs técnicos secundários;
- contexto humano em primeiro plano;
- filtros persistentes por sessão;
- timeline unificada;
- realtime onde agrega valor;
- sempre mostrar origem do dado.
