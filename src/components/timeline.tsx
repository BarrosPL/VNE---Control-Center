import { Badge } from './ui.tsx';
import { ATTACHMENT_LABEL, AUTHOR_LABEL, channelLabel, eventLabel, formatDateTime } from '../domain/labels.ts';
import type { EventItem, MessageItem, TimelineItem } from '../server/queries/leads.ts';

function MessageRow({ m }: { m: MessageItem }) {
  const incoming = m.direction === 'entrada';
  const author = m.authorClass ? AUTHOR_LABEL[m.authorClass] : undefined;
  return (
    <li className={`flex ${incoming ? 'justify-start' : 'justify-end'}`}>
      <div
        className={`max-w-[85%] rounded-lg border px-3 py-2 text-sm ${
          incoming ? 'border-neutral-200 bg-white' : 'border-sky-200 bg-sky-50'
        }`}
      >
        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          <Badge tone={author?.tone}>{author?.label ?? m.authorClass ?? 'Autor n/d'}</Badge>
          {m.authorName && <span>{m.authorName}</span>}
          <span>{incoming ? '↓ recebida' : '↑ enviada'}</span>
          <span>{channelLabel(m.origin)}</span>
          <time dateTime={m.at ?? undefined}>{formatDateTime(m.at)}</time>
        </div>
        {m.contentRestricted ? (
          <p className="italic text-neutral-500">Conteúdo restrito ao seu perfil.</p>
        ) : m.text ? (
          <p className="whitespace-pre-wrap break-words">{m.text}</p>
        ) : null}
        {m.attachmentType && (
          <p className="mt-1 text-xs text-neutral-600">
            📎 {ATTACHMENT_LABEL[m.attachmentType] ?? m.attachmentType}
            {m.attachmentName ? `: ${m.attachmentName}` : ''}
          </p>
        )}
        {!m.contentRestricted && !m.text && !m.attachmentType && (
          <p className="italic text-neutral-400">(mensagem sem texto)</p>
        )}
      </div>
    </li>
  );
}

function EventRow({ e }: { e: EventItem }) {
  const moved = e.previousStatusId || e.previousPipelineId;
  return (
    <li className="flex justify-center">
      <div className="w-full max-w-[85%] rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2 text-xs text-neutral-700">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warn">CRM</Badge>
          <span className="font-medium">{eventLabel(e.eventType)}</span>
          <time dateTime={e.at ?? undefined} className="text-neutral-500">{formatDateTime(e.at)}</time>
        </div>
        {e.eventType === 'lead_status_changed' && (
          <p className="mt-1">
            Etapa: {moved ? `${e.previousPipelineId ?? '—'}/${e.previousStatusId ?? '—'}` : '—'} →{' '}
            {e.pipelineId ?? '—'}/{e.statusId ?? '—'}
          </p>
        )}
        {e.eventType === 'lead_responsible_changed' && e.responsibleUserId && (
          <p className="mt-1">Novo responsável (usuário Kommo): {e.responsibleUserId}</p>
        )}
        {e.taskText && <p className="mt-1 whitespace-pre-wrap break-words">Tarefa: {e.taskText}</p>}
      </div>
    </li>
  );
}

export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="space-y-2" aria-label="Linha do tempo do lead">
      {items.map((it) =>
        it.kind === 'message' ? <MessageRow key={`m${it.ref}`} m={it} /> : <EventRow key={`e${it.ref}`} e={it} />,
      )}
    </ol>
  );
}
