# Proposta: Fase 3.1 (hardening) e Fase 4A (telemetria no Control Center)

**Status: PROPOSTA. Nada disto foi aplicado em produção.** Tudo o que está descrito existe no repositório, foi testado em
PostgreSQL **17.10** descartável (mesma versão da produção) e foi **ensaiado sobre uma cópia somente-leitura do estado real
de produção** (seção 9). Nenhum workflow do n8n foi alterado. Nenhuma tabela `vne_*` foi tocada.

Produção hoje (conferido em leitura em 23/09/2026): migrations `0001`–`0004` aplicadas, 18 tabelas `acc_*`, 2 agentes, 1 usuário
(administrador temporário), 13 workflows n8n ativos, todos inalterados.

---

## 1. Decisões obrigatórias: status

| # | Decisão | Status | Evidência |
|---|---|---|---|
| 1 | Não alterar workflow n8n produtivo | Cumprido | Inventário e coletor são só `SELECT`; teste garante que o coletor emite apenas `SELECT` e nunca toca `execution_data` |
| 2 | Cookie inválido/expirado não pode criar loop; cookie não é autenticação | Corrigido (só código) | Reproduzido (`/login`→`/`→`/login`). Agora `/login` valida a sessão **no servidor**; cookie inválido passa por `/session/expired`, que o apaga. Smoke segue redirecionamentos e falha se houver loop |
| 3 | Terminologia do Lead 360 | Corrigido (só código) | “Último workflow registrado” (com aviso de que não prova autoria), “Preço do lead no Kommo”, “Não sincronizado” |
| 4 | Novo inventário de Sophia/Higor antes de atualizar o registry | Feito (leitura) | Seção 2. Registry v2 gerado **a partir do inventário**, não do registry antigo |
| 5 | Separar estado observado da política | Migration `0005` + importador + UI | `observed_state` (`present/absent/disabled_in_workflow/unknown`) separado de `permission_mode`; trigger no banco impede alterar os dois no mesmo UPDATE |
| 6 | Versão usada é imutável | Migration `0005` + importador | `config_hash`, `source_revision`, `config_snapshot`, `sealed_at`; trigger no banco; importador cria **nova versão** em vez de reescrever |
| 7 | Catálogo genérico de metadados de integrações | Migration `0006` + resolvedor + telas | `acc_integration_entities`; nenhum nome no frontend; sem nomes inventados |
| 8 | CI do GitHub sem deploy | `.github/workflows/ci.yml` | 3 jobs paralelos + agregador. Validado sintaticamente; a primeira execução real ocorre no GitHub |
| 4A | Sessões/runs/eventos, agnóstico, só no Control Center | Migration `0007` + serviço + coletor + telas | Seção 3.5 e `docs/13_TELEMETRY_CONTRACT.md` |

## 2. Fatos do novo inventário (leitura do n8n, 23/09/2026)

- **Sophia em produção (`uhnA44V465M38Hhk`, v764) e Higor (`5KTLuyhMJRxC6nRv`, v589): idênticos ao registry anterior** em tools e modelo
  (conferido por conexões `ai_tool` e respeitando `disabled`). Último salvamento da Sophia: 22/09 20:29 UTC, antes do baseline.
- **A alteração da Sophia está num workflow inativo**, `UeUgrQqNOqHpcqzB` (“… EM ATUALIZAÇÃO”, v10, salvo 23/09 13:23 UTC).
  Diferenças contra a produção: **remove** `escalar_passagem_diogo`, `finalizar_triagem` (o node permanece, desconectado), `salvar_numero_requerentes`,
  `salvar_plano_confirmado`; **adiciona** `salvar_plano_recomendado` e `salvar_quantidade_requerentes` (ambos `PATCH` no Kommo). Registrado como versão
  **candidata** (`environment=development`), sem afetar a produção.
- Outros candidatos encontrados e **não** registrados (legados): `WNOLqsZa4zzcf5iW` (Sophia v2675, 8 tools, inativo) e `nPeYfKImCtlsjJu2` (Reaquecimento Sophia, `gpt-5-mini`, 0 tools, inativo).
- Avisos ainda válidos para revisão do responsável: `escalar_passagem_diogo` chama workflow **inativo**; `mover_para_follow_up` só faz `GET`;
  `consultar_agendamentos_postgres` tem `UPDATE` no SQL.
- Coluna `tracingContext` de `execution_entity` é **sempre nula** (0/1.563 execuções em 7 dias): não há vínculo entre execução do agente e das tools.

