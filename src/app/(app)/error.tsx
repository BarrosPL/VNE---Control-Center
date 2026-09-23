'use client';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-6">
      <p className="font-semibold text-red-800">Não foi possível carregar esta tela.</p>
      <p className="mt-1 text-sm text-red-700">Tente novamente. Se persistir, avise o administrador.</p>
      <button type="button" onClick={reset} className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1 text-sm">
        Tentar novamente
      </button>
    </div>
  );
}
