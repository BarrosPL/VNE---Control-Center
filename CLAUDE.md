# CLAUDE.md — VNE Agent Control Center

## 1. Missão do projeto

Construir o **VNE Agent Control Center**, uma plataforma central para governar, observar e operar todo o ecossistema de agentes de IA da VNE.

Este NÃO é um painel da Sophia, do Higor ou do Pós-Venda.

Sophia, Higor e qualquer agente atual ou futuro são apenas instâncias cadastradas na plataforma.

A arquitetura deve suportar dezenas de agentes sem exigir criação de módulos, tabelas ou regras específicas para cada um.

---

## 2. Princípios arquiteturais obrigatórios

### 2.1 Agents are data

É PROIBIDO criar estruturas centrais específicas como:

- `sophia_requests`
- `higor_sessions`
- `pos_venda_events`
- `if agent == "Sophia"` espalhado pelo frontend/backend

Use sempre estruturas genéricas:

- `agent_id`
- `agent_version_id`
- `capability_id`
- `tool_id`
- `integration_id`
- `team_id`
- `entity_type`
- `entity_id`

Exceções de comportamento devem vir de configuração, capability, policy ou routing rule.

### 2.2 Separação em planos

A plataforma possui três grandes camadas:

**Data Plane**
- fatos do mundo operacional;
- Kommo;
- mensagens;
- eventos;
- leads;
- tarefas;
- reuniões;
- documentos e demais dados externos.

**Agent Plane**
- agentes;
- versões;
- sessões;
- runs;
- tools;
- capabilities;
- conhecimento;
- políticas;
- decisões.

**Control Plane**
- dashboard;
- governança;
- observabilidade;
- human-in-the-loop;
- takeover;
- pausa;
- incidentes;
- auditoria;
- configuração.

Nunca misturar responsabilidades entre essas camadas sem justificativa.

### 2.3 Source of truth

O PostgreSQL existente é a fonte de verdade operacional atual.

Não migrar dados para outro banco apenas para facilitar frontend ou realtime sem decisão explícita.

O realtime poderá ser implementado sobre a infraestrutura existente via WebSocket, SSE, LISTEN/NOTIFY ou camada dedicada posteriormente.

### 2.4 Namespace

Tabelas existentes da operação VNE permanecem com prefixo `vne_`.

Novas tabelas da plataforma devem usar prefixo:

`acc_`

Exemplos:

- `acc_agents`
- `acc_agent_versions`
- `acc_agent_runs`
- `acc_agent_requests`

Isso mantém separação clara entre dados operacionais atuais e o Control Center.

### 2.5 Não duplicar dados existentes

Não criar cópias paralelas desnecessárias de:

- mensagens do Kommo;
- eventos CRM;
- snapshot atual do lead;
- mapeamento talk → lead;
- janela temporal do cliente.

O Control Center deve ler e correlacionar esses dados.

Crie novos dados apenas quando forem pertencentes à governança/operação dos agentes.

---

## 3. Infraestrutura existente — preservar

Já existem fluxos n8n produtivos que alimentam PostgreSQL.

### 3.1 Histórico de eventos do Kommo

Workflow:
`VNE - Eventos CRM Kommo`

Webhook:
`kommo-eventos-crm`

Eventos já normalizados incluem:

- `lead_created`
- `lead_updated`
- `lead_status_changed`
- `lead_responsible_changed`
- `lead_deleted`
- `lead_restored`
- `lead_note_added`
- `task_created`
- `task_updated`
- `task_completed`
- `task_responsible_changed`
- `task_deleted`
- `talk_added`
- `talk_updated`

Principais tabelas:
- `public.vne_eventos_crm`
- `public.vne_leads_snapshot`

O fluxo já utiliza `event_key` e `ON CONFLICT DO NOTHING` para idempotência.

### 3.2 Histórico de conversas do Kommo

Workflow:
`VNE - Histórico de Conversas Kommo`

Webhook:
`kommo-historico-mensagens`

Já trata:
- mensagens de entrada;
- mensagens de saída;
- anexos;
- autor;
- origem/canal;
- `talk_id`;
- `chat_id`;
- resolução de outgoing por `talk_id`;
- classificação cliente/bot/humano/empresa.

Principais tabelas:
- `public.vne_mensagens`
- `public.vne_chat_map`
- `public.vne_janela_meta`
- `public.vne_leads_snapshot`

### 3.3 Regra de preservação

Não alterar esses workflows ou tabelas durante as primeiras fases do Control Center, salvo necessidade demonstrada e aprovação explícita.

Primeiro construir integrações de leitura/adaptação.

Mudanças futuras devem ser feitas por migration e com compatibilidade retroativa.

---

