-- 0002_seed_vne_organization (up) — seed idempotente da organizacao VNE.
-- Nenhuma business unit e nenhum agente: serao cadastrados como dados, depois.
INSERT INTO acc_organizations (slug, name)
VALUES ('vne', 'VNE')
ON CONFLICT (slug) DO NOTHING;
