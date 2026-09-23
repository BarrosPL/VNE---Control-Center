// RBAC (CLAUDE.md §19). Dominio puro: sem I/O. A autorizacao REAL acontece no backend
// (src/server/auth/guards.ts); a UI apenas esconde o que o usuario nao pode fazer.

export const ROLES = ['viewer', 'specialist', 'manager', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'dashboard:read',
  'agents:read',
  'agents:write', // registry: cadastrar/versionar agentes, tools, capabilities
  'agents:control', // pausar / read-only / retomar agente
  'integrations:read',
  'integrations:write',
  'entities:read', // Lead 360 / Entity 360
  'entities:control', // takeover humano, devolver para IA
  'conversations:read', // conteudo das mensagens (dados pessoais): menor privilegio
  'directory:read', // nomes de pessoas do diretorio das integracoes (ex.: usuarios internos do Kommo)
  'requests:read',
  'requests:respond',
  'requests:assign', // transferir / escalar
  'knowledge:read',
  'knowledge:write',
  'knowledge:approve',
  'incidents:read',
  'incidents:manage',
  'audit:read',
  'settings:read',
  'settings:write',
  'routing:manage',
  'policies:manage',
  'users:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const viewer: readonly Permission[] = [
  'dashboard:read',
  'agents:read',
  'integrations:read',
  'entities:read',
  'requests:read',
  'knowledge:read',
  'incidents:read',
];
const specialist: readonly Permission[] = [
  ...viewer,
  'requests:respond',
  'entities:control',
  'conversations:read',
  'directory:read',
  'knowledge:write',
];
const manager: readonly Permission[] = [
  ...specialist,
  'agents:control',
  'requests:assign',
  'knowledge:approve',
  'incidents:manage',
  'audit:read',
  'settings:read',
];
const admin: readonly Permission[] = PERMISSIONS;

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(viewer),
  specialist: new Set(specialist),
  manager: new Set(manager),
  admin: new Set(admin),
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Papel desconhecido ou permissao inexistente => negado (fail closed). */
export function can(role: unknown, permission: Permission): boolean {
  return isRole(role) && MATRIX[role].has(permission);
}

export function permissionsFor(role: unknown): readonly Permission[] {
  return isRole(role) ? PERMISSIONS.filter((p) => MATRIX[role].has(p)) : [];
}
