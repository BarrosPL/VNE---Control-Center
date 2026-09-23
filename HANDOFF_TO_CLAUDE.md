# Handoff inicial para Claude

Leia integralmente:

1. `CLAUDE.md`
2. `docs/00_PROJECT_CHARTER.md`
3. `docs/01_CURRENT_STATE.md`
4. `docs/02_TARGET_ARCHITECTURE.md`
5. `docs/03_DATA_MODEL.md`
6. `docs/05_EXECUTION_GUARDRAILS.md`
7. `docs/06_ROADMAP.md`
8. `docs/07_INITIAL_BACKLOG.md`

## Sua primeira missão

NÃO comece construindo telas ou migrations imediatamente.

Primeiro faça um inventário técnico do projeto e devolva:

### A. Ambiente
- stack encontrada;
- estrutura de diretórios;
- package manager;
- frameworks;
- configurações de ambiente;
- forma de execução;
- forma de deploy se identificável.

### B. Banco
- como a aplicação conecta ao PostgreSQL;
- migrations existentes;
- ORM/query builder se houver;
- tabelas atuais relevantes;
- riscos de conflito com prefixo `acc_`.

### C. Integrações
- n8n;
- Kommo;
- OpenAI;
- demais integrações encontradas.

### D. Lacunas
Compare o repositório atual com o roadmap e liste:
- já existe;
- parcialmente existe;
- falta.

### E. Plano da primeira implementação
Proponha somente o menor conjunto para a Fase 1.

## Regras

- Não alterar produção.
- Não modificar workflows n8n existentes.
- Não modificar tabelas `vne_*`.
- Não criar código específico para Sophia/Higor.
- Não criar migrations destrutivas.
- Não armazenar secrets.
- Não inventar schema existente.
- Se faltar informação, faça inspeção técnica antes de assumir.
- Quando houver mais de uma solução possível, prefira a que mantém o núcleo agnóstico de agente.

Ao terminar o inventário, aguarde a definição do plano antes de alterações de produção.
