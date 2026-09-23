import { entityLabel, type CatalogMap } from '../server/catalog/resolver.ts';

/** Nome do catalogo (com o ID no tooltip) ou o ID puro quando ainda nao ha nome — nunca inventa nomes. */
export function EntityName({
  map, kind, id,
}: { map: CatalogMap | undefined; kind: string; id: string | number | bigint | null | undefined }) {
  const l = entityLabel(map, kind, id);
  if (l.id == null) return <>—</>;
  if (!l.resolved) {
    return <span className="text-neutral-500" title="Ainda sem nome no catálogo da integração">{l.text}</span>;
  }
  return (
    <span title={`ID ${l.id}`}>
      {l.text}
      {l.inactive && <span className="ml-1 text-xs text-neutral-400">(inativo)</span>}
    </span>
  );
}