## 4. Escopo organizacional

A arquitetura deve nascer preparada para:

- VNE;
- outras unidades do ecossistema no futuro.

Não pressupor que todo agente pertence à VNE Comercial.

Estrutura mínima:

`organization -> business_unit -> team -> users/agents`

Exemplos futuros:
- VNE
- Vem de Visto
- PSA
- Nesso
- ARVISX
- Alvance

Não ativar essas empresas agora se não houver necessidade; apenas não bloquear sua inclusão futura.

---

## 5. Entidades centrais obrigatórias

### Organização
- organizations
- business_units

### Pessoas e equipes
- users
- teams
- team_members

### Agentes
- agents
- agent_versions
- capabilities
- agent_capabilities

### Tools
- tools
- agent_tools

### Integrações
- integrations
- agent_integrations

### Operação dos agentes
- agent_sessions
- agent_runs
- agent_events

### Human-in-the-loop
- agent_requests
- agent_request_messages
- agent_assignments

### Roteamento
- routing_rules

### Conhecimento
- knowledge_items
- knowledge_versions
- knowledge_permissions

### Governança
- policies
- audit_log

### Saúde
- incidents
- integration_health

### Controle por entidade
- entity_agent_bindings
- automation_controls

As implementações físicas usarão prefixo `acc_`.

---

## 6. Estados operacionais dos agentes

Todo agente deve possuir estado operacional configurável.

Estados mínimos:

- `active`
- `read_only`
- `paused`
- `degraded`
- `disabled`

`read_only`:
- permite leitura, análise e geração de recomendação;
- bloqueia tools mutáveis.

`paused`:
- bloqueia novas execuções automáticas;
- não apaga histórico;
- não encerra sessões existentes automaticamente sem política explícita.

`degraded`:
- agente pode continuar parcialmente;
- uma ou mais dependências estão indisponíveis.

---

## 7. Controle por entidade

O sistema deve permitir governança no nível de:

- lead;
- contact;
- conversa;
- processo;
- cliente;
- ou outra entidade futura.

Não limitar o mecanismo a `lead_id`.

Use:
- `entity_type`
- `entity_id`

Para integração Kommo, `lead_id` pode existir como atalho/index adicional.

Estados de automação por entidade:

- `ai_active`
- `human_takeover`
- `paused`
- `manual_only`
- `handoff_pending`

Deve ser possível:

- pausar IA somente para um lead;
- assumir atendimento humano;
- devolver para IA;
- trocar agente responsável;
- registrar motivo;
- auditar quem fez.

---

## 8. Sessões, runs e eventos

### agent_sessions

Representa uma relação contínua entre agente e entidade.

Exemplo:
- Sophia atendendo lead X durante uma negociação.

### agent_runs

Cada execução individual do agente.

Registrar sempre que possível:
- agent_id;
- agent_version_id;
- session_id;
- trigger;
- input;
- output;
- status;
- started_at;
- completed_at;
- duration_ms;
- model;
- token usage/cost quando disponível;
- error code/message.

### agent_events

Timeline canônica dos agentes.

Taxonomia inicial:

- `AGENT_STARTED`
- `AGENT_STOPPED`
- `SESSION_STARTED`
- `SESSION_ENDED`
- `MESSAGE_RECEIVED`
- `MESSAGE_SENT`
- `TOOL_CALLED`
- `TOOL_SUCCEEDED`
- `TOOL_FAILED`
- `HUMAN_REQUESTED`
- `HUMAN_ASSIGNED`
- `HUMAN_RESPONDED`
- `HUMAN_TAKEOVER`
- `AI_RESUMED`
- `HANDOFF_REQUESTED`
- `HANDOFF_COMPLETED`
- `POLICY_BLOCKED`
- `AGENT_PAUSED`
- `AGENT_RESUMED`
- `ERROR`
- `INCIDENT_CREATED`

Não usar texto livre como substituto do `event_type`.

Payload específico deve ir em JSONB.

---

## 9. Human-in-the-loop genérico

A plataforma deve possuir uma caixa de solicitações humanas criada por QUALQUER agente.

Nunca criar mecanismo exclusivo de Sophia.

Tipos iniciais:

- `information`
- `price_confirmation`
- `fee_confirmation`
- `legal_review`
- `commercial_exception`
- `discount_approval`
- `document_review`
- `decision`
- `handoff`
- `incident`
- `other`

Estados:

- `pending`
- `assigned`
- `in_review`
- `answered`
- `resumed`
- `closed`
- `cancelled`
- `expired`

Prioridades:
- `low`
- `normal`
- `high`
- `urgent`

Solicitações devem suportar THREAD de mensagens entre humano e agente via `acc_agent_request_messages`.

