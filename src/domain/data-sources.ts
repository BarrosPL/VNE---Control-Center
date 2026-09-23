// Mapeamento entre as tabelas do Data Plane (vne_*) e a INTEGRACAO cujos IDs elas carregam.
// Sao dados de configuracao, nao regra de negocio: se outro CRM passar a alimentar vne_*, so aqui muda.
// O frontend nunca conhece nomes de pipelines/etapas/usuarios: resolve tudo pelo catalogo generico.

/** Integracao (acc_integrations.code) dona dos IDs de lead das tabelas vne_*. */
export const LEAD_DATA_INTEGRATION = 'kommo';

/** Tipos de entidade (acc_integration_entities.entity_kind) usados pelas telas de lead. */
export const KIND = { pipeline: 'pipeline', status: 'status', user: 'user' } as const;

/**
 * Colunas de vne_* que guardam IDs externos catalogaveis (para o relatorio de IDs sem nome).
 * Somente identificadores/colunas fixas: nunca montados a partir de entrada do usuario.
 */
export const VNE_ID_COLUMNS: { table: string; column: string; kind: string }[] = [
  { table: 'vne_leads_snapshot', column: 'pipeline_id', kind: KIND.pipeline },
  { table: 'vne_leads_snapshot', column: 'status_id', kind: KIND.status },
  { table: 'vne_leads_snapshot', column: 'responsible_user_id', kind: KIND.user },
  { table: 'vne_eventos_crm', column: 'pipeline_id', kind: KIND.pipeline },
  { table: 'vne_eventos_crm', column: 'status_id', kind: KIND.status },
  { table: 'vne_eventos_crm', column: 'previous_pipeline_id', kind: KIND.pipeline },
  { table: 'vne_eventos_crm', column: 'previous_status_id', kind: KIND.status },
  { table: 'vne_eventos_crm', column: 'responsible_user_id', kind: KIND.user },
];
