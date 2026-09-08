# Registro da entrega acadêmica — telas de racha (v0)

Status deste documento: **operacional**. Ele não cria requisito, não altera
decisão e não move o roadmap. Fica **fora** de `docs/spec-manifest.sha256`,
pelo mesmo precedente de `19`, `20`, `21` e `23`.

## 1. Por que esta branch existe

A decisão **D1** (`09-pivo-produto.md`, 25/08/2026) tirou a faculdade do
caminho crítico do produto. Esta branch não revoga a D1: ela é uma entrega
pontual de disciplina, com data marcada, executada como **exceção explícita**
ao protocolo de fatia do `AGENTS.md` §4.

Consequência registrada: `main` continua na `0010`, o M1-B Fatia 1 continua
na sua própria branch, e nenhuma fatia do `16-roadmap.md` §3 avançou aqui.

## 2. O que foi entregue

Telas **5, 6, 7 e 9** de `11-telas-v1.md`, com a arquitetura de informação
da §1 do mesmo documento:

| Rota | Tela do doc 11 |
| --- | --- |
| `/rachas` | 6 · lista de rachas |
| `/rachas?demo=vazio` | 5 · estado vazio |
| `/rachas/[id]` | 7 · detalhe do racha |
| `/rachas/[id]/times` | 9 · times publicados |
| `/perfil` | 13 · meus dados (já existia, apenas movida para dentro das abas) |

Navegação em duas camadas, como a §1 exige: **abas** (Rachas · Perfil) e
**Stack** dentro da aba Rachas. Acima de ~768 px as abas viram navegação
lateral, conforme a regra de tela larga da §0.

## 3. Por que os dados são fictícios

Não é atalho de apresentação: é o único estado possível do projeto hoje.
O schema vai até a `0011` — identidade, idempotência e operação. **Não
existe tabela de grupos nem de rachas.** A origem real destes dados será a
fatia de grupos/rachas de `16-roadmap.md` §3.

Todos os dados vivem em `src/features/racha/demo-data.ts`, tipados e
`readonly`, em um único módulo, para que a substituição futura pela API real
seja localizada. Nenhum cliente falso foi criado; `src/lib/api.ts` não foi
tocado.

## 4. Mapa de arquivos

| Arquivo | Papel |
| --- | --- |
| `app/(app)/_layout.tsx` | abas (`expo-router/js-tabs`), lateral em tela larga |
| `app/(app)/rachas/_layout.tsx` | Stack da aba Rachas |
| `app/(app)/rachas/index.tsx` · `[id]/index.tsx` · `[id]/times.tsx` | rotas finas: só escolhem a tela |
| `src/features/racha/*Screen.tsx` | as três telas |
| `src/features/racha/MatchCard · StatusTag · OccupancyBar · PlayerRow · TeamCard · EmptyMatches` | componentes reutilizáveis |
| `src/features/racha/demo-data.ts` | dados fictícios, fonte única |
| `src/theme/typography.ts` | escala tipográfica compartilhada |
| `src/lib/i18n/pt.ts` | namespace `racha` — nenhum texto literal em JSX |

## 5. Decisões e porquês

| Decisão | Por quê |
| --- | --- |
| Abas + Stack, não só Stack | é a arquitetura da §1 do doc 11; abas separam domínios, Stack representa profundidade dentro de um domínio |
| `expo-router/js-tabs` | o `Tabs` exportado por `expo-router` está deprecado nesta versão |
| Rotas finas | a rota resolve navegação; a tela resolve interface. Troca de roteador não reescreve tela |
| Texto em `i18n/pt.ts` | interface e conteúdo mudam por motivos diferentes e em ritmos diferentes |
| Cor só em `theme/colors.ts` | há teste automatizado de contraste sobre os tokens; hex solto escaparia do teste |
| Etiqueta com texto, não só cor | regra global §0: nenhuma informação exclusivamente por cor |
| Animação com `useReducedMotion()` | regra global §0: respeitar `prefers-reduced-motion` |
| Estado vazio alcançável por parâmetro | a §0 torna o estado vazio obrigatório; código inalcançável não é entrega |
| Três faces reais da Manrope | peso sintetizado pelo navegador (*faux bold*) degrada justamente os títulos |

## 6. O que ficou deliberadamente de fora

Pix, QR Code, envio de comprovante, bloco financeiro, contestação, telas de
grupo, painel do organizador e qualquer escrita em banco. Tudo isso tem
contrato próprio em `13-contratos-funcoes.md` e entra pelas fatias do
roadmap, não por esta branch.

## 7. Como rodar

```sh
npm ci
npm run web          # telas de racha funcionam sem backend
npm run verify:app   # validação completa
```

As telas de autenticação e de perfil continuam falando com o Supabase local
(`npm run db:start`). As telas de racha não dependem dele.
