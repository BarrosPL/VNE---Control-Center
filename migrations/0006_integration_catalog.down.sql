-- 0006_integration_catalog (down) — remove SOMENTE objetos criados por 0006_integration_catalog.up.sql.
-- O runner recusa se a tabela tiver linhas (catalogo importado), exceto com --force.
DROP TABLE IF EXISTS acc_integration_entities;
