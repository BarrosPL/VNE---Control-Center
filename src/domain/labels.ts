// Rotulos pt-BR e tons visuais. O tom nunca e a unica pista: todo estado tambem tem texto.
export type Tone = 'ok' | 'warn' | 'danger' | 'neutral' | 'info';

export const MODE_LABEL: Record<string, { label: string; tone: Tone; hint: string }> = {
  active: { label: 'Ativo', tone: 'ok', hint: 'Executa normalmente.' },
  read_only: { label: 'Somente leitura', tone: 'info', hint: 'Analisa e recomenda; tools mutáveis bloqueadas.' },
  paused: { label: 'Pausado', tone: 'warn', hint: 'Sem novas execuções automáticas.' },
  degraded: { label: 'Degradado', tone: 'warn', hint: 'Opera parcialmente; há dependência indisponível.' },
  disabled: { label: 'Desabilitado', tone: 'danger', hint: 'Fora de operação.' },
};

export const STATUS_LABEL: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  active: { label: 'Ativo', tone: 'ok' },
  archived: { label: 'Arquivado', tone: 'neutral' },
  candidate: { label: 'Candidata', tone: 'info' },
  deprecated: { label: 'Obsoleta', tone: 'neutral' },
  degraded: { label: 'Degradada', tone: 'warn' },
  disabled: { label: 'Desabilitada', tone: 'danger' },
};

export const RISK_LABEL: Record<string, { label: string; tone: Tone }> = {
  low: { label: 'Baixo', tone: 'neutral' },
  medium: { label: 'Médio', tone: 'info' },
  high: { label: 'Alto', tone: 'warn' },
  critical: { label: 'Crítico', tone: 'danger' },
};

export const MUTATION_LABEL: Record<string, { label: string; tone: Tone }> = {
  read: { label: 'Leitura', tone: 'ok' },
  write: { label: 'Escrita', tone: 'warn' },
  destructive: { label: 'Destrutiva', tone: 'danger' },
};

export const PERMISSION_LABEL: Record<string, { label: string; tone: Tone }> = {
  enabled: { label: 'Habilitada', tone: 'ok' },
  read_only: { label: 'Somente leitura', tone: 'info' },
  approval_required: { label: 'Exige aprovação', tone: 'warn' },
  disabled: { label: 'Desabilitada', tone: 'danger' },
};

export const CRITICALITY_LABEL: Record<string, string> = {
  low: 'Baixa', normal: 'Normal', high: 'Alta', critical: 'Crítica',
};

export const ROLE_LABEL: Record<string, string> = {
  viewer: 'Visualizador', specialist: 'Especialista', manager: 'Gestor', admin: 'Administrador',
};

const fmt = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo',
});
/** Datas sao gravadas em UTC; a interface formata em America/Sao_Paulo. */
export function formatDateTime(iso: string | null | undefined): string {
  return iso ? fmt.format(new Date(iso)) : '—';
}

export function relativeAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'sem registro';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return 'agora há pouco';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
}

export const CHANNEL_LABEL: Record<string, string> = {
  waba: 'WhatsApp (API oficial)',
  'com.amocrm.amocrmwa': 'WhatsApp (amoCRM)',
  instagram_business: 'Instagram',
  facebook: 'Facebook',
};
export const channelLabel = (origin: string | null | undefined) =>
  origin ? (CHANNEL_LABEL[origin] ?? origin) : 'canal desconhecido';

export const AUTHOR_LABEL: Record<string, { label: string; tone: Tone }> = {
  cliente: { label: 'Cliente', tone: 'neutral' },
  bot: { label: 'Bot / IA', tone: 'info' },
  humano: { label: 'Humano', tone: 'ok' },
  empresa: { label: 'Empresa', tone: 'warn' },
};

export const EVENT_LABEL: Record<string, string> = {
  lead_created: 'Lead criado',
  lead_updated: 'Lead atualizado',
  lead_status_changed: 'Etapa alterada',
  lead_responsible_changed: 'Responsável alterado',
  lead_deleted: 'Lead excluído',
  lead_restored: 'Lead restaurado',
  lead_note_added: 'Nota adicionada',
  task_created: 'Tarefa criada',
  task_updated: 'Tarefa atualizada',
  task_completed: 'Tarefa concluída',
  task_responsible_changed: 'Responsável da tarefa alterado',
  task_deleted: 'Tarefa excluída',
  talk_added: 'Conversa iniciada',
  talk_updated: 'Conversa atualizada',
};
export const eventLabel = (t: string) => EVENT_LABEL[t] ?? t;

export const ATTACHMENT_LABEL: Record<string, string> = {
  picture: 'imagem', voice: 'áudio', file: 'arquivo', sticker: 'figurinha', video: 'vídeo',
};

/** Estado OBSERVADO no workflow (fato lido do n8n) — distinto da politica do Control Center. */
export const OBSERVED_LABEL: Record<string, { label: string; tone: Tone; hint: string }> = {
  present: { label: 'Presente', tone: 'ok', hint: 'Observada no workflow em uso.' },
  absent: { label: 'Ausente', tone: 'warn', hint: 'Foi retirada do workflow; o vínculo e a política foram preservados.' },
  disabled_in_workflow: { label: 'Desabilitada no n8n', tone: 'warn', hint: 'O node existe, mas está desabilitado no workflow.' },
  unknown: { label: 'Não observada', tone: 'neutral', hint: 'Ainda não houve observação do workflow.' },
};

export const RUN_STATUS_LABEL: Record<string, { label: string; tone: Tone }> = {
  running: { label: 'Em execução', tone: 'info' },
  succeeded: { label: 'Sucesso', tone: 'ok' },
  failed: { label: 'Falhou', tone: 'danger' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
  timed_out: { label: 'Tempo esgotado', tone: 'danger' },
};

export const SESSION_STATUS_LABEL: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Ativa', tone: 'ok' },
  ended: { label: 'Encerrada', tone: 'neutral' },
  expired: { label: 'Expirada', tone: 'neutral' },
};

export const EVENT_TYPE_LABEL: Record<string, string> = {
  MESSAGE_RECEIVED: 'Mensagem recebida', RUN_STARTED: 'Execução iniciada', TOOL_CALLED: 'Tool chamada',
  TOOL_SUCCEEDED: 'Tool concluída', TOOL_FAILED: 'Tool falhou', MESSAGE_SENT: 'Mensagem enviada',
  HUMAN_REQUESTED: 'Ajuda humana solicitada', RUN_SUCCEEDED: 'Execução concluída', RUN_FAILED: 'Execução falhou', ERROR: 'Erro',
};
export const eventTypeLabel = (t: string) => EVENT_TYPE_LABEL[t] ?? t;

export const LEVEL_TONE: Record<string, Tone> = { info: 'neutral', warn: 'warn', error: 'danger' };

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
