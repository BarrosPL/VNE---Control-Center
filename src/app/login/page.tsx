import { redirect } from 'next/navigation';
import { LoginForm } from '../../components/login-form.tsx';
import { getSession } from '../../server/guards.ts';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ motivo?: string }> }) {
  // Redireciona somente se a sessao for VALIDA no servidor; cookie apenas presente nao basta.
  if (await getSession()) redirect('/');
  const { motivo } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">VNE Agent Control Center</h1>
        <p className="text-sm text-neutral-600">Acesso restrito a usuários autorizados.</p>
      </div>
      {motivo === 'expirada' && (
        <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Sua sessão expirou ou foi encerrada. Entre novamente.
        </p>
      )}
      <LoginForm />
    </main>
  );
}
