import { VNE_ID_COLUMNS } from '../../domain/data-sources.ts';
import type { Queryable } from '../auth/db.ts';

// Resolve IDs externos (pipeline/status/user...) em nomes usando o catalogo generico
// (acc_integration_entities). Consulta EM LOTE: uma query por pagina, nunca uma por linha.

const KIND_RE = /^[a-z][a-z0-9_]{1,40}$/;
const MAX_REFS = 500;

export interface EntityRef {
  kind: string;
  id: string | number | bigint | null | undefined;
}
export interface ResolvedEntity {
  name: string;
  isActive: boolean;
  parentExternalId: string | null;
}
export type CatalogMap = Map<string, ResolvedEntity>;

const key = (kind: string, id: string) => `${kind}:${id}`;

export async function resolveEntities(db: Queryable, integrationCode: string, refs: EntityRef[]): Promise<CatalogMap> {
  const unique = new Map<string, { kind: string; id: string }>();
  for (const r of refs) {
    if (r.id == null || !KIND_RE.test(r.kind)) continue;
    const id = String(r.id);
    if (id.length > 64) continue;
    unique.set(key(r.kind, id), { kind: r.kind, id });
    if (unique.size >= MAX_REFS) break;
  }
  const out: CatalogMap = new Map();
  if (unique.size === 0) return out;
  const list = [...unique.values()];
  let rows;
  try {
    ({ rows } = await db.query(
    `SELECT e.entity_kind, e.external_id, e.name, e.is_active, e.parent_external_id
       FROM acc_integration_entities e JOIN acc_integrations i ON i.id = e.integration_id
      WHERE i.code = $1 AND i.environment = 'production'
        AND (e.entity_kind, e.external_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))
      ORDER BY e.is_active DESC, e.updated_at DESC`,
    [integrationCode, list.map((x) => x.kind), list.map((x) => x.id)],
    ));
  } catch (err) {
    // nome e DECORACAO: se o catalogo ainda nao existe (migration pendente), a tela mostra os IDs
    if ((err as { code?: string }).code === '42P01') return out;
    throw err;
  }
  for (const r of rows) {
    const k = key(String(r.entity_kind), String(r.external_id));
    if (out.has(k)) continue; // ativo/mais recente vence quando o mesmo ID existe sob pais diferentes
    out.set(k, { name: String(r.name), isActive: Boolean(r.is_active), parentExternalId: r.parent_external_id == null ? null : String(r.parent_external_id) });
  }
  return out;
}

/** Texto de exibicao: nome do catalogo ou o ID (nunca inventa nome). */
export function entityLabel(map: CatalogMap | undefined, kind: string, id: string | number | bigint | null | undefined) {
  if (id == null) return { text: '—', resolved: false, id: null as string | null };
  const sid = String(id);
  const hit = map?.get(key(kind, sid));
  return hit
    ? { text: hit.name, resolved: true, id: sid, inactive: !hit.isActive }
    : { text: `ID ${sid}`, resolved: false, id: sid, inactive: false };
}

export interface CatalogGap {
  kind: string;
  externalId: string;
  seenIn: number; // em quantas linhas de vne_* o ID aparece
}

/**
 * IDs que aparecem nas tabelas vne_* e ainda NAO tem nome no catalogo (relatorio para preenchimento).
 * As colunas vem de uma lista fixa (VNE_ID_COLUMNS), nunca de entrada externa. Somente leitura.
 */
export async function findCatalogGaps(db: Queryable, integrationCode: string): Promise<CatalogGap[]> {
  const unions = VNE_ID_COLUMNS.map(
    (c) => `SELECT '${c.kind}'::text AS kind, ${c.column}::text AS external_id FROM ${c.table} WHERE ${c.column} IS NOT NULL`,
  ).join(' UNION ALL ');
  const { rows } = await db.query(
    `WITH seen AS (${unions})
     SELECT s.kind, s.external_id, count(*)::int AS n
       FROM seen s
      WHERE NOT EXISTS (
        SELECT 1 FROM acc_integration_entities e JOIN acc_integrations i ON i.id = e.integration_id
         WHERE i.code = $1 AND i.environment = 'production' AND e.entity_kind = s.kind AND e.external_id = s.external_id)
      GROUP BY 1, 2 ORDER BY 1, 3 DESC, 2`,
    [integrationCode],
  );
  return rows.map((r) => ({ kind: String(r.kind), externalId: String(r.external_id), seenIn: Number(r.n) }));
}

export interface CatalogEntityRow {
  kind: string;
  externalId: string;
  parentKind: string | null;
  parentExternalId: string | null;
  name: string;
  isActive: boolean;
  source: string;
  syncedAt: string | null;
}

export async function listCatalog(db: Queryable, integrationCode: string): Promise<CatalogEntityRow[]> {
  const { rows } = await db.query(
    `SELECT e.entity_kind, e.external_id, e.parent_kind, e.parent_external_id, e.name, e.is_active, e.source, e.synced_at
       FROM acc_integration_entities e JOIN acc_integrations i ON i.id = e.integration_id
      WHERE i.code = $1 AND i.environment = 'production'
      ORDER BY e.entity_kind, e.parent_external_id NULLS FIRST, e.name
      LIMIT 2000`,
    [integrationCode],
  );
  return rows.map((r) => ({
    kind: String(r.entity_kind), externalId: String(r.external_id),
    parentKind: r.parent_kind == null ? null : String(r.parent_kind),
    parentExternalId: r.parent_external_id == null ? null : String(r.parent_external_id),
    name: String(r.name), isActive: Boolean(r.is_active), source: String(r.source),
    syncedAt: r.synced_at ? new Date(String(r.synced_at)).toISOString() : null,
  }));
}