Não limitar a uma única `human_response`.

---

## 10. Lock / assumir solicitação

Uma solicitação pode ser visível a uma equipe inteira.

Ao clicar `Assumir`:

- realizar lock transacional;
- definir usuário responsável;
- registrar `assigned_at`;
- criar audit log;
- impedir dois responsáveis simultâneos.

A UI deve mostrar quem está analisando.

Deve existir mecanismo de:
- liberar;
- transferir;
- escalar;
- expirar lock quando política permitir.

---

## 11. Roteamento

Nunca hardcodar:

`Sophia -> Renan`

Usar `acc_routing_rules`.

Uma regra pode considerar:

- organization;
- business_unit;
- agent;
- request_type;
- category;
- country;
- service;
- priority;
- capability;
- tags/context.

Destino:
- team;
- user;
- fallback team;
- fallback user.

Suportar SLA/escalation futuramente.

---

## 12. Knowledge Hub

Conhecimento não deve viver apenas dentro de prompts.

Criar conhecimento governado:

- `acc_knowledge_items`
- `acc_knowledge_versions`
- `acc_knowledge_permissions`

Cada item precisa de:
- escopo;
- categoria;
- conteúdo;
- status;
- versão;
- autor;
- aprovador;
- validade;
- timestamps;
- origem.

Status mínimos:
- `draft`
- `active`
- `deprecated`
- `archived`

Uma resposta humana NÃO vira automaticamente conhecimento oficial.

A UI pode oferecer:
`Salvar como conhecimento`

Mas deve respeitar aprovação/permissão.

---

## 13. Tools e capabilities

Tool ≠ capability.

### Tool
Operação concreta:
- consultar agenda;
- alterar CRM;
- gerar contrato;
- buscar documento.

### Capability
Competência lógica:
- qualificar lead;
- negociar;
- calcular proposta;
- agendar reunião;
- analisar documento.

Manter:
- `acc_tools`
- `acc_agent_tools`
- `acc_capabilities`
- `acc_agent_capabilities`

Permissões de tools devem permitir:
- enabled;
- read_only;
- approval_required;
- disabled.

---

## 14. Integrações e dependências

Catálogo central:

- Kommo
- PostgreSQL
- n8n
- OpenAI
- Google Calendar
- Google Drive
- Gmail
- ZapSign
- futuras integrações

Cada agente declara suas dependências através de `acc_agent_integrations`.

Se integração crítica falhar:
- criar/atualizar `integration_health`;
- marcar agentes impactados;
- permitir `degraded`;
- criar incidente quando apropriado.

---

## 15. Incident Center

Criar mecanismo genérico de incidentes.

Tipos iniciais:
- `tool_error`
- `integration_error`
- `agent_error`
- `data_consistency`
- `policy_violation`
- `workflow_failure`
- `unknown`

Severidade:
- `info`
- `warning`
- `high`
- `critical`

Um incidente deve poder apontar para:
- agent;
- version;
- run;
- session;
- tool;
- integration;
- entity;
- n8n workflow/execution.

Nunca apagar incidente histórico; encerrar/resolver mantendo auditoria.

---

## 16. Auditoria

Toda ação sensível deve gerar `acc_audit_log`.

Incluir:
- actor_type (`human`, `agent`, `system`);
- actor_id;
- action;
- target_type;
- target_id;
- before;
- after;
- reason;
- timestamp;
- correlation_id.

Auditar no mínimo:
- mudança de versão;
- alteração de status do agente;
- mudança de tool permission;
- takeover humano;
- devolução para IA;
- resposta humana;
- alteração de routing;
- alteração de conhecimento;
- alteração de políticas;
- ações administrativas.

---

## 17. Frontend — módulos obrigatórios

### Command Center
Visão global:
- agentes online/pausados/degradados;
- sessões;
- solicitações humanas;
- erros;
- incidentes;
- integrações.

### Agents
Lista de todos os agentes.

### Agent Detail
- estado;
- versão ativa;
- modelo;
- workflows;
- capabilities;
- tools;
- integrações;
- sessões;
- erros;
- histórico de versões.

### Live Operations
- sessões ativas;
- últimas execuções;
- atividades em tempo real.

### Entity 360
Inicialmente Lead 360:
- snapshot;
- mensagens;
- eventos CRM;
- timeline de agentes;
- solicitações internas;
- responsável;
- controle IA/humano.

### Human Inbox
- solicitações;
- filtros;
- assumir;
- responder;
- thread;
- escalonar.

### Knowledge Hub
- busca;
- versão;
- aprovação;
- permissões;
- histórico.

### Incident Center
- incidentes;
- impacto;
- origem;
- agente/integration afetado;
- resolução.

