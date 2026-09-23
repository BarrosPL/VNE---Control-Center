-- @ignore-rows: acc_event_types
-- 0007_agent_telemetry (down) — remove SOMENTE objetos criados por 0007_agent_telemetry.up.sql.
-- O runner recusa se sessoes/runs/eventos tiverem linhas (telemetria coletada), exceto com --force.
DROP TABLE IF EXISTS acc_agent_events;
DROP TABLE IF EXISTS acc_agent_runs;
DROP TABLE IF EXISTS acc_agent_sessions;
DROP TABLE IF EXISTS acc_event_types;
DROP FUNCTION IF EXISTS acc_agent_events_touch_session();
DROP FUNCTION IF EXISTS acc_agent_runs_guard();
DROP FUNCTION IF EXISTS acc_agent_events_immutable();
DROP FUNCTION IF EXISTS acc_jsonb_has_forbidden_keys(jsonb);
DROP FUNCTION IF EXISTS acc_text_looks_personal(text);
ALTER TABLE acc_agents DROP CONSTRAINT IF EXISTS uq_acc_agents_id_org;
