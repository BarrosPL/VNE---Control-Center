import type { Queryable, Row } from '../auth/db.ts';

export interface AgentListItem {
  id: string;
  slug: string;
  name: string;
  agentType: string;
  status: string;
  operationalMode: string;
  activeVersion: string | null;
  modelName: string | null;
  toolCount: number;
  warningCount: number;
  integrationCount: number;
  ownerName: string | null;
}

const s = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => Number(v ?? 0);

export async function listAgents(db: Queryable): Promise<AgentListItem[]> {
  const { rows } = await db.query(
    `SELECT a.id, a.slug, a.name, a.agent_type, a.status, a.operational_mode,
            v.version AS active_version, v.model_name,
            (SELECT count(*) FROM acc_agent_tools t WHERE t.agent_id = a.id AND t.permission_mode <> 'disabled') AS tool_count,
            (SELECT count(*) FROM acc_agent_tools t JOIN acc_tools x ON x.id = t.tool_id
              WHERE t.agent_id = a.id AND jsonb_array_length(COALESCE(x.metadata->'warnings', '[]'::jsonb)) > 0) AS warning_count,
            (SELECT count(*) FROM acc_agent_integrations i WHERE i.agent_id = a.id) AS integration_count,
            u.name AS owner_name
       FROM acc_agents a
       LEFT JOIN acc_agent_versions v ON v.agent_id = a.id AND v.status = 'active' AND v.environment = 'production'
       LEFT JOIN acc_users u ON u.id = a.owner_user_id
      ORDER BY (a.status = 'archived'), a.name`,
  );
  return rows.map((r: Row) => ({
    id: String(r.id), slug: String(r.slug), name: String(r.name), agentType: String(r.agent_type),
    status: String(r.status), operationalMode: String(r.operational_mode),
    activeVersion: s(r.active_version), modelName: s(r.model_name),
    toolCount: num(r.tool_count), warningCount: num(r.warning_count), integrationCount: num(r.integration_count),
    ownerName: s(r.owner_name),
  }));
}

export interface AgentDetail {
  agent: {
    id: string; slug: string; name: string; description: string | null; agentType: string; status: string;
    operationalMode: string; ownerName: string | null; ownerTeam: string | null; workflows: { id: string; role: string }[];
    createdAt: string; updatedAt: string;
  };
  versions: {
    id: string; version: string; environment: string; status: string; modelProvider: string | null;
    modelName: string | null; workflowExternalId: string | null; changelog: string | null; releasedAt: string | null; createdAt: string;
  }[];
  tools: {
    id: string; code: string; name: string; toolType: string; mutationLevel: string; riskLevel: string;
    permissionMode: string; approvalRequired: boolean; integrationCode: string | null; warnings: string[];
  }[];
  capabilities: { code: string; name: string; riskLevel: string; enabled: boolean; description: string | null }[];
  integrations: { id: string; code: string; name: string; status: string; environment: string; criticality: string; required: boolean }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export async function getAgent(db: Queryable, id: string): Promise<AgentDetail | null> {
  if (!UUID.test(id)) return null;
  const head = await db.query(
    `SELECT a.*, u.name AS owner_name, t.name AS owner_team
       FROM acc_agents a
       LEFT JOIN acc_users u ON u.id = a.owner_user_id
       LEFT JOIN acc_teams t ON t.id = a.owner_team_id
      WHERE a.id = $1`,
    [id],
  );
  const a = head.rows[0];
  if (!a) return null;
  const [versions, tools, capabilities, integrations] = await Promise.all([
    db.query(`SELECT * FROM acc_agent_versions WHERE agent_id = $1 ORDER BY created_at DESC, version DESC`, [id]),
    db.query(
      `SELECT x.id, x.code, x.name, x.tool_type, x.mutation_level, x.risk_level, x.metadata,
              t.permission_mode, t.approval_required, i.code AS integration_code
         FROM acc_agent_tools t JOIN acc_tools x ON x.id = t.tool_id LEFT JOIN acc_integrations i ON i.id = x.integration_id
        WHERE t.agent_id = $1
        ORDER BY (x.mutation_level = 'read'), x.risk_level DESC, x.code`,
      [id],
    ),
    db.query(
      `SELECT c.code, c.name, c.risk_level, c.description, ac.enabled
         FROM acc_agent_capabilities ac JOIN acc_capabilities c ON c.id = ac.capability_id WHERE ac.agent_id = $1 ORDER BY c.code`,
      [id],
    ),
    db.query(
      `SELECT i.id, i.code, i.name, i.status, i.environment, ai.criticality, ai.required
         FROM acc_agent_integrations ai JOIN acc_integrations i ON i.id = ai.integration_id WHERE ai.agent_id = $1
        ORDER BY ai.required DESC, i.code`,
      [id],
    ),
  ]);
  const meta = (a.metadata ?? {}) as { workflows?: { id?: unknown; role?: unknown }[] };
  return {
    agent: {
      id: String(a.id), slug: String(a.slug), name: String(a.name), description: s(a.description), agentType: String(a.agent_type),
      status: String(a.status), operationalMode: String(a.operational_mode), ownerName: s(a.owner_name), ownerTeam: s(a.owner_team),
      workflows: (meta.workflows ?? []).map((w) => ({ id: String(w.id), role: String(w.role ?? '') })),
      createdAt: new Date(String(a.created_at)).toISOString(), updatedAt: new Date(String(a.updated_at)).toISOString(),
    },
    versions: versions.rows.map((v) => ({
      id: String(v.id), version: String(v.version), environment: String(v.environment), status: String(v.status),
      modelProvider: s(v.model_provider), modelName: s(v.model_name), workflowExternalId: s(v.workflow_external_id),
      changelog: s(v.changelog), releasedAt: v.released_at ? new Date(String(v.released_at)).toISOString() : null,
      createdAt: new Date(String(v.created_at)).toISOString(),
    })),
    tools: tools.rows.map((t) => ({
      id: String(t.id), code: String(t.code), name: String(t.name), toolType: String(t.tool_type), mutationLevel: String(t.mutation_level),
      riskLevel: String(t.risk_level), permissionMode: String(t.permission_mode), approvalRequired: Boolean(t.approval_required),
      integrationCode: s(t.integration_code), warnings: strings((t.metadata as { warnings?: unknown } | null)?.warnings),
    })),
    capabilities: capabilities.rows.map((c) => ({
      code: String(c.code), name: String(c.name), riskLevel: String(c.risk_level), enabled: Boolean(c.enabled), description: s(c.description),
    })),
    integrations: integrations.rows.map((i) => ({
      id: String(i.id), code: String(i.code), name: String(i.name), status: String(i.status), environment: String(i.environment),
      criticality: String(i.criticality), required: Boolean(i.required),
    })),
  };
}
