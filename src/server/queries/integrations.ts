import type { Queryable } from '../auth/db.ts';

export interface IntegrationListItem {
  id: string;
  code: string;
  name: string;
  integrationType: string;
  status: string;
  environment: string;
  toolCount: number;
  catalogCount: number;
  agents: { id: string; name: string; criticality: string; required: boolean }[];
  lastHealth: { status: string; checkedAt: string } | null;
}

export async function listIntegrations(db: Queryable): Promise<IntegrationListItem[]> {
  const { rows } = await db.query(
    `SELECT i.id, i.code, i.name, i.integration_type, i.status, i.environment,
            (SELECT count(*) FROM acc_tools t WHERE t.integration_id = i.id) AS tool_count,
            (SELECT count(*) FROM acc_integration_entities e WHERE e.integration_id = i.id) AS catalog_count,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'criticality', ai.criticality, 'required', ai.required)
                                        ORDER BY a.name)
                        FROM acc_agent_integrations ai JOIN acc_agents a ON a.id = ai.agent_id
                       WHERE ai.integration_id = i.id AND a.status <> 'archived'), '[]'::jsonb) AS agents
       FROM acc_integrations i
      ORDER BY i.code, i.environment`,
  );
  return rows.map((r) => ({
    id: String(r.id), code: String(r.code), name: String(r.name), integrationType: String(r.integration_type),
    status: String(r.status), environment: String(r.environment), toolCount: Number(r.tool_count), catalogCount: Number(r.catalog_count),
    agents: (r.agents as { id: string; name: string; criticality: string; required: boolean }[]) ?? [],
    lastHealth: null, // acc_integration_health chega na Fase 8; nunca inventar saude.
  }));
}
