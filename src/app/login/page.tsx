import { LoginForm } from '../../components/login-form.tsx';

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">VNE Agent Control Center</h1>
        <p className="text-sm text-neutral-600">Acesso restrito a usuários autorizados.</p>
      </div>
      <LoginForm />
    </main>
  );
}
