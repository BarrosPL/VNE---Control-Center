import type { ReactNode } from 'react';
import type { Tone } from '../domain/labels.ts';

const TONES: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-900 ring-amber-200',
  danger: 'bg-red-50 text-red-800 ring-red-200',
  info: 'bg-sky-50 text-sky-800 ring-sky-200',
  neutral: 'bg-neutral-100 text-neutral-700 ring-neutral-200',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-neutral-600">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Card({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-neutral-200 bg-white p-4 ${className}`}>
      {title && <h2 className="mb-3 text-sm font-semibold text-neutral-800">{title}</h2>}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone === 'danger' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : ''}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-neutral-500">{hint}</div>}
    </div>
  );
}

/** Metrica cuja fonte ainda nao existe: deixa claro que NAO e zero. */
export function StatUnavailable({ label, phase }: { label: string; phase: string }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-neutral-400">Indisponível</div>
      <div className="mt-1 text-xs text-neutral-500">Disponível na {phase}.</div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <p className="mt-1 text-sm text-neutral-600">{children}</p>}
    </div>
  );
}

export function Forbidden({ permission }: { permission?: string }) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-6">
      <p className="font-semibold text-red-800">Acesso negado</p>
      <p className="mt-1 text-sm text-red-700">
        Seu perfil não tem permissão para ver esta área{permission ? ` (${permission})` : ''}. Fale com um administrador.
      </p>
    </div>
  );
}

/** A plataforma registra estados, mas ainda nao os impoe aos workflows. Sempre visivel onde ha estado. */
export function InformationalNotice() {
  return (
    <p role="note" className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
      Modo informativo: os estados exibidos refletem o cadastro. O Control Center ainda não os impõe aos workflows
      em produção (controles operacionais chegam na Fase 6).
    </p>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="min-w-full text-sm">{children}</table>
    </div>
  );
}
export const Th = ({ children }: { children?: ReactNode }) => (
  <th scope="col" className="border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500">
    {children}
  </th>
);
export const Td = ({ children, className = '' }: { children?: ReactNode; className?: string }) => (
  <td className={`border-b border-neutral-100 px-3 py-2 align-top ${className}`}>{children}</td>
);
