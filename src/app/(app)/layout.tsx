import { AppNav, type NavItem } from '../../components/app-nav.tsx';
import { ROLE_LABEL } from '../../domain/labels.ts';
import { can, type Permission } from '../../domain/rbac.ts';
import { requireUser } from '../../server/guards.ts';
import { logoutAction } from '../login/actions.ts';

const NAV: (NavItem & { permission: Permission })[] = [
  { href: '/', label: 'Command Center', permission: 'dashboard:read' },
  { href: '/leads', label: 'Leads', permission: 'entities:read' },
  { href: '/agents', label: 'Agentes', permission: 'agents:read' },
  { href: '/live', label: 'Operação ao vivo', permission: 'agents:read' },
  { href: '/integrations', label: 'Integrações', permission: 'integrations:read' },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const items = NAV.filter((n) => can(user.role, n.permission)).map(({ href, label }) => ({ href, label }));
  return (
    <div className="min-h-screen bg-neutral-50">
      {process.env.DEMO_MODE === '1' && (
        <div role="note" className="bg-violet-700 px-6 py-1.5 text-center text-xs font-medium text-white">
          AMBIENTE DE DEMONSTRAÇÃO — banco local descartável com dados fictícios e telemetria sintética. Não é produção.
        </div>
      )}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 bg-white px-6 py-3">
        <div className="flex items-center gap-6">
          <span className="font-semibold">VNE Agent Control Center</span>
          <AppNav items={items} />
        </div>
        <form action={logoutAction} className="flex items-center gap-3 text-sm">
          <span className="text-neutral-600">
            {user.name} · {ROLE_LABEL[user.role] ?? user.role}
          </span>
          <button type="submit" className="rounded-md border border-neutral-300 px-2 py-1 hover:bg-neutral-100">
            Sair
          </button>
        </form>
      </header>
      <main className="mx-auto max-w-6xl p-6">{children}</main>
    </div>
  );
}