Artefato: `docs/inventory/agents-2026-09-23.json` (estrutura, hosts e **hashes**; sem prompts, parâmetros nem credenciais).
Ferramenta: `npm run inventory:agents` (repetível).

## 3. Diff arquitetural

### 3.1 Modelo de dados: antes → depois

```
ANTES (produção)                              DEPOIS (proposto)
acc_agents ─┬─ acc_agent_versions             acc_agent_versions  + config_hash, source_revision, config_snapshot, sealed_at
            │     (mutável, sem procedência)                      + trigger de imutabilidade (selada = usada/liberada)
            ├─ acc_agent_tools                acc_agent_tools     + observed_state, observed_at, observed_source, absent_since
            │     (só permission_mode)                            (observado ≠ política; trigger impede alterar ambos juntos)
            └─ acc_agent_integrations         acc_agent_integrations + mesmos 4 campos observados
acc_integrations                              acc_integration_entities   NOVA (catálogo: pipeline/status/user/… → nome)
                                              acc_event_types            NOVA (taxonomia em dados, 10 tipos)
                                              acc_agent_sessions         NOVA
                                              acc_agent_runs             NOVA
                                              acc_agent_events           NOVA (append-only)
```

### 3.2 Registry v2 (`registry/vne.registry.json`)

Cada agente tem `versions[]`. Cada versão carrega o **observado**: `tools`, `disabled_tools`, `integrations`, modelo, `prompt_hash`, `config_hash`,
`source_revision` (`n8n:<workflow>@<versionCounter>#<versionId>`). O arquivo **não** define política: `status`, `operational_mode`,
`permission_mode` só valem na criação. Hashes vêm do inventário (nada digitado à mão). Contém 16 tools, 2 agentes, 3 versões (2 de produção, 1 candidata).

### 3.3 Regras do importador (todas testadas)

1. Nunca sobrescreve estado de **controle** (agente, tool, integração, versão).
2. Tool que sai do workflow ⇒ `observed_state=absent` + `absent_since`; vínculo, histórico e política ficam. Volta ⇒ `present` novamente.
3. Versão **selada** com configuração diferente ⇒ `VersionImmutableError` (declare uma **nova** versão). A versão anterior é deprecada, nunca alterada.
4. Versão **legada** (sem procedência): a procedência é **completada uma única vez** se o declarado for consistente com o gravado; senão, recusa.
5. Versão nunca usada (candidata) pode ser editada (auditado); ao primeiro uso, sela.
6. Itens ausentes do arquivo viram “órfãos” no relatório; nada é removido. Tudo em uma transação, com auditoria.

### 3.4 Catálogo genérico

`acc_integration_entities(integration, kind, external_id, parent, name, attributes, is_active, source, synced_at)`. Resolução **em lote** (1 query por página),
fallback honesto `ID 123` quando não há nome. Entidade removida no sistema externo fica inativa (histórico continua resolvendo). O frontend só conhece a
integração dona dos IDs de `vne_*` por configuração (`src/domain/data-sources.ts`). Tela `/integrations/<código>/catalog` lista o catálogo e o relatório
**“IDs observados nos dados sem nome”** (medido em produção: **1 pipeline, 7 etapas e 2 usuários** a preencher). Importação: `npm run db:catalog:preview|apply`. Nenhum nome
é inventado; falta o mapa real do Kommo (ver seção 12).

### 3.5 Telemetria (Fase 4A)

Sessões (agente↔entidade, uma ativa por par), runs (idempotentes por `run_key`, estado terminal final, `duration_ms` calculado pelo banco) e eventos
(append-only, chave de idempotência, `seq` para paginação por cursor). FKs compostas impedem misturar agentes/organizações. Limites anti-blob e anti-PII no banco
e no contrato. 27 índices cobrindo agente, entidade, lead, sessão, run, correlação, tipo, tool e tempo (teste verifica que cada consulta típica tem índice).
Coletor somente-leitura de `execution_entity` (Nível A) gera runs/eventos de ciclo de vida **atribuídos à versão exata do workflow**. Tool calls **não** são assumidas
observáveis (ver `13_TELEMETRY_CONTRACT.md`, seção 4). Telas (com dados sintéticos rotulados): Operação ao vivo, runs/sessões por agente, timeline do agente no Lead 360, cartões do Command Center.

### 3.6 Camada de aplicação

