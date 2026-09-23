# Modelo de Dados Conceitual

Prefixo físico recomendado: `acc_`.

Este documento define intenção. O DDL deve ser criado em migrations após inventário do banco atual.

## 1. Organização

### acc_organizations
- id
- slug
- name
- status
- metadata
- created_at
- updated_at

### acc_business_units
- id
- organization_id
- slug
- name
- status
- metadata
- created_at
- updated_at

## 2. Pessoas e equipes

### acc_users
- id
- external_user_id nullable
- name
- email
- status
- role
- metadata
- created_at
- updated_at

### acc_teams
- id
- organization_id
- business_unit_id nullable
- slug
- name
- category
- status
- created_at
- updated_at

### acc_team_members
- id
- team_id
- user_id
- membership_role
- is_primary
- created_at

Unique:
`team_id + user_id`

## 3. Agentes

### acc_agents
- id
- organization_id
- business_unit_id nullable
- slug
- name
- description
- agent_type
- status
- operational_mode
- owner_team_id nullable
- owner_user_id nullable
- metadata
- created_at
- updated_at

### acc_agent_versions
- id
- agent_id
- version
- environment
- status
- model_provider
- model_name
- temperature nullable
- prompt_hash
- prompt_location nullable
- prompt_content nullable
- workflow_external_id nullable
- changelog
- released_at nullable
- released_by nullable
- created_at

Não exigir `prompt_content` se o prompt ficar versionado fora do banco. `prompt_hash` é obrigatório quando possível.

## 4. Capabilities

### acc_capabilities
- id
- code
- name
- description
- risk_level
- created_at

### acc_agent_capabilities
- agent_id
- capability_id
- enabled
- configuration
- created_at
- updated_at

## 5. Tools

### acc_tools
- id
- code
- name
- description
- tool_type
- mutation_level
- risk_level
- integration_id nullable
- external_reference nullable
- metadata
- created_at
- updated_at

### acc_agent_tools
- agent_id
- tool_id
- permission_mode
- approval_required
- configuration
- created_at
- updated_at

`permission_mode`:
- enabled
- read_only
- approval_required
- disabled

## 6. Integrações

### acc_integrations
- id
- organization_id
- code
- name
- integration_type
- status
- environment
- metadata_without_secrets
- created_at
- updated_at

Nunca armazenar segredo em texto puro nessa tabela.

### acc_agent_integrations
- agent_id
- integration_id
- criticality
- required
- configuration
- created_at

## 7. Sessões

### acc_agent_sessions
- id
- agent_id
- agent_version_id nullable
- organization_id
- business_unit_id nullable
- entity_type
- entity_id
- lead_id nullable
- status
- started_at
- last_activity_at
- ended_at nullable
- metadata

Indexar:
- agent_id + status
- entity_type + entity_id
- lead_id
- last_activity_at

## 8. Runs

### acc_agent_runs
- id
- session_id nullable
- agent_id
- agent_version_id nullable
- correlation_id
- trigger_type
- trigger_ref nullable
- status
- model_provider nullable
- model_name nullable
- input_summary nullable
- output_summary nullable
- started_at
- completed_at nullable
- duration_ms nullable
- input_tokens nullable
- output_tokens nullable
- estimated_cost nullable
- error_code nullable
- error_message nullable
- metadata

Payloads grandes devem ter política própria. Não transformar tabela em log blob sem limites.

## 9. Eventos

### acc_agent_events
- id
- event_type
- agent_id nullable
- agent_version_id nullable
- session_id nullable
- run_id nullable
- correlation_id nullable
- entity_type nullable
- entity_id nullable
- lead_id nullable
- tool_id nullable
- integration_id nullable
- occurred_at
- payload
- created_at

## 10. Human-in-the-loop

### acc_agent_requests
- id
- request_code
- organization_id
- business_unit_id nullable
- agent_id
- agent_version_id nullable
- session_id nullable
- run_id nullable
- entity_type
- entity_id
- lead_id nullable
- request_type
- category nullable
- priority
- status
- subject
- context_summary
- client_question nullable
- agent_question
- assigned_team_id nullable
- assigned_user_id nullable
- sla_due_at nullable
- created_at
- assigned_at nullable
- answered_at nullable
- resumed_at nullable
- closed_at nullable
- metadata

### acc_agent_request_messages
- id
- request_id
- sender_type
- sender_user_id nullable
- sender_agent_id nullable
- message_type
- content
- created_at
- metadata

`sender_type`:
- human
- agent
- system

### acc_agent_assignments
Histórico de atribuições.
- id
- request_id
- from_team_id nullable
- to_team_id nullable
- from_user_id nullable
- to_user_id nullable
- assigned_by_type
- assigned_by_id nullable
- reason nullable
- created_at

## 11. Roteamento

### acc_routing_rules
- id
- organization_id
- business_unit_id nullable
- name
- priority_order
- enabled
- conditions JSONB
- destination_team_id nullable
- destination_user_id nullable
- fallback_team_id nullable
- fallback_user_id nullable
- sla_minutes nullable
- created_at
- updated_at

O motor deve ser determinístico e testável.

## 12. Conhecimento

### acc_knowledge_items
- id
- organization_id
- business_unit_id nullable
- canonical_key
- title
- category
- scope
- status
- current_version_id nullable
- valid_from nullable
- valid_until nullable
- created_by
- approved_by nullable
- created_at
- updated_at

### acc_knowledge_versions
- id
- knowledge_item_id
- version
- content
- source_type
- source_reference nullable
- created_by
- approved_by nullable
- created_at

### acc_knowledge_permissions
- id
- knowledge_item_id
- agent_id nullable
- team_id nullable
- business_unit_id nullable
- permission
- created_at

## 13. Controles

### acc_entity_agent_bindings
- id
- entity_type
- entity_id
- lead_id nullable
- agent_id
- status
- bound_at
- unbound_at nullable
- reason nullable
- metadata

### acc_automation_controls
- id
- scope_type
- scope_id
- mode
- reason
- set_by_type
- set_by_id nullable
- expires_at nullable
- created_at
- updated_at

`scope_type`:
- global
- organization
- business_unit
- agent
- entity

## 14. Incidentes

### acc_incidents
- id
- code
- incident_type
- severity
- status
- title
- description
- agent_id nullable
- agent_version_id nullable
- session_id nullable
- run_id nullable
- tool_id nullable
- integration_id nullable
- entity_type nullable
- entity_id nullable
- lead_id nullable
- detected_at
- acknowledged_at nullable
- resolved_at nullable
- resolved_by nullable
- root_cause nullable
- resolution nullable
- metadata

## 15. Saúde das integrações

### acc_integration_health
- id
- integration_id
- status
- checked_at
- latency_ms nullable
- error_code nullable
- message nullable
- metadata

## 16. Auditoria

### acc_audit_log
- id
- organization_id nullable
- actor_type
- actor_id nullable
- action
- target_type
- target_id
- correlation_id nullable
- reason nullable
- before_state nullable
- after_state nullable
- created_at

Append-only por padrão.
