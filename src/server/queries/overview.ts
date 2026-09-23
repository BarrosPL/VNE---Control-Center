import type { Queryable } from '../auth/db.ts';

export interface Overview {
  agents: { total: number; byMode: Record<string, number>; withWarnings: number };
  integrations: { total: number; byStatus: Record<string, number> };
  registry: { tools: number; mutableTools: number; capabilities: number };
  // Dados operacionais reais (vne_*), somente leitura. null = indisponivel (nunca zero falso).
  dataPlane: null | {
    messages24h: number;
    crmEvents24h: number;
    leadsTracked: number;
    lastMessageAt: string | null;
    lastCrmEventAt: string | null;
  };
}

const groupCount = (rows: { k: unknown; n: unknown }[]) =>
  Object.fromEntries(rows.map((r) => [String(r.k), Number(r.n)]));

export async function getOverview(db: Queryable): Promise<Overview> {
  const [modes, integ, reg, warn] = await Promise.all([
    db.query(`SELECT operational_mode AS k, count(*)::int AS n FROM acc_agents WHERE status <> 'archived' GROUP BY 1`),
    db.query(`SELECT status AS k, count(*)::int AS n FROM acc_integrations GROUP BY 1`),
    db.query(
      `SELECT (SELECT count(*) FROM acc_tools)::int AS tools,
              (SELECT count(*) FROM acc_tools WHERE mutation_level <> 'read')::int AS mutable_tools,
              (SELECT count(*) FROM acc_capabilities)::int AS capabilities`,
    ),
    db.query(
      `SELECT count(DISTINCT a.id)::int AS n
         FROM acc_agents a JOIN acc_agent_tools t ON t.agent_id = a.id JOIN acc_tools x ON x.id = t.tool_id
        WHERE a.status <> 'archived' AND t.observed_state = 'present'
          AND jsonb_array_length(COALESCE(x.metadata->'warnings', '[]'::jsonb)) > 0`,
    ),
  ]);
  const byMode = groupCount(modes.rows as { k: unknown; n: unknown }[]);

  let dataPlane: Overview['dataPlane'] = null;
  try {
    const dp = await db.query(
      `SELECT (SELECT count(*) FROM vne_mensagens WHERE created_at_kommo > now() - interval '24 hours')::int AS m24,
              (SELECT count(*) FROM vne_eventos_crm WHERE received_at > now() - interval '24 hours')::int AS e24,
              (SELECT count(*) FROM vne_leads_snapshot)::int AS leads,
              (SELECT max(created_at_kommo) FROM vne_mensagens) AS last_msg,
              (SELECT max(received_at) FROM vne_eventos_crm) AS last_evt`,
    );
    const r = dp.rows[0];
    dataPlane = {
      messages24h: Number(r.m24), crmEvents24h: Number(r.e24), leadsTracked: Number(r.leads),
      lastMessageAt: r.last_msg ? new Date(String(r.last_msg)).toISOString() : null,
      lastCrmEventAt: r.last_evt ? new Date(String(r.last_evt)).toISOString() : null,
    };
  } catch {
    dataPlane = null; // tabelas ausentes/sem permissao/timeout: mostrar como indisponivel
  }

  return {
    agents: {
      total: Object.values(byMode).reduce((a, b) => a + b, 0),
      byMode,
      withWarnings: Number(warn.rows[0].n),
    },
    integrations: {
      total: Object.values(groupCount(integ.rows as { k: unknown; n: unknown }[])).reduce((a, b) => a + b, 0),
      byStatus: groupCount(integ.rows as { k: unknown; n: unknown }[]),
    },
    registry: {
      tools: Number(reg.rows[0].tools), mutableTools: Number(reg.rows[0].mutable_tools),
      capabilities: Number(reg.rows[0].capabilities),
    },
    dataPlane,
  };
}