- Login/proxy sem loop; redirecionamentos com host correto atrás de proxy reverso (`X-Forwarded-*` validado).
- Telas de telemetria e catálogo **falham de forma suave**: sem as tabelas, mostram “Indisponível”, nunca zero e nunca erro.
- `npm run demo`: ambiente local descartável (banco embutido, dados fictícios, telemetria sintética) para ver tudo sem tocar em produção.

## 4. Migrations propostas

| Migration | Cria/altera | Dados | Rollback (`down`) | Guarda |
|---|---|---|---|---|
| `0005_registry_observed_state_and_version_seal` | +4 colunas em `acc_agent_tools` e `acc_agent_integrations`; +4 colunas em `acc_agent_versions`; 2 índices; 5 funções/triggers (guarda de política, guarda de versão, selagem por uso) | **Backfill**: `sealed_at=now()` nas versões `active/deprecated/archived` (hoje: 2 linhas) | Remove colunas e triggers | Recusa se houver versões seladas/procedência/observados, **exceto com `--force`** (define `acc.force` na transação) |
| `0006_integration_catalog` | 1 tabela, 3 índices, 1 trigger | nenhum | `DROP TABLE` | Recusa se houver linhas (sem `--force`) |
| `0007_agent_telemetry` | 4 tabelas (`acc_event_types`, sessões, runs, eventos), 27 índices, 10 funções/triggers; `UNIQUE (id, organization_id)` em `acc_agents` | Seed de 10 tipos de evento | `DROP TABLE` (ignora só a tabela de referência) | Recusa se houver sessões/runs/eventos (sem `--force`) |

Todas **somente aditivas** (teste estático: sem `DROP/TRUNCATE/DELETE`; `ALTER TABLE acc_*` só com `ADD`; `UPDATE` só em `acc_*`), com runner transacional, lock
consultivo, checksum anti-adulteração e endurecimento de privilégios (o role `arvisx_app` **não** herda acesso às tabelas novas).
Role da aplicação: `acc_event_types` só leitura; `acc_agent_events` só `SELECT/INSERT`; `acc_integration_entities` `SELECT/INSERT/UPDATE`; nunca `DELETE`.

## 5. Impacto no modelo atual (produção)

- **Dados existentes:** único efeito é `sealed_at` nas 2 versões baseline. Nenhum valor existente é reescrito. Linhas de `acc_agent_tools`/`acc_agent_integrations` ganham
  `observed_state='unknown'` até o import do registry v2 (a UI mostra “Não observada”, sem afirmar nada).
- **Registry v2 aplicado em cima (ensaiado):** completa a procedência das 2 baselines, registra a candidata da Sophia (solta), cria 2 tools, move 26 tools + 10 integrações de `unknown` para `present`,
  1 agente atualizado (metadados de workflows). **Política das 26 tools permanece `enabled`.**
- **Compatibilidade código × schema (lição de hoje):** o código novo lê colunas/tabelas novas. **Ordem obrigatória: migrations → grants → registry → código.**
  Hoje, ao atualizar o código com o servidor de desenvolvimento apontando para produção, a sua tela gerou `column t.observed_state does not exist`; parei esse servidor.
  Mitigações já no código: catálogo e telemetria falham de forma suave; teste de CI cobre migrations+app juntos. Consultas de agentes exigem `0005` (não têm fallback, por decisão: o schema é a fonte da verdade).
- **`vne_*`, workflows e credenciais:** intocados.

## 6. Riscos e mitigações

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Código à frente do schema quebra telas (ocorreu hoje) | Média | Médio (telas de leitura) | Ordem de execução fixa; servidor ligado a produção só após as migrations; CI; runbook |
| Selagem impede uma correção legítima | Baixa | Baixo | Fluxo de **nova versão**; `down --force` como emergência (auditado) |
| Baselines seladas sem procedência se o registry v2 não for importado | Baixa | Baixo | Import é o passo 3 da sequência; estado é inofensivo |
| Função `SECURITY DEFINER` (`acc_seal_version_on_use`) como superfície de escalonamento | Baixa | Médio | `search_path` fixo, só altera `sealed_at`, sem `EXECUTE` para PUBLIC, só como trigger; coberto por teste |
| Crescimento de `acc_agent_events` (11 índices ⇒ custo de escrita) | Baixa hoje | Baixo | Volume estimado baixo (dezenas de milhares/mês); particionamento por mês previsto; reavaliar em ~10 M linhas |
| PII na telemetria | Baixa | Alto | Contrato + CHECKs rejeitam texto/prompt/segredo; mensagens por referência; coletor nunca lê `execution_data` |
| Coletor exige acesso a tabelas do n8n | Certa (na 4B) | Médio | Role dedicado com `SELECT` **por coluna**, sem `execution_data`; aprovação própria; desligável |
| Mudança de schema do n8n em upgrade quebra o coletor | Média | Baixo | Teste de mapeamento; falha isolada (não afeta agentes); alerta na 4B |
| Execuções de versões antigas ficam sem versão | Certa | Baixo | Marcadas `version_unresolved`, com `workflow_version_id` preservado |
| CI não testado em Linux (desenvolvido no Windows) | Média | Baixo | Versão do Postgres fixada em 17.10; `pathToFileURL`; 1ª execução no GitHub valida |
| Nomes do catálogo são dados de funcionários | Baixa | Baixo | Visíveis a quem tem `entities:read`; decidir se restringe (seção 12) |