### Integrations
- estado;
- última checagem;
- dependências.

### Audit
- trilha completa de ações.

### Settings
- organizations;
- business units;
- teams;
- users;
- routing;
- policies.

---

## 18. Lead 360 — fonte de dados

O Lead 360 deve CORRELACIONAR, não duplicar:

- `vne_leads_snapshot`
- `vne_mensagens`
- `vne_eventos_crm`
- `vne_chat_map`
- `vne_janela_meta`
- dados `acc_*`

A timeline unificada deve ser montada por consulta/view/API.

Não criar uma nova tabela de timeline duplicando tudo, salvo decisão posterior por performance/materialized view.

---

## 19. Segurança e RBAC

Perfis iniciais:

- `admin`
- `manager`
- `specialist`
- `viewer`

Não confiar apenas no frontend.

Autorização deve existir no backend.

Permissões devem poder restringir:
- business unit;
- team;
- agente;
- tipo de solicitação;
- conhecimento;
- ações operacionais.

Dados sensíveis devem respeitar princípio de menor privilégio.

---

## 20. Regras para banco de dados

1. Nunca executar alteração destrutiva em produção sem aprovação explícita.
2. Toda mudança de schema deve estar em migration versionada.
3. Preferir UUID para IDs internos `acc_*`.
4. Preservar IDs externos como colunas separadas (`kommo_lead_id`, etc.).
5. Usar `created_at`, `updated_at`.
6. Tabelas auditáveis não devem depender de hard delete.
7. JSONB somente para payload variável; campos usados para filtro/relacionamento devem ser colunas.
8. Criar índices baseados em consultas reais.
9. Foreign keys sempre que o acoplamento for interno e confiável.
10. Integrações externas devem tolerar ausência/atraso de dados.
11. Idempotência para webhooks/eventos.
12. Correlation IDs em fluxos distribuídos.

---

## 21. Regras para código

- TypeScript preferencialmente.
- Tipagem estrita.
- Sem `any` desnecessário.
- Separar domínio, infraestrutura e UI.
- Não colocar regras críticas apenas no frontend.
- Não duplicar regra de negócio em múltiplos lugares.
- Adapters para Kommo/n8n/Postgres.
- Serviços de domínio testáveis sem chamadas externas.
- Validar payloads nas bordas.
- Logs estruturados.
- Erros com códigos estáveis.
- Datas armazenadas em UTC; UI formata conforme timezone aplicável.
- IDs externos nunca tratados como IDs internos.

---

## 22. Regras de execução para Claude

### Pode executar autonomamente
- scaffolding local;
- componentes;
- tipos;
- testes;
- migrations novas não destrutivas;
- queries de leitura;
- documentação;
- mocks;
- adapters;
- implementação em branch/dev.

### Deve parar antes de
- alterar/destruir tabela produtiva existente;
- modificar workflow n8n produtivo existente;
- apagar dados;
- trocar credenciais;
- alterar integrações em produção;
- executar migration destrutiva;
- trocar versão de agente em produção;
- habilitar ação que fale com cliente real;
- criar automação que possa disparar mensagens reais em massa.

Quando precisar parar, apresentar:
1. alteração;
2. risco;
3. rollback;
4. comando/diff proposto.

---

## 23. Processo de trabalho

Antes de implementar qualquer módulo:

1. ler `CLAUDE.md`;
2. ler documentos relevantes em `/docs`;
3. inspecionar código existente;
4. identificar impacto;
5. não presumir schema;
6. escrever plano curto;
7. implementar;
8. testar;
9. atualizar documentação afetada;
10. registrar decisões arquiteturais relevantes.

Não refatorar áreas não relacionadas sem necessidade.

---

## 24. Definition of Done

Uma tarefa só está concluída quando:

- compila;
- testes relevantes passam;
- erro/empty/loading states existem;
- autorização foi considerada;
- auditoria foi considerada;
- migration é reversível quando aplicável;
- não introduz hardcode específico de agente;
- documentação foi atualizada;
- não quebra dados atuais;
- não depende de segredo commitado.

---

## 25. Prioridade atual

A prioridade NÃO é construir automações avançadas.

Primeiro:

1. inventariar ambiente;
2. fundação de dados `acc_*`;
3. autenticação/RBAC;
4. dashboard read-only;
5. Agent Registry;
6. Lead 360;
7. Human-in-the-loop;
8. controles operacionais;
9. observabilidade;
10. Knowledge Hub;
11. analytics.

---

## 26. Decisão final de arquitetura

**Sophia, Higor e agentes futuros não são a arquitetura. Eles são entidades operadas pela arquitetura.**

Toda decisão de implementação deve ser confrontada com essa frase.
