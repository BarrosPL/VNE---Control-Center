# Project Charter

## Nome
VNE Agent Control Center

## Visão

Criar uma plataforma unificada para visualizar, governar, operar e evoluir todos os agentes de IA do ecossistema VNE.

## Problema

Hoje agentes e automações podem crescer como workflows isolados. Conforme novos agentes surgem, aumenta o risco de:

- responsabilidades sobrepostas;
- ferramentas duplicadas;
- ausência de observabilidade;
- dificuldade de intervenção humana;
- falta de versionamento;
- conhecimento espalhado em prompts;
- erros difíceis de rastrear;
- dependência excessiva de operadores técnicos.

## Resultado esperado

Um operador autorizado deve conseguir responder perguntas como:

- Quais agentes existem?
- Qual está ativo agora?
- Qual versão está em produção?
- Quais tools ele pode usar?
- Que integrações ele depende?
- Quais leads estão sendo atendidos?
- Quem respondeu ao cliente?
- Onde uma execução falhou?
- Qual agente abriu uma solicitação humana?
- Quem assumiu?
- Quanto tempo levou?
- Posso pausar este agente?
- Posso assumir somente este lead?
- Posso devolver o lead para IA?
- Qual conhecimento foi usado?
- Qual alteração produziu determinado comportamento?

## Non-goals iniciais

Não construir agora:
- substituto do Kommo;
- substituto do n8n;
- CRM próprio completo;
- sistema financeiro;
- gestão documental completa;
- editor visual de workflows;
- construtor de agentes low-code completo.

O Control Center integra e governa essas capacidades.

## Princípios

1. Agente é configuração, não módulo hardcoded.
2. Dados existentes são reaproveitados.
3. Ações sensíveis são auditáveis.
4. Human-in-the-loop é primeira classe.
5. Controle humano pode sobrepor IA.
6. Observabilidade vem antes de autonomia maior.
7. Conhecimento tem versão e aprovação.
8. Toda integração pode falhar; o sistema deve degradar com clareza.
9. Multiunidade deve ser possível sem reescrever o núcleo.
10. Produção nunca é laboratório.
