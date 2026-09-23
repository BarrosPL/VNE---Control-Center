import { z } from 'zod';
import { findSecretKeys } from '../../domain/registry.ts';
import { recordAudit } from '../auth/audit.ts';
import type { Queryable } from '../auth/db.ts';

// Importa um arquivo de catalogo (nomes de entidades externas). Idempotente; NUNCA apaga:
// entidades ausentes de um tipo declarado "completo" ficam inativas (o historico continua resolvendo nomes).

const kind = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const extId = z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(64));

const entity = z.object({
  kind,
  id: extId,
  name: z.string().trim().min(1).max(200),
  parent: z.object({ kind, id: extId }).optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
});

export const catalogFileSchema = z
  .object({
    integration: z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/),
    source: z.enum(['manual', 'registry', 'api_sync']).default('manual'),
    // tipos cuja lista neste arquivo e AUTORITATIVA (o que faltar nele vira inativo)
    complete_kinds: z.array(kind).default([]),
    entities: z.array(entity).min(1),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const e of f.entities) {
      const k = `${e.kind}:${e.id}:${e.parent?.id ?? ''}`;
      if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `entidade duplicada: ${k}` });
      seen.add(k);
    }
  });
export type CatalogFile = z.infer<typeof catalogFileSchema>;

export function parseCatalogFile(raw: unknown): CatalogFile {
  const leaked = findSecretKeys(raw);
  if (leaked.length) throw new Error(`Catalogo contem chaves com aparencia de segredo: ${leaked.join(', ')}`);
  return catalogFileSchema.parse(raw);
}

export interface CatalogImportSummary {
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  reactivated: number;
}

/** Deve rodar dentro de uma transacao aberta pelo chamador. */
export async function importCatalog(db: Queryable, file: CatalogFile, opts?: { correlationId?: string }): Promise<CatalogImportSummary> {
  const integ = await db.query(
    `SELECT id::text AS id, organization_id::text AS org FROM acc_integrations WHERE code = $1 AND environment = 'production'`,
    [file.integration],
  );
  if (!integ.rows[0]) throw new Error(`Integracao inexistente: ${file.integration}`);
  const integrationId = String(integ.rows[0].id);
  const summary: CatalogImportSummary = { created: 0, updated: 0, unchanged: 0, deactivated: 0, reactivated: 0 };

  for (const e of file.entities) {
    const res = await db.query(
      `INSERT INTO acc_integration_entities (integration_id, entity_kind, external_id, parent_kind, parent_external_id, name, attributes, source, synced_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
       ON CONFLICT (integration_id, entity_kind, external_id, COALESCE(parent_external_id, '')) DO UPDATE
          SET name = EXCLUDED.name, attributes = EXCLUDED.attributes, source = EXCLUDED.source,
              synced_at = EXCLUDED.synced_at, is_active = true
        WHERE (acc_integration_entities.name, acc_integration_entities.attributes, acc_integration_entities.is_active)
              IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.attributes, true)
       RETURNING (xmax = 0) AS inserted, is_active`,
      [integrationId, e.kind, e.id, e.parent?.kind ?? null, e.parent?.id ?? null, e.name, JSON.stringify(e.attributes), file.source],
    );
    if (res.rows[0]) {
      if (res.rows[0].inserted) summary.created++;
      else summary.updated++;
    } else {
      summary.unchanged++;
    }
  }

  // tipos autoritativos: o que nao veio no arquivo fica inativo (nunca e apagado)
  for (const k of file.complete_kinds) {
    const present = file.entities.filter((e) => e.kind === k).map((e) => e.id);
    const res = await db.query(
      `UPDATE acc_integration_entities SET is_active = false, synced_at = now()
        WHERE integration_id = $1::uuid AND entity_kind = $2 AND is_active AND NOT (external_id = ANY($3::text[]))`,
      [integrationId, k, present],
    );
    summary.deactivated += res.rowCount ?? 0;
  }

  if (summary.created + summary.updated + summary.deactivated > 0) {
    await recordAudit(db, {
      organizationId: String(integ.rows[0].org), actorType: 'system', action: 'CATALOG_IMPORTED', targetType: 'integration',
      targetId: integrationId, correlationId: opts?.correlationId, reason: `catalogo (${file.source})`,
      after: { integration: file.integration, ...summary },
    });
  }
  return summary;
}
