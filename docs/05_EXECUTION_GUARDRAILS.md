# Execution Guardrails

## 1. Regra de ouro

Não quebrar produção para acelerar desenvolvimento.

## 2. Existing-first

Antes de criar:
- tabela;
- endpoint;
- job;
- workflow;
- campo;

verificar se já existe equivalente.

## 3. No destructive migrations

Proibido sem aprovação explícita:
- DROP TABLE;
- DROP COLUMN;
- ALTER destrutivo;
- truncate;
- delete massivo;
- mudança irreversível.

## 4. Feature flags

Ações operacionais novas devem poder ser desabilitadas.

Especialmente:
- enviar mensagem real;
- alterar lead;
- mudar responsável;
- mover pipeline;
- gerar documento;
- efetuar handoff;
- retomar agente.

## 5. Read-only first

Integrações novas começam em leitura sempre que possível.

Ordem:
1. observar;
2. validar;
3. habilitar write em homologação;
4. habilitar write controlado em produção.

## 6. Idempotência

Webhooks e commands externos podem repetir.

Toda operação mutável deve definir estratégia de idempotência.

## 7. Audit before automation

Se uma ação não pode ser auditada, não deve ser automatizada em produção.

## 8. Human override

Humano autorizado deve conseguir:
- pausar;
- assumir;
- corrigir;
- transferir;
- devolver.

A IA não deve sobrescrever takeover humano.

## 9. Knowledge safety

Resposta humana não deve automaticamente se tornar regra global.

Conhecimento precisa:
- escopo;
- versão;
- autorização;
- validade.

## 10. Secrets

Nunca:
- commit credentials;
- renderizar token no frontend;
- gravar secret em audit log;
- colocar key em metadata.

## 11. PII

Minimizar dados pessoais nas tabelas de observabilidade.

Use referências a entidades quando o conteúdo completo já existe em `vne_mensagens`.

## 12. Logs

Logs devem ser estruturados e nunca depender de texto único para monitoramento.

## 13. Error handling

Toda integração deve produzir erro estável:
- code;
- message;
- retryable;
- source;
- correlation_id.

## 14. Rollback

Toda alteração relevante deve ter estratégia de rollback descrita antes de produção.

## 15. Production gate

Antes de qualquer write real:
- teste local/dev;
- teste integração;
- autorização;
- observabilidade;
- rollback.
