# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

React Native + Expo com React Native Web e PWA. O mobile é a versão principal, e o mesmo
código roda na web, que hoje também serve de canal de distribuição. A linguagem visual é
uma só para as duas plataformas, não muda por sistema operacional.

## Users

Grupos de amigos que organizam o racha (futebol amador semanal). São dois papéis:

- **Organizador:** abre a lista, define vagas e valor, confirma pagamentos e sorteia os
  times.
- **Jogador:** entra na lista, paga via Pix e confere o time.

A cena principal é no celular, à noite, com a lista abrindo no horário marcado e o grupo
inteiro tentando garantir vaga ao mesmo tempo.

## Product Purpose

Resolver tudo que acontece antes da bola rolar: a lista de confirmação, a cobrança via
Pix e o sorteio equilibrado de times. O sucesso é o grupo parar de discutir quem vai,
quem pagou e se os times foram justos.

## Positioning

Todo app de pelada resolve logística. O Colete resolve desconfiança. Cada intervenção do
organizador no sorteio fica numa trilha que o grupo inteiro enxerga. A vaga é decidida
pelo servidor, com reserva atômica, e não pelo cliente.

## Operating Context

O link chega pelo grupo de WhatsApp. A lista abre num horário fixo e as vagas são
disputadas em segundos. O pagamento é por Pix, com comprovante privado. Os times são
publicados antes do jogo. O nome vem do colete que divide os times na pelada.

## Capabilities and Constraints

- Hoje estão entregues autenticação por e-mail e senha com código, perfil, grupos,
  convites, membros e configurações do grupo. Lista, pagamento e sorteio entram em
  marcos seguintes (docs/16, docs/27).
- O app não intermedia nem custodia pagamento. Ele só exibe a chave Pix do organizador.
- O telefone não é coletado.
- Os textos ficam em `src/lib/i18n/pt.ts` (pt-BR). Os testIDs e rótulos acessíveis são
  contrato da suíte e2e.
- A CSP é estrita: fontes e scripts servidos do próprio domínio, sem CDN.

## Brand Commitments

- **Nome:** Colete. O colete é o objeto que divide os times.
- **Tom (decidido por César em 13/10/2026):** súmula e árbitro. Sério, preciso e
  confiável, de registro oficial.
- **O visual não pode parecer (decidido por César em 13/10/2026):**
  - app de aposta (preto com verde ou amarelo neon, odds, cassino);
  - banco ou fintech (frio, corporativo, roxo ou azul genérico);
  - o clichê do gramado verde (campo, bola e apito como decoração);
  - template genérico de IA (cards brancos, gradiente roxo, Inter em tudo).
- A identidade é nova. Ela não é evolução do verde atual.

## Evidence on Hand

Não há usuários reais, depoimentos nem números de uso publicáveis. Todo dado de
demonstração é fictício e precisa estar rotulado como tal.

## Product Principles

1. A regra é visível. O que decide vaga, pagamento e time aparece para o grupo.
2. Dado essencial por extenso. Dia, hora, valor e nome sempre presentes, nunca só ícone
   ou cor.
3. Uma ação principal por estado.
4. Nenhuma informação transmitida só por cor.
5. O servidor decide e a interface relata. A interface nunca promete o que o banco não
   confirmou.

## Accessibility & Inclusion

WCAG 2.2 AA nos dois temas (docs/15):

- texto ≥ 4.5:1, texto grande e componentes ≥ 3:1;
- alvo de toque ≥ 48 nesta fatia (o doc pede 44);
- foco visível e `aria-disabled` focável com motivo;
- `prefers-reduced-motion` respeitado;
- texto até 200% sem corte.
