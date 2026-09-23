-- @allow-data
-- 0002_seed_vne_organization (down) — remove o seed; falha se algo o referenciar (FKs RESTRICT).
DELETE FROM acc_organizations WHERE slug = 'vne';
