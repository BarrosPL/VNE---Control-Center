-- 0003_auth (down) — remove SOMENTE objetos criados por 0003_auth.up.sql.
-- O runner recusa se houver linhas (sessoes/credenciais), exceto com --force.
DROP TABLE IF EXISTS acc_login_attempts;
DROP TABLE IF EXISTS acc_sessions;
DROP TABLE IF EXISTS acc_user_credentials;