## 7. Rollback (testado sobre dados no formato de produção)

| Passo | Como desfazer | Efeito nos dados |
|---|---|---|
| Migrations | `npm run db:migrate:down` (uma por vez; `-- --force` autoriza `0005`) | `0007`/`0006`: remove tabelas novas. `0005`: remove colunas/triggers; **versões, tools e integrações permanecem** (ensaio: 3 versões, 26 tools, 10 integrações preservadas) |
| Grants | `REVOKE` nas tabelas novas do role `acc_app` (ou `DROP OWNED BY acc_app` seguido do setup original) | nenhum |
| Registry v2 | Reimportar o registry anterior é **recusado** (esquema v1). Desfazer = `down` de `0005` (perde procedência/observado) ou desativar versões por status | Auditoria (`AGENT_VERSION_*`, `TOOL_OBSERVATION_CHANGED`) preserva o histórico |
| Catálogo | `down` de `0006` (recusa com dados; `--force`) ou marcar entidades inativas | nenhum fora do catálogo |
| Aplicação | Voltar o código anterior é possível **antes** de aplicar `0005`; depois disso o código antigo continua funcionando, pois as mudanças são só aditivas (colunas/tabelas novas ignoradas) | nenhum |

## 8. Testes

Suíte completa em PostgreSQL 17.10 descartável, todas verdes: **74 unitários** (RBAC, contrato de telemetria, inventário n8n, origem/redirects, registry v2,
guardrails estáticos de migrations, compatibilidade com Node type-stripping), **182 de banco** (auth, registry v2, catálogo, telemetria, consultas, Lead 360),
**23 de migrations** (apply/rollback/idempotência/hardening/role), **build** e **28 verificações ponta a ponta** (smoke: proxy/login sem loop, RBAC, telas novas).
Bugs reais encontrados pelos testes durante o desenvolvimento e corrigidos: alias de colunas na UNION do timeline; limite negativo; **cursor de paginação perdia eventos
por truncar microssegundos**; filtro de URL malformado causava 500; sintaxe TS incompatível com o Node dos scripts; teste instável por relógio.
`npm run test:all` executa tudo; o CI executa os mesmos jobs.

**Não coberto:** clique de login no navegador (Server Action); execução em runner Linux; carga; API real do Kommo; volume real de telemetria.

## 9. Ensaio sobre o estado real de produção

`npm run rehearse:prod` copia (somente leitura; sem usuários, credenciais, sessões) as tabelas de registro `acc_*` de produção para um PostgreSQL 17.10 local,
aplica `0005`–`0007`, importa o registry v2 e desfaz. Resultado:

- Cópia: 1 organização, 5 integrações, 3 capabilities, 14 tools, 2 agentes, 2 versões, 4 vínculos de capability, 26 de tool, 10 de integração, 8 auditorias.
- `0005`–`0007` aplicadas sem erro; backfill selou as **2 baselines** (`tem_procedência=false`); 26 tools em `unknown`.
- Registry v2: procedência **completada** nas 2 baselines; candidata registrada (solta); 36 mudanças de observação (`unknown→present`); nenhuma versão deprecada; hashes conferem com o inventário.
- Política das tools após o import: 26 `enabled` (inalterada). Reimportação: 0 criados, 0 alterados.
- Rollback das 3 migrations (`--force`): tabelas/colunas novas removidas; dados de registro preservados.

## 10. Sequência proposta para produção (uma aprovação por etapa)

