# Colete ⚽

> App para organizar o futebol semanal: lista de confirmação, cobrança via Pix e sorteio
> equilibrado de times.

O colete é o objeto que divide os times na pelada. É disso que o app trata.

**[Abrir o app](https://colete-flame.vercel.app)** · ambiente de testes, use só dados fictícios.

Projeto acadêmico de Sistemas de Informação.

---

## O problema

Organizar pelada é caótico e sempre do mesmo jeito: a lista se perde no meio de duzentas
mensagens do grupo, ninguém sabe quem realmente vai, a cobrança vira constrangimento, e a
divisão dos times dá discussão toda semana.

## A proposta

Resolver tudo que acontece **antes da bola rolar**.

| | O que o app faz hoje |
|---|---|
| 👥 **Grupo** | Convite por link, código ou QR Code, aprovação de membros, papéis (dono, organizador e jogador), foto, ícone e cor. |
| 📋 **Racha** | Criar, editar e cancelar, com busca de endereço e distância até o local. A agenda junta os rachas de todos os grupos. |
| ✋ **Lista** | Um toque para entrar. Sem vaga, a pessoa vai para a espera e é promovida automaticamente quando alguém sai. |
| 💸 **Pagamento** | O organizador cadastra o Pix do racha. Quem está confirmado vê o valor, o QR Code e o copia e cola. O organizador marca quem pagou e registra devoluções. |
| ⚖️ **Times** | Notas de 1 a 5 por jogador e sorteio de 2 a 4 times equilibrados, visível para o grupo. |
| 🔐 **Conta** | Cadastro com código por e-mail, recuperação de senha, exportação dos dados e exclusão da conta. |

---

## Decisões de engenharia

**1. A corrida por vaga é um problema de concorrência, não de interface.**
O link cai no grupo, trinta pessoas com o dedo no botão, dezoito vagas. A solução
intuitiva (ler quantas vagas restam e então gravar) fecha o racha com vinte e cinco
inscritos. A garantia mora no banco: a inscrição trava o racha numa transação atômica, com
chave de idempotência contra duplo toque. O cliente nunca decide se há vaga; ele pede e
recebe a resposta.

**2. O sorteio é reproduzível.**
O algoritmo `snake-v1` ordena os confirmados por nota e distribui em serpentina: com notas 5,
4, 3 e 2 e dois times, a ordem é A, B, B, A. Não há nada aleatório, então sortear de novo com
a mesma lista e as mesmas notas dá os mesmos times. O algoritmo equilibra a nota humana
informada; ele não prova que a nota está certa. Cada sorteio guarda a versão do algoritmo
e a versão da nota usada, e fica marcado como desatualizado para a organização quando algo
muda.

**3. Chave Pix é dado pessoal.**
A chave é cifrada com AES-256-GCM antes de chegar ao banco, que nunca vê o valor aberto. Só
quem pode pagar ou administrar o racha recebe os dados, e eles são apagados 60 dias depois do
fim ou do cancelamento.

**4. O banco não confia no app.**
As tabelas de rachas, pagamentos, notas e sorteios ficam num schema privado, sem privilégio
para o cliente. A escrita passa por Edge Functions e funções do PostgreSQL que conferem
sessão, autoridade e estado do racha depois de obter as travas.

📄 Detalhamento em [`docs/`](./docs).

---

## Stack

| Camada | Tecnologia |
|---|---|
| App | React Native 0.88 · Expo SDK 58 · TypeScript |
| Navegação e estado | Expo Router · TanStack Query · Zustand |
| Formulários | React Hook Form · Zod |
| Backend | Supabase: PostgreSQL 17, Auth, Storage e Edge Functions |
| Testes | Vitest · pgTAP · Playwright (com axe) |
| Entrega | PWA na Vercel · GitHub Actions |

O mesmo código atende iOS, Android e **web**, via React Native Web. Hoje a distribuição é só
pela web, como PWA.

---

## Como rodar

Pré-requisitos: Node 24 (a partir da 24.13), npm 11 (a partir da 11.12.1) e Docker em
execução.

```sh
npm ci                  # instala as dependências
npm run db:start        # sobe o Supabase local, com as migrations
npx supabase status     # mostra a chave publicável (Publishable)
cp .env.example .env    # cole a chave em EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
npm run web             # abre em http://localhost:8081
```

Os e-mails locais, com o código de confirmação, aparecem em <http://127.0.0.1:54324>. Para
encerrar, `npm run db:stop` (apaga os dados locais).

Nada disso acessa o ambiente hospedado. A busca de endereço depende de uma chave própria do
LocationIQ; sem ela, o racha pode ser criado digitando o endereço.

### Testes

```sh
npm run verify:app    # lint, formatação, tipos, testes unitários, build e guardas
npm run db:test       # pgTAP no banco local
```

As suítes de concorrência (`db:test:*`) e de navegador (`test:*:web`) estão listadas em
[`AGENTS.md`](./AGENTS.md).

### Estrutura

| Pasta | Conteúdo |
|---|---|
| [`app/`](./app) | Rotas do Expo Router |
| [`src/`](./src) | Telas por funcionalidade, componentes, tema e acesso a dados |
| [`supabase/`](./supabase) | Migrations, Edge Functions e testes pgTAP |
| [`e2e/`](./e2e) | Testes de navegador com Playwright |
| [`docs/`](./docs) | Requisitos, decisões, contratos e registros de entrega |

---

## Acessibilidade

- **WCAG 2.2 AA** como linha de base
- Alvos de toque de no mínimo 44×44, foco visível e erros anunciados por leitor de tela
- Nenhuma informação transmitida só por cor
- Movimento reduzido respeitado
- Interface em tema escuro

---

## Privacidade

- **O cadastro não pede telefone.** Nada no app liga para ninguém
- Fotos são publicadas sem metadados e vistas só por quem divide um grupo ativo com a pessoa
- A pessoa pode exportar os próprios dados e excluir a conta, que apaga o acesso e
  desidentifica o histórico que precisa permanecer
- O app **não intermedia, não processa e não custodia pagamento**: só exibe o Pix informado
  pelo organizador e registra o que ele marcou

---

## Status

Piloto mínimo (decisão D63), com as migrations `0001` a `0036` em `main` (não existe a
`0025`). Ainda **não há usuários reais**.

Está nos contratos de `docs/`, mas **ainda não foi implementado**:

- abertura automática da lista e rachas recorrentes;
- comprovante de pagamento;
- algoritmo v3 de sorteio, ajuste manual dos times e trilha pública de intervenções;
- notificações;
- tela de aceite dos termos e publicação nas lojas.

O estado de cada tela e operação está em [docs/27](./docs/27-piloto-minimo.md), e o roteiro,
em [docs/16](./docs/16-roadmap.md).

---

## Documentação

| Documento | Conteúdo |
|---|---|
| [01 Requisitos](./docs/01-requisitos.md) | Requisitos funcionais e técnicos |
| [04 Algoritmo v3](./docs/04-algoritmo-sorteio.md) | Balanceamento exato/heurístico e reprodutibilidade (evolução) |
| [09 Decisões](./docs/09-pivo-produto.md) | Registro canônico D1–D62 e D63 |
| [10 Schema](./docs/10-schema-db.md) | Invariantes, RLS, transações, jobs e retenção |
| [11 Telas](./docs/11-telas-v1.md) | 25 telas e seis fluxos críticos |
| [12 Notificações](./docs/12-notificacoes.md) | Catálogo N1–N28 e entrega por destino/canal |
| [13 Contratos](./docs/13-contratos-funcoes.md) | RPCs/Edge, idempotência e erros estáveis |
| [14 Convenções](./docs/14-convencoes-app.md) | Estrutura, segurança e operação |
| [15 Acessibilidade](./docs/15-acessibilidade.md) | Critérios WCAG 2.2 AA por marco |
| [16 Roadmap](./docs/16-roadmap.md) | Gates, migrations, testes e beta PWA |
| [17 Dados e LGPD](./docs/17-mapa-dados-lgpd.md) | Inventário canônico, retenção física, expurgo e backup |
| [18 Retrospectiva da revisão](./docs/18-retrospectiva-review-integral.md) | Causa das omissões e rastreabilidade dos achados; não normativo |
| [26 Operação do M2](./docs/26-operacao-m2.md) | O que cada fatia entregou, com números medidos |
| [27 Piloto mínimo](./docs/27-piloto-minimo.md) | O que está entregue e o que ficou para depois |
| [Design](./DESIGN.md) | Regras de interface |

Os documentos `02`, `03`, `05`, `06`, `07` e `08` são histórico do levantamento anterior;
não prevalecem sobre `01` e `09`–`17`.

---

## Autor

**César Aranha**, Sistemas de Informação
