-- 0001_foundation (down) — remove SOMENTE objetos criados por 0001_foundation.up.sql.
-- O runner recusa executar se alguma tabela acc_* tiver linhas (exceto com --force).
DROP TABLE IF EXISTS acc_agent_integrations;
DROP TABLE IF EXISTS acc_agent_tools;
DROP TABLE IF EXISTS acc_tools;
DROP TABLE IF EXISTS acc_integrations;
DROP TABLE IF EXISTS acc_agent_capabilities;
DROP TABLE IF EXISTS acc_capabilities;
DROP TABLE IF EXISTS acc_agent_versions;
DROP TABLE IF EXISTS acc_agents;
DROP TABLE IF EXISTS acc_team_members;
DROP TABLE IF EXISTS acc_teams;
DROP TABLE IF EXISTS acc_users;
DROP TABLE IF EXISTS acc_business_units;
DROP TABLE IF EXISTS acc_organizations;
DROP FUNCTION IF EXISTS acc_set_updated_at();
