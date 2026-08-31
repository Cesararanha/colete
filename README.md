# Colete ⚽

> App para organizar futebol semanal: lista de confirmação, cobrança via Pix e sorteio
> equilibrado de times.

O colete é o objeto que divide os times na pelada. É disso que o app trata.

---

## O problema

Organizar pelada é caótico e sempre do mesmo jeito: a lista se perde no meio de duzentas
mensagens do grupo, ninguém sabe quem realmente vai, a cobrança vira constrangimento, e a
divisão dos times dá discussão toda semana.

## A proposta

Resolver tudo que acontece **antes da bola rolar**.

| | |
|---|---|
| 📋 **Lista** | Abre sozinha no horário marcado. Um toque para entrar. Fila de reservas com promoção automática. |
| 💸 **Pagamento** | Reserva de vaga antes do banco, QR Code Pix, comprovante privado, ledger de decisão e estorno. |
| ⚖️ **Times** | Sorteio equilibrado por nível, com **trilha de auditoria visível ao grupo**. |

---

## O diferencial

Todo app de pelada resolve logística. Este resolve **desconfiança**.

Quando o organizador sorteia os times, ele pode sortear de novo ou trocar jogadores na mão —
e **toda intervenção fica registrada numa trilha que o grupo inteiro enxerga**:

```
Sorteado 3 vezes antes de publicar
2 trocas manuais feitas pelo organizador
  • João Silva: Time 1 → Time 2
  • Pedro Lima: Time 2 → Time 1
1 alteração de nível no dia do racha
  • Marcos Souza teve o nível alterado (valores privados)
Publicado por Carlos Mendes, quinta 18h42
```

O algoritmo aplica uma regra versionada de equilíbrio. A trilha torna a intervenção humana
visível e contestável; ela é registro de operação, não prova criptográfica de que toda nota
ou decisão foi correta.

---

## Decisões de engenharia

O projeto foi desenhado a partir de três problemas que não são óbvios:

**1. A corrida por vaga é um problema de concorrência, não de interface.**
Lista abre às 20h em ponto, trinta pessoas com o dedo no botão, dezoito vagas. A solução
intuitiva — ler quantas vagas restam e então gravar — fecha o racha com vinte e cinco
inscritos. A garantia mora no banco: reserva em transação atômica, com chave de idempotência
contra duplo toque. O cliente nunca decide se há vaga; ele pede e recebe a resposta.

**2. Média igual não é time equilibrado.**
Um time com dois craques e dois pernas-de-pau tem a mesma média de um time com quatro
medianos — e pode atropelar em campo. O algoritmo v3 usa busca exata para até 12 jogadores;
acima disso combina partições aleatórias reproduzíveis com busca local 1×1/2×2. O score
mede intervalo e dispersão das médias e das proporções de extremos.

**3. Comprovante de Pix é dado pessoal de terceiro.**
Pode conter nome completo e CPF parcial. Arquivo, caminho e fingerprint são apagados 7 dias após o
fim/cancelamento; upload e leitura passam por Edge autenticada que faz streaming do bucket
privado, sem expor URL assinada, token ou caminho. Sobra o ledger mínimo da decisão financeira
pelo prazo publicado.

📄 Detalhamento em [`docs/`](./docs).

---

## Stack

| Camada | Tecnologia |
|---|---|
| App | React Native · Expo · TypeScript |
| Navegação | Expo Router |
| Backend | Supabase — PostgreSQL, Auth, Storage |
| Acesso a dados | Row Level Security |
| Observabilidade | Sentry |

**Mobile é a versão principal** (iOS e Android). O mesmo código roda na **web** via React
Native Web — o que também serve de estratégia de distribuição enquanto não há orçamento para
publicar nas lojas.

---

## Acessibilidade

Requisito de fundação, não polimento final:

- **WCAG 2.2 AA** como linha de base
- Entregas externas configuráveis por tipo de evento; os fatos permanecem no sino interno —
  excesso de push/e-mail é barreira real para pessoas com TDAH
- Tema claro e escuro
- Alvos de toque de no mínimo 44×44, foco visível, erros anunciados por leitor de tela

---

## Privacidade

- **Telefone não é coletado.** Nada no app liga para ninguém — princípio da minimização
- Comprovante de pagamento descartado automaticamente após 7 dias
- Exclusão de conta apaga o vínculo de autenticação e desidentifica o histórico que precisa
  permanecer, com retenção por categoria
- O app **não intermedia, não processa e não custodia pagamento** — apenas exibe a chave Pix
  informada pelo organizador e registra comprovantes

---

## Documentação

| Documento | Conteúdo |
|---|---|
| [01 — Requisitos](./docs/01-requisitos.md) | Requisitos funcionais e técnicos |
| [04 — Algoritmo v3](./docs/04-algoritmo-sorteio.md) | Balanceamento exato/heurístico e reprodutibilidade |
| [09 — Decisões](./docs/09-pivo-produto.md) | Registro canônico D1–D62 |
| [10 — Schema](./docs/10-schema-db.md) | Invariantes, RLS, transações, jobs e retenção |
| [11 — Telas](./docs/11-telas-v1.md) | 25 telas e seis fluxos críticos |
| [12 — Notificações](./docs/12-notificacoes.md) | Catálogo N1–N28 e entrega por destino/canal |
| [13 — Contratos](./docs/13-contratos-funcoes.md) | RPCs/Edge, idempotência e erros estáveis |
| [14 — Convenções](./docs/14-convencoes-app.md) | Estrutura, segurança e operação |
| [15 — Acessibilidade](./docs/15-acessibilidade.md) | Critérios WCAG 2.2 AA por marco |
| [16 — Roadmap](./docs/16-roadmap.md) | Gates, migrations, testes e beta PWA |
| [17 — Dados e LGPD](./docs/17-mapa-dados-lgpd.md) | Inventário canônico, retenção física, expurgo e backup |
| [18 — Retrospectiva da revisão](./docs/18-retrospectiva-review-integral.md) | Causa das omissões e rastreabilidade dos achados; não normativo |

Os documentos `02`, `03`, `05`, `06`, `07` e `08` são histórico do levantamento anterior;
não prevalecem sobre `01` e `09`–`17`.

---

## Status

🧭 **M0-A e M0-B concluídos localmente.** As migrations `0001`–`0003` entregam a fundação de
segurança, identidade e privacidade descrita em `19`/`20`. O próximo passo planejado é o M1-A:
gateway Edge exclusivo e migrations `0004`–`0007`; esse trabalho ainda não está implementado.
Os gates de convite ao beta permanecem em `16-roadmap.md`.

---

## Autor

**César Aranha** — Sistemas de Informação
