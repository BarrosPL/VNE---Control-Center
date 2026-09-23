import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center">
      <p className="text-lg font-semibold">Não encontrado</p>
      <p className="mt-1 text-sm text-neutral-600">O item solicitado não existe ou foi removido.</p>
      <Link href="/" className="mt-4 inline-block text-sm text-sky-700 underline">Voltar ao Command Center</Link>
    </div>
  );
}
