# VNE Agent Control Center

Plataforma central de governança, observabilidade, operação e intervenção humana para todo o ecossistema de agentes de IA da VNE e, futuramente, demais unidades de negócio.

## Objetivo

O sistema não deve ser construído como um painel específico da Sophia, Higor ou qualquer agente atual. Agentes são entidades configuráveis da plataforma.

A plataforma deve permitir:

- cadastrar e versionar agentes;
- visualizar agentes atuais e futuros;
- observar sessões, execuções, tools e erros;
- acompanhar conversas e eventos ligados ao Kommo;
- executar human-in-the-loop;
- assumir e devolver atendimentos;
- pausar agentes globalmente ou por entidade;
- controlar permissões e capacidades;
- gerir roteamento e escalonamento;
- manter base de conhecimento governada;
- monitorar integrações;
- auditar ações humanas e automáticas;
- evoluir para múltiplas unidades de negócio sem reconstrução.

## Documentos

1. `CLAUDE.md` — regras obrigatórias para desenvolvimento.
2. `docs/00_PROJECT_CHARTER.md` — visão, objetivos e princípios.
3. `docs/01_CURRENT_STATE.md` — infraestrutura já existente.
4. `docs/02_TARGET_ARCHITECTURE.md` — arquitetura-alvo.
5. `docs/03_DATA_MODEL.md` — modelo de dados conceitual.
6. `docs/04_PRODUCT_SPEC.md` — módulos e telas.
7. `docs/05_EXECUTION_GUARDRAILS.md` — regras de implementação e segurança.
8. `docs/06_ROADMAP.md` — fases de construção.
9. `docs/07_INITIAL_BACKLOG.md` — primeiras tarefas.
10. `docs/08_GLOSSARY.md` — vocabulário.
11. `HANDOFF_TO_CLAUDE.md` — instrução inicial para a primeira sessão de execução.

## Regra principal

**Nenhuma feature central deve depender do nome de um agente específico.**

Use `agent_id`, `agent_version_id`, capabilities, tools, policies, routing e bindings.
