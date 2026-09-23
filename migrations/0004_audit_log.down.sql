-- 0004_audit_log (down) — remove SOMENTE objetos criados por 0004_audit_log.up.sql.
-- A trilha de auditoria e protegida: o runner recusa o rollback se houver linhas (--force explicito).
DROP TABLE IF EXISTS acc_audit_log;
DROP FUNCTION IF EXISTS acc_audit_log_immutable();