| # | Etapa | Comando (destino remoto exige `--confirm-host`) | Escrita em produção |
|---|---|---|---|
| 0 | Manter o servidor ligado a produção **desligado** até a etapa 4 | — | nenhuma |
| 1 | Aplicar `0005`, `0006`, `0007` | `npm run db:migrate:apply` | 3 migrations; backfill de 2 linhas |
| 2 | Conceder acesso mínimo às tabelas novas | `npm run db:app-role:apply` | grants |
| 3 | Importar registry v2 (antes: `db:registry:preview`) | `npm run db:registry:apply` | procedência, 1 versão, 2 tools, observação |
| 4 | Ligar o app novo a produção (`npm run dev`/deploy) | — | só leitura (+ sessões/auditoria) |
| 5 | (opcional, depende de você) importar nomes do Kommo | `npm run db:catalog:apply` | catálogo |
| 6 | **Fase 4B, aprovação separada:** role `SELECT` por coluna em `execution_entity` + coletor agendado (Nível A) | — | role + job; **sem** alterar workflows |

Verificação após cada etapa: `db:migrate:verify`, contagem de tabelas, `db:registry:preview` sem mudanças, e conferência de que os 13 workflows seguem ativos.

## 11. Fora de escopo / limitações conhecidas

- Sem ingestão HTTP e sem eventos `TOOL_*` reais (Níveis B e C do contrato); sem controle operacional (pausar/assumir) — Fase 6 (os estados exibidos continuam “modo informativo”).
- Sem troca/reset de senha, MFA, health checks de integração, incidentes, human-in-the-loop.
- Nomes de pipeline/etapa/usuário do Kommo: mecanismo pronto, **dados pendentes**.
- CI ainda não executado no GitHub; o projeto local **não é um repositório git** (é preciso `git init`/remoto para o CI rodar).

## 12. Decisões que preciso de você

1. Aprovar (ou ajustar) a sequência da seção 10, **etapa por etapa**, começando pela 1.
2. Nomes do Kommo: você fornece os nomes de pipeline/etapas/usuários, ou autoriza uma leitura da API do Kommo (somente `GET`) para preencher o catálogo?
3. Os nomes de usuários do catálogo podem ser vistos por qualquer perfil com `entities:read`, ou restringimos a `specialist`+?
4. Repositório: onde hospedar (organização/nome) para ativar o CI? Posso preparar `git init` e o primeiro commit, mas não publico sem sua decisão.
5. Nível de instrumentação da 4B: A (coleta somente-leitura) apenas, ou também planejar B (emissão explícita no workflow, que exige alterar os workflows dos agentes com aprovação própria)?
6. Revisão com o responsável dos avisos das 3 tools e das capabilities inferidas antes de tratarmos o registry como oficial.

## Adendo — hardening final antes de produção (sem alterar produção nem n8n)

Correções pedidas na auditoria; produção segue na migration 0004 e **nada foi aplicado**.

1. **Anti-PII no banco (0007).** A documentação dizia "no banco e no contrato", mas o banco só limitava o tamanho do JSON. Agora há CHECKs com `acc_jsonb_has_forbidden_keys` (payload/metadata) e `acc_text_looks_personal` (textos livres). Coleta Nível A: `input_summary`, `output_summary` e `error_message` sempre NULL (`source` `n8n.collector`); o coletor grava só `error_code`. Ver D-023 e `13_TELEMETRY_CONTRACT.md`.
2. **Observação x política (0005).** Guarda equivalente em `acc_agent_integrations` (`observed_*` x `criticality, required, configuration`); guarda de `acc_agent_tools` ampliada para TODAS as colunas `observed_*` (`observed_state, observed_at, observed_source, absent_since`). Ver D-024.
3. **Privacidade do catálogo.** Permissão `directory:read` (specialist, manager, admin; viewer não). Entidades `user` só saem do backend para quem a tem (resolvedor, lista, contagens e relatório de lacunas). Ver D-025.
4. **Documentação.** D-003 corrigido (`ALTER TABLE ... ADD` aditivo é permitido; proibido o destrutivo); `11_COMO_RODAR.md` registra que o registry v2 depende da 0005.

As migrations 0005 e 0007 foram editadas no lugar por nunca terem sido aplicadas (D-026). Suíte após o hardening: **74 unitários, 182 de banco, 23 de migrations, build e 29 verificações de smoke**, todos verdes (incluindo: bateria SQL x Zod de chaves proibidas, CHECKs de PII/Nível A, pares observação x política em tools e integrações, viewer sem nomes de usuário em Lead 360, lista, catálogo e contagem de integrações).
