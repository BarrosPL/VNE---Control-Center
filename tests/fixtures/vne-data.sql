-- Dados sinteticos (sem pessoas reais). Tempos relativos a now() para testar a janela de 24h.

-- Lead 1001: completo (snapshot + janela + conversa + eventos CRM), atendido por "sophia"
INSERT INTO vne_leads_snapshot (lead_id, lead_name, pipeline_id, status_id, responsible_user_id, price,
  first_seen_at, last_seen_at, last_status_change_at, last_responsible_change_at,
  last_message_client_at, last_message_company_at, total_incoming, total_outgoing)
VALUES (1001, 'Maria Teste Silva', 9907372, 76077496, 555, 1500,
  now() - interval '3 days', now() - interval '5 minutes', now() - interval '2 days', now() - interval '1 day',
  now() - interval '2 hours', now() - interval '1 hour', 2, 2);
INSERT INTO vne_janela_meta (lead_id, contact_id, origin, contact_name, ultima_mensagem_cliente_em, ultimo_workflow)
VALUES (1001, 9001, 'waba', 'Maria (contato)', now() - interval '2 hours', 'sophia');
INSERT INTO vne_chat_map (talk_id, lead_id, contact_id, origin) VALUES
  ('t-1', 1001, 9001, 'waba'), ('t-2', 1001, 9001, 'instagram_business');
INSERT INTO vne_mensagens (lead_id, direcao, tipo_autor, author_name, texto, message_type, attachment_type,
  attachment_file_name, origin, created_at_kommo, autor_classificacao, is_automated) VALUES
  (1001, 'entrada', 'external', 'Maria', 'Olá, quero saber sobre o processo', 'text', NULL, NULL, 'waba', now() - interval '3 hours', 'cliente', false),
  (1001, 'saida',   'bot',      'Assistente', 'Claro! Posso ajudar. Qual seu nome?', 'text', NULL, NULL, 'waba', now() - interval '2 hours 50 minutes', 'bot', true),
  (1001, 'entrada', 'external', 'Maria', 'Segue meu documento', 'file', 'file', 'passaporte.pdf', 'waba', now() - interval '2 hours', 'cliente', false),
  (1001, 'saida',   'internal', 'Atendente Humano', E'Recebido!\nVou analisar.', 'text', NULL, NULL, 'waba', now() - interval '1 hour', 'humano', false);
INSERT INTO vne_eventos_crm (event_key, source, event_type, entity_type, entity_id, lead_id, pipeline_id, status_id,
  previous_pipeline_id, previous_status_id, responsible_user_id, occurred_at, payload, task_text, task_status) VALUES
  ('k1', 'kommo', 'lead_created', 'lead', 1001, 1001, 9907372, 76077492, NULL, NULL, 444, now() - interval '3 days', '{"secret":"PAYLOAD_SECRET_MARKER"}', NULL, NULL),
  ('k2', 'kommo', 'lead_status_changed', 'lead', 1001, 1001, 9907372, 76077496, 9907372, 76077492, 444, now() - interval '2 days', '{"secret":"PAYLOAD_SECRET_MARKER"}', NULL, NULL),
  ('k3', 'kommo', 'lead_responsible_changed', 'lead', 1001, 1001, 9907372, 76077496, NULL, NULL, 555, now() - interval '1 day', '{}', NULL, NULL),
  ('k4', 'kommo', 'task_created', 'lead', 1001, 1001, NULL, NULL, NULL, NULL, 555, now() - interval '30 minutes', '{}', 'Ligar para a cliente', 0);

-- Lead 1002: so mensagens (sem snapshot) e fora da janela de 24h
INSERT INTO vne_janela_meta (lead_id, origin, contact_name, ultima_mensagem_cliente_em, ultimo_workflow)
VALUES (1002, 'instagram_business', 'Contato Sem Snapshot', now() - interval '3 days', 'agente_nao_cadastrado');
INSERT INTO vne_mensagens (lead_id, direcao, tipo_autor, author_name, texto, message_type, origin, created_at_kommo, autor_classificacao) VALUES
  (1002, 'entrada', 'external', 'Joao', 'Oi', 'text', 'instagram_business', now() - interval '3 days', 'cliente');

-- Lead 1003: excluido, sem nome no snapshot (nome vem do contato)
INSERT INTO vne_leads_snapshot (lead_id, lead_name, first_seen_at, last_seen_at, is_deleted, deleted_at, total_incoming, total_outgoing)
VALUES (1003, NULL, now() - interval '10 days', now() - interval '9 days', true, now() - interval '9 days', 0, 0);
INSERT INTO vne_janela_meta (lead_id, contact_name, ultima_mensagem_cliente_em) VALUES (1003, 'Fulano de Tal', now() - interval '10 days');

-- Lead 1004: nome com caracteres especiais de LIKE
INSERT INTO vne_leads_snapshot (lead_id, lead_name, first_seen_at, last_seen_at, total_incoming, total_outgoing)
VALUES (1004, '100% Cliente_Especial', now() - interval '1 day', now() - interval '1 day', 0, 0);
