---
name: Colete
description: Placar premium em tema escuro. Azul-noite em camadas, âmbar como destaque de número, ação e seleção, e o tom de súmula e árbitro, sério, preciso e confiável.
colors:
  background: '#0A1120'
  surface: '#111A2E'
  surfaceRaised: '#18233B'
  scoreboard: '#050A14'
  scoreTileTop: '#142039'
  scoreTileBottom: '#0F182C'
  digit: '#FFB940'
  digitDim: '#7E8AA5'
  brandBand: '#0A1120'
  onBand: '#F1F2F4'
  onBandMuted: '#A8B2C6'
  bandRaised: '#18233B'
  text: '#F1F2F4'
  textSoft: '#D5DAE4'
  textMuted: '#A8B2C6'
  link: '#F1F2F4'
  primary: '#FFB940'
  onPrimary: '#1A1203'
  primarySoft: '#3A2C0E'
  indicator: '#FFB940'
  fieldBorder: '#6E7B98'
  focus: '#F1F2F4'
  focusOnBand: '#F1F2F4'
  divider: '#1E2A44'
  track: '#22304D'
  positive: '#7CD3A0'
  positiveSoft: '#14291F'
  onPositive: '#0A1120'
  warning: '#FFA46B'
  warningSoft: '#33231A'
  onWarning: '#1A1203'
  critical: '#FF9C96'
  criticalSoft: '#3A1D1F'
  info: '#9DB6FF'
  infoSoft: '#1B2647'
  accent: '#F2A7C3'
  accentSoft: '#3A1F2C'
  lilac: '#C9B3FF'
  lilacSoft: '#271F42'
  sand: '#E3D3B0'
  sandSoft: '#2D2718'
  avatar: '#2B3A63'
typography:
  scoreboard:
    fontFamily: 'Barlow Condensed'
    fontWeight: 700
    fontSize: '64px'
    fontFeature: 'tabular-nums'
  inviteCode:
    fontFamily: 'Barlow Condensed'
    fontWeight: 700
    fontSize: '56px'
    fontFeature: 'tabular-nums'
  brand:
    fontFamily: 'Barlow Condensed'
    fontWeight: 700
    fontSize: '24px'
    lineHeight: '28px'
    letterSpacing: '3px'
  display:
    fontFamily: 'Barlow'
    fontWeight: 700
    fontSize: '32px'
    lineHeight: '38px'
    letterSpacing: '-0.3px'
  heading:
    fontFamily: 'Barlow'
    fontWeight: 700
    fontSize: '28px'
    lineHeight: '32px'
  title:
    fontFamily: 'Barlow'
    fontWeight: 600
    fontSize: '22px'
    lineHeight: '28px'
  section:
    fontFamily: 'Barlow'
    fontWeight: 700
    fontSize: '20px'
    lineHeight: '26px'
  row:
    fontFamily: 'Barlow'
    fontWeight: 600
    fontSize: '18px'
    lineHeight: '24px'
  cardTitle:
    fontFamily: 'Barlow'
    fontWeight: 700
    fontSize: '18px'
    lineHeight: '22px'
  body:
    fontFamily: 'Barlow'
    fontWeight: 400
    fontSize: '17px'
    lineHeight: '25px'
  bodyStrong:
    fontFamily: 'Barlow'
    fontWeight: 600
    fontSize: '17px'
    lineHeight: '25px'
  button:
    fontFamily: 'Barlow'
    fontWeight: 700
    fontSize: '17px'
    lineHeight: '22px'
  support:
    fontFamily: 'Barlow'
    fontWeight: 400
    fontSize: '15px'
    lineHeight: '21px'
  supportStrong:
    fontFamily: 'Barlow'
    fontWeight: 600
    fontSize: '15px'
    lineHeight: '21px'
  overline:
    fontFamily: 'Barlow'
    fontWeight: 600
    fontSize: '13px'
    lineHeight: '16px'
    letterSpacing: '1.6px'
    textTransform: 'uppercase'
  navigation:
    fontFamily: 'Barlow'
    fontWeight: 600
    fontSize: '13px'
    lineHeight: '16px'
  chip:
    fontFamily: 'Barlow'
    fontWeight: 600
    fontSize: '13px'
    lineHeight: '18px'
  caption:
    fontFamily: 'Barlow'
    fontWeight: 400
    fontSize: '13px'
    lineHeight: '18px'
  captionStrong:
    fontFamily: 'Barlow'
    fontWeight: 600
    fontSize: '13px'
    lineHeight: '18px'
rounded:
  tile: '8px'
  field: '14px'
  row: '18px'
  scoreboard: '22px'
  band: '28px'
  pill: '999px'
spacing:
  xs: '4px'
  sm: '8px'
  ms: '12px'
  md: '16px'
  lg: '24px'
  xl: '32px'
  xxl: '40px'
  listGap: '10px'
  gutter: '20px'
sizes:
  target: '48px'
  button: '56px'
  field: '56px'
  row: '64px'
  compact: '44px'
layout:
  wideBreakpoint: '768px'
  mainMaxWidth: '820px'
  authMaxWidth: '560px'
  scoreboardMaxWidth: '420px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.onPrimary}'
    typography: '{typography.button}'
    rounded: '{rounded.row}'
    minHeight: '{sizes.button}'
  button-primary-selected:
    backgroundColor: '{colors.indicator}'
    textColor: '{colors.onPrimary}'
  button-secondary:
    backgroundColor: '{colors.surfaceRaised}'
    textColor: '{colors.text}'
    rounded: '{rounded.row}'
    minHeight: '{sizes.button}'
  button-outline:
    backgroundColor: 'transparent'
    textColor: '{colors.text}'
    rounded: '{rounded.field}'
    minHeight: '{sizes.target}'
  button-compact:
    rounded: '{rounded.pill}'
    minHeight: '{sizes.compact}'
  card:
    backgroundColor: '{colors.surfaceRaised}'
    rounded: '{rounded.row}'
    padding: '{spacing.lg}'
  text-field:
    backgroundColor: '{colors.surfaceRaised}'
    textColor: '{colors.text}'
    typography: '{typography.body}'
    rounded: '{rounded.field}'
    minHeight: '{sizes.field}'
  chip:
    typography: '{typography.chip}'
    rounded: '{rounded.pill}'
  scoreboard:
    backgroundColor: '{colors.scoreboard}'
    textColor: '{colors.digit}'
    typography: '{typography.scoreboard}'
    rounded: '{rounded.scoreboard}'
---

# DESIGN.md — Colete

Fonte única das regras de design do Colete: identidade, cores, tipografia, espaçamento, tokens
e componentes. **Leia este arquivo antes de mexer em qualquer tela** e atualize-o no mesmo PR
que mudar a interface.

**Precedência.** Os documentos normativos (`docs/01` a `docs/18`, `docs/22` e `docs/25`) valem
acima deste arquivo. A exceção é uma decisão humana registrada que já os contraria e ainda não
virou fatia de documentação; a única registrada hoje é o tema escuro (seção Decisões vigentes). O
`docs/29-design-system.md` é o histórico das decisões do "Placar premium"; a referência atual é
este arquivo. Todo valor daqui sai do código. Onde o código e um documento divergem, este
arquivo registra o código e a divergência vai para a última seção.

O frontmatter traz os tokens do tema escuro, o único que aparece na interface. Os nomes são os
de `src/theme/colors.ts`, `typography.ts` e `spacing.ts`. Em React Native as medidas não têm
unidade; aqui elas aparecem em px. Botão, campo e linha usam altura mínima (`minHeight`) e crescem
com o texto e a quebra de linha, para o texto a 200% não cortar. Os controles redondos ou de ícone
(avatar do topo, botão redondo da gestão de membros, amostra de cor, mostrar senha) têm altura e
largura fixas.

## Overview

O Colete organiza o racha: lista, Pix e sorteio de times. O tom foi decidido por César em
13/10/2026: súmula e árbitro, sério, preciso e confiável, de registro oficial (`PRODUCT.md`). A
cena principal é no celular, à noite, com a lista abrindo no horário marcado.

O visual é o "Placar premium": um placar de pastilhas (split-flap) sobre azul-noite. As áreas se
separam por camada (`background` → `surface` → `surfaceRaised`) e por espaço, não por contorno.
O âmbar é o destaque: numeral do placar, ação principal, seleção e os poucos outros usos listados
em Colors. A linguagem visual é uma só para
mobile e web; ela não muda por sistema operacional.

A interface roda só no tema escuro, qualquer que seja a preferência do sistema (decisão de
14/10/2026). O catálogo estático dos componentes está em `app/design-system.tsx` (código em
`src/features/design-system/`).

## Colors

Todas as cores vêm de `src/theme/colors.ts`. Fora dele, só o QR do convite (`InviteQrCode.tsx`) e
o fundo da câmera do leitor (`InviteQrScanner.web.tsx`) usam preto e branco literais.

**Camadas.** `background` (#0A1120) é o fundo da tela, da `<meta name="theme-color">` e das
duas cores do manifest. `surface` (#111A2E) é a camada dos cartões da prévia, da barra de
navegação e das linhas que não são tocáveis, como o pedido pendente. `surfaceRaised` (#18233B)
é o `AppCard`, o fundo do campo de texto, o `AsyncNotice`, o chip neutro e o avatar de conta
excluída.

**Placar.** `scoreboard` (#050A14) é o fundo do placar e a linha que corta cada pastilha ao
meio. `scoreTileTop` (#142039) e `scoreTileBottom` (#0F182C) são as duas metades da pastilha.
`digit` (#FFB940) é o numeral. `digitDim` (#7E8AA5) é o grupo de referência (o limite, como
"05" em "02 / 05"), a barra "/" e os rótulos dentro do placar. Os cinco são iguais nos dois
temas, e o teste confere isso.

**Faixa da marca.** `brandBand` (#0A1120) é igual ao fundo, então no tema escuro a faixa não
aparece e só o espaço dela fica. `onBand` (#F1F2F4) é o texto e a marca sobre ela,
`onBandMuted` (#A8B2C6) é o texto de apoio e `bandRaised` (#18233B) é a camada elevada.

**Texto.** `text` (#F1F2F4) é o texto principal. `textSoft` (#D5DAE4) é o secundário mais claro:
horários, contagens e descrições. `textMuted` (#A8B2C6) é o apoio, o placeholder, o rótulo de
botão indisponível e o ícone funcional. `link` (#F1F2F4) é o link de texto e o botão
`tertiary`.

**Ação.** `primary` (#FFB940) é o fundo da ação principal, a caixa marcada do `AppCheckbox` e o
selo de câmera do avatar no Perfil. `onPrimary` (#1A1203) é o texto e o ícone sobre `primary`
e `indicator`. `indicator` (#FFB940) marca a opção selecionada e a aba atual. `primarySoft`
(#3A2C0E) é o fundo do chip de tom `primary`.

**Bordas, foco e linhas.** `fieldBorder` (#6E7B98) é a borda do campo, o contorno do botão
`outline`, a borda da caixa de marcação, a faixa do "Sem time" e as linhas do esqueleto de
carregamento (com opacidade 0,28). `focus` (#F1F2F4) é o anel de foco e `focusOnBand` (#F1F2F4),
o anel dentro da faixa. `divider` (#1E2A44) é o fio entre linhas de um cartão. `track` (#22304D)
é a parte vazia da barra de ocupação.

**Estados.** Cada estado tem a cor do texto e do ícone, o fundo suave (`*Soft`) do chip e, quando
há botão cheio, o texto sobre ele (`on*`):

| Estado   | Cor                | Fundo suave            | Texto sobre a cor cheia |
| -------- | ------------------ | ---------------------- | ----------------------- |
| positivo | `positive` #7CD3A0 | `positiveSoft` #14291F | `onPositive` #0A1120    |
| atenção  | `warning` #FFA46B  | `warningSoft` #33231A  | `onWarning` #1A1203     |
| crítico  | `critical` #FF9C96 | `criticalSoft` #3A1D1F | —                       |
| info     | `info` #9DB6FF     | `infoSoft` #1B2647     | —                       |

`critical` também é a borda de 2 px do campo com erro, o botão `destructive` e o contorno do
`outline-destructive`.

**Cores que nunca são estado.** `accent` (#F2A7C3) e `accentSoft` (#3A1F2C) são o quinto tom de
avatar, a cor rosa do grupo e o Time D. `lilac` (#C9B3FF) / `lilacSoft` (#271F42) e `sand`
(#E3D3B0) / `sandSoft` (#2D2718) são as duas cores de grupo que os tons de estado não cobrem.
`avatar` (#2B3A63) é o tom neutro de avatar.

**Onde o âmbar aparece hoje** (levantado no código em 11/11/2026):

- placar: numeral (`digit`) e, no placar do Racha, a barra de confirmados sobre vagas (`digit`
  sobre `scoreTileTop`; `digitDim` no racha cancelado);
- ação principal (`primary`), inclusive o link de entrar do painel sintético de smoke;
- seleção (`indicator`): opção escolhida do `AppButton`, aba atual, pílulas de escolha do Perfil
  (`ProfileChoiceField`) e da nota (`RatingPicker`) e a borda do grupo escolhido em Criar racha;
- caixa marcada do `AppCheckbox` e selo de câmera do avatar no Perfil (`primary`);
- bloco de data do cartão da Agenda quando a pessoa é titular do racha (`primary`, com texto
  `onPrimary`; `MatchCard.tsx`);
- chip de papel Dono (tom `primary` do `Chip`, `group-roles.ts`);
- número da camisa no Perfil (`digit`, `profile-view.ts`) e estrela da nota (`MyRating`, `digit`);
- Time A: a faixa e o texto "Colete âmbar" (`digit`).

**Mapas de cor fixos no código.**

- Chip (`Chip.tsx`): `positive`, `warning`, `info`, `critical` e `primary` usam a cor sobre o
  fundo suave; `neutral` usa `textSoft` sobre `surfaceRaised`.
- Avatar (`avatar-tone.ts`): cinco tons, `avatar`+`text`, `positiveSoft`+`positive`,
  `warningSoft`+`warning`, `accentSoft`+`accent` e `infoSoft`+`info`, escolhidos de forma fixa
  pelo id do perfil (FNV-1a).
- Cor do grupo (`group-icon.ts`): azul `info`, verde `positive`, laranja `warning`, rosa
  `accent`, lilás `lilac` e areia `sand`, cada uma sobre o próprio `*Soft`.
- Colete do time (`team-coletes.ts`, decisão humana de 19/10/2026): Time A âmbar `digit`, B azul
  `info`, C verde `positive`, D rosa `accent`. "Sem time" usa `fieldBorder`.

## Typography

Duas famílias, empacotadas no app, um arquivo por peso: Barlow 400, 600 e 700 na interface e
Barlow Condensed 700 nos numerais do placar, no código do convite, na marca e nos números e
nomes curtos que fazem papel de placar. Estes últimos usam `face('condensed')` com tamanho
próprio, fora da escala: dia no cartão da Agenda 34/36 (30/32 no cartão estreito), número da
camisa 26/28, nome do time 24/28, posição na lista 22/26, número da nota 20/24 e iniciais do
avatar de 96 (40/44). Cada peso é importado por subcaminho
(`@expo-google-fonts/barlow/400Regular` etc.). Nada vem de CDN: a CSP (`scripts/staging-headers.mjs`) tem `font-src 'self'`.

`app/_layout.tsx` carrega as fontes com `font-display: swap` e nunca espera por elas para
renderizar. No web, cada família é uma pilha que termina em
`system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` com o peso certo.
`body { font-synthesis: none }` em `app/+html.tsx` impede o navegador de engrossar uma face que
já é negrito. No nativo vai só o nome da família, porque lá o peso sobre uma face única seria
sintetizado.

Escala (`src/theme/typography.ts`), em tamanho / altura de linha / peso:

| Estilo          | Medida          | Uso                                                     |
| --------------- | --------------- | ------------------------------------------------------- |
| `scoreboard`    | 64 / — / 700 C  | numeral do placar `xl`, algarismos tabulares            |
| `inviteCode`    | 56 / — / 700 C  | placar `lg` (código do convite, marca na autenticação)  |
| `brand`         | 24 / 28 / 700 C | marca COLETE, espaçamento de letra 3, caixa alta        |
| `display`       | 32 / 38 / 700   | título das telas de aba (Grupos, Agenda) e autenticação |
| `heading`       | 28 / 32 / 700   | título das telas abaixo de uma aba                      |
| `title`         | 22 / 28 / 600   | título do `SectionHeading`                              |
| `section`       | 20 / 26 / 700   | título de seção dentro da tela                          |
| `row`           | 18 / 24 / 600   | nome na linha de lista, título do `AsyncNotice`         |
| `cardTitle`     | 18 / 22 / 700   | título de cartão                                        |
| `body`          | 17 / 25 / 400   | corpo, valor do campo                                   |
| `bodyStrong`    | 17 / 25 / 600   | corpo destacado, item do trilho lateral                 |
| `button`        | 17 / 22 / 700   | rótulo de botão e de link de texto                      |
| `support`       | 15 / 21 / 400   | apoio, dica do campo                                    |
| `supportStrong` | 15 / 21 / 600   | rótulo do campo, mensagem de erro e de estado           |
| `overline`      | 13 / 16 / 600   | rótulo do placar, espaçamento 1,6, caixa alta           |
| `navigation`    | 13 / 16 / 600   | rótulo da aba (a aba atual passa a 700)                 |
| `chip`          | 13 / 18 / 600   | texto do chip                                           |
| `caption`       | 13 / 18 / 400   | legenda                                                 |
| `captionStrong` | 13 / 18 / 600   | legenda destacada                                       |

"C" é Barlow Condensed. O botão compacto reduz o rótulo para 15/20. O texto das pastilhas do
placar não escala com a fonte do sistema (`allowFontScaling={false}`); o placar com número real
tem rótulo acessível com o mesmo valor.

**Caixa alta** aparece hoje no `overline` (rótulo do placar e do código do convite, e cabeçalho de
semana da Agenda), na marca COLETE, no dia da semana e no mês do bloco de data do cartão da Agenda
(`matchTicket`, `match-format.ts`) e nas iniciais do avatar. O `docs/29` reservava a caixa alta
ao rótulo do placar e à marca; os outros usos estão nas divergências.

## Layout

**Espaçamento** (`src/theme/spacing.ts`): escala `4 · 8 · 12 · 16 · 24 · 32 · 40` (`xs`, `sm`,
`ms`, `md`, `lg`, `xl`, `xxl`). A margem lateral das telas autenticadas é `gutter` (20). O
`AppShell` e o `AuthShell` usam 24. Entre linhas de uma lista, `listGap` (10). No `AppShell` e nos shells
autenticados, o conteúdo termina com 40 de folga embaixo; o `AuthShell` termina no preenchimento
de 24 do quadro.

**Larguras.** Até 767 px o layout é estreito; de 768 px em diante é largo
(`WIDE_LAYOUT_BREAKPOINT`, `src/theme/layout.ts`). No estreito a navegação é uma barra inferior,
com os cantos de cima no raio 22. No largo ela vira um trilho à esquerda (`tabBarPosition:
'left'`). A coluna principal tem no máximo 820 px. A autenticação tem no máximo 560 px. O corpo
largo autenticado tem no máximo 1160 px e o do `AppShell`, 1180 px.

**Navegação.** A barra tem só Grupos e Agenda. O Perfil abre pelo avatar no canto superior
direito (`ProfileAvatarLink`, nome acessível "Abrir perfil de <nome>"). O topo de cada tela tem o
voltar, ou a marca COLETE na primeira tela de uma aba, e o avatar. O modal troca o voltar pelo
fechar e não tem avatar; o Perfil troca o avatar por "Editar" ou deixa o canto vazio (`trailing`).
As abas usam
`backBehavior: "history"`.

**Rolagem.** Cada shell rola dentro do próprio `ScrollView`; o `AuthenticatedListShell` usa a
`FlatList` como rolagem, para nunca aninhar lista em `ScrollView`. O documento tem exatamente a
altura da janela: `html`, `body` e `#root` têm `height: 100%` e `overscroll-behavior: none`.
Por isso a página nunca rola nem "quica" sozinha. O topo (`TopBar`, `role="banner"`) fica acima
da área que rola e fora do `main`. A prova é `assertNoPhantomScroll` (`e2e/support/layout.ts`),
em 390×844. Tela nova usa um dos shells; nunca põe um `ScrollView` próprio por fora deles.

**Tamanhos** (`size`): alvo de toque 48 × 48 (`target`) e alturas mínimas de botão 56, campo 56
e linha de lista 64. O controle compacto tem 44 (`compact`): botão pílula (altura mínima), e avatar
do topo, botão redondo da gestão de membros, amostra de cor do ícone do grupo e alvo do filtro da Agenda. A aba da barra inferior
tem 64 de altura e largura mínima de 48, para a barra caber em 412 px com texto a 200%. O
botão de mostrar senha é um alvo de 48 × 48 dentro do campo.

**Raios** (`radius`): `tile` 8 (pastilha do placar, linha do esqueleto), `field` 14 (campo,
botão `outline`, link e item do trilho), `row` 18 (cartão, botão em bloco, `AsyncNotice`),
`scoreboard` 22 (placar, cantos da barra inferior), `band` 28 (raio inferior da faixa, que só
aparece no tema claro) e `pill` 999 (botão compacto, chip, barra de ocupação, indicadores). A
caixa de marcação tem raio 6. O ladrilho do ícone do grupo tem raio 16 em 56 e escala na mesma
proporção (`groupIconTile`).

## Elevation & Depth

No tema escuro não há sombra. A profundidade vem só das camadas `background` → `surface` →
`surfaceRaised`. `raisedShadow` e `navigationShadow` (`src/theme/elevation.ts`) só devolvem
sombra no tema claro, que não aparece na interface.

## Components

Os componentes base ficam em `src/components/ui`. Tela nova compõe com eles; não recria botão,
campo ou cartão.

**`AppButton`.** Variantes `primary` (fundo `primary`, texto `onPrimary`), `secondary` (fundo
`surfaceRaised`; dentro de um cartão, `background`, via `SurfaceContext`), `tertiary` (só texto
em `link`), `destructive` (só texto em `critical`), `outline` (transparente, 1 px de
`fieldBorder`) e `outline-destructive` (1 px e texto em `critical`). Em bloco tem 56 de altura
mínima e raio 18; só texto e `outline` têm 48; `compact` é a pílula de 44 com rótulo 15/20. Ícone Feather
de 20, decorativo, antes do rótulo ou depois (`trailing`, que alinha o rótulo à esquerda).
Estados:

- selecionado (`pressed`): fundo `indicator`, texto `onPrimary` e ícone de check. Nunca só a
  cor.
- indisponível (`ariaDisabled`): continua focável, com rótulo em `textMuted` e o motivo ligado
  por `describedBy`. No nativo é o mesmo `Pressable`, com `accessibilityState.disabled`; o toque
  ainda chama `onPress`, e quem chama protege a ação. No web é um
  `<button aria-disabled="true">` de verdade, desenhado à parte: fundo `surface` nas variantes
  cheias e transparente nas de texto e `outline`, contorno sempre em `fieldBorder` (também no
  `outline-destructive`) e rótulo sempre em 17/22, inclusive no `compact`.
- passar o mouse (web): opacidade 0,84.
- toque: escala 0,98 e, nos botões só de texto, opacidade 0,72. No web a transição leva 100 ms
  ao apertar e 160 ms ao soltar. Com movimento reduzido, não há escala.
- com `href`: é um link de verdade no web, desenhado sempre no estado solto, sem efeito de mouse
  nem de toque.

**`AppCard`.** Sem borda, fundo `surfaceRaised`, raio 18, preenchimento 24, espaço interno 16.
Marca o conteúdo como camada `raised` (`SurfaceContext`).

**`AppTextField`.** Rótulo em `supportStrong` acima do campo. Campo de 56 de altura mínima, raio 14,
fundo `surfaceRaised`, borda de 1 px em `fieldBorder`, texto em `body`, placeholder em
`textMuted`. A dica fica abaixo, em `support` e `textMuted`. No erro, a borda passa a 2 px de
`critical` e a mensagem aparece abaixo em `supportStrong` e `critical`, com ícone
`alert-circle` de 16, como `role="alert"` e região viva assertiva. O botão de mostrar senha mostra
só o ícone (olho e olho cortado), num alvo de 48 × 48; o nome acessível é "Mostrar
senha"/"Ocultar senha".

**`AppCheckbox`.** Caixa de 24, raio 6, borda de 2 px. Desmarcada: fundo `surfaceRaised` e borda
`fieldBorder`. Marcada: fundo e borda `primary` com check em `onPrimary`. Com erro: borda
`critical` e mensagem com ícone. A linha inteira é o alvo, com 48 no mínimo, e no web o Espaço
também marca.

**`Chip`.** Estado ou papel por extenso sobre o fundo suave. Pílula de 26 de altura mínima, texto
em `chip`, ícone opcional de 14. A cor e o ícone só repetem o que o texto diz.

**`AppAlert`, `AppStatus`, `AppProgress`.** Ícone mais texto em `supportStrong`. Erro em
`critical` com `alert-circle`, `role="alert"` e região assertiva. Sucesso em `positive` com
`check-circle`, `role="status"`. Andamento em `textMuted` com indicador giratório, nunca com o
check de sucesso. O ícone fica fora da região viva. A região vazia continua montada; no
`AppAlert` e no `AppStatus` ela fica sem ícone, e o `AppProgress` mostra o indicador sempre.

**`AsyncNotice`.** Carregando: texto em `textMuted` mais o `AppSkeleton`. Vazio: ícone `inbox`.
Falha de rede: ícone `wifi-off` em `critical` e `role="alert"`. Os dois últimos trazem título em
`row`, mensagem em `support` e uma ação `secondary`, sobre `surfaceRaised` com raio 18.

**`AppSkeleton`.** Linhas de 18 de altura em `fieldBorder` com opacidade 0,28, raio 8; a última
tem 68% da largura.

**`SectionHeading`.** Rótulo curto acima (em `supportStrong`, `textMuted`, ou `warning` com
ícone quando é um estado), título `h2` em `title` e descrição opcional em `body`.

**`AppNavLink`.** `link`: texto em `button` e `link`, sublinhado ao passar o mouse. `tab`: aba
da barra inferior, com ícone de 22, rótulo em `navigation` e, na aba atual, indicador de 4 × 28
no topo, rótulo em 700 e cor `indicator`. `rail`: item do trilho lateral, com o indicador de 4 px
à esquerda. A rota atual é `aria-current="page"` no web. Fora da aba atual, o rótulo fica em
`textMuted` e acende para `text` ao passar o mouse. Sobre a faixa (`onBand`, no trilho largo do
`AppShell`), o ativo e o mouse usam `onBand`, o resto `onBandMuted`, e o indicador é `onBand`.

**`Scoreboard`.** Placar estático de pastilhas. Tamanho `xl` (pastilha 50 × 80, numeral 64) ou
`lg` (44 × 70, numeral 56), com 6 entre pastilhas, layout `inline` (com "/") ou `stacked`, largura
máxima de 420 e raio 22. As pastilhas encolhem para caber na largura medida do próprio placar,
até 40% do tamanho. Com número real: `role="img"` e um rótulo legível, com as pastilhas fora da
árvore de acessibilidade. Decorativo (`decorative`): inteiro fora dela, com o texto real na tela
ao lado.

**`BrandBand` e `BrandWordmark`.** A faixa da marca (`data-band`, que troca o anel de foco para
`focusOnBand`) e a marca COLETE em `brand`, caixa alta, cor `onBand`.

**Shells.** `AuthShell`: placar decorativo COLETE (`lg`) na faixa, nome do app como texto oculto
no `banner`, `h1` em `display`. `AuthenticatedShell`: `TopBar` com o voltar (botão `tertiary`
com `chevron-left`) ou a marca, e o avatar à direita; no modal, o fechar (`x`) e nenhum avatar.
`trailing` troca o avatar por outro controle ou, com `null`, deixa o canto vazio. Abaixo, o título
`h1` em `display` nas telas de aba ou `heading` nas demais, e o `hero` (o placar da tela);
`intro` troca o título e a descrição quando a tela desenha o próprio topo (ícone e nome do grupo,
avatar e nome do Perfil), e o `title` continua nomeando a página. `AuthenticatedListShell`: o mesmo, com a lista como rolagem.

**`Avatar`.** Iniciais sobre o tom do perfil, em 36, 40, 44 ou 96 (iniciais na condensada).
Sempre decorativo: o nome está ao lado ou no controle que o contém. Com foto, a foto ocupa o mesmo
círculo; se não carregar, voltam as iniciais. Conta excluída usa `surfaceRaised` e `textMuted`.

**`GroupIcon`.** Oito ícones (bola, gol, campo, apito, camisa, troféu, raio, chama) e seis cores.
Ladrilho de 56 com glifo de 32 e raio 16, nas mesmas proporções em outros tamanhos. Todo grupo
começa como bola azul. Sempre decorativo. No web desenha SVG; no nativo, glifos da fonte de
ícones já instalada.

**`OccupancyBar`.** Barra com raio de pílula; altura, cor e trilho são parâmetros. O padrão é 6
de altura. Nos cartões, a parte cheia vai na cor do estado sobre `track`. No placar do Racha, tem
8 de altura, `digit` (ou `digitDim` no cancelado) sobre `scoreTileTop`. Fica fora da árvore de
acessibilidade; a contagem é sempre escrita ao lado.

**`AppIcon`.** Ícone Feather de contorno, sempre decorativo. Nunca fica dentro de um elemento cujo
texto é anunciado ou testado, porque o glifo é um caractere de uso privado.

## Accessibility

Alvo: WCAG 2.2 AA (`docs/15`, `PRODUCT.md`).

- Texto ≥ 4,5:1; texto grande e componentes de interface ≥ 3:1. `src/theme/colors.test.ts`
  calcula a razão de cada par a partir dos tokens, nos dois temas: 51 pares de texto (≥ 4,5:1) e
  21 de componente (≥ 3:1). Cor nova entra como token, com o par dela no teste, antes de virar
  tela.
- Algumas razões do tema escuro, calculadas com `contrastRatio`: `text` sobre `background`
  16,83:1; `textMuted` sobre `surfaceRaised` 7,34:1; `onPrimary` sobre `primary` 10,84:1;
  `digit` sobre `scoreTileTop` 9,47:1; `digitDim` sobre `scoreboard` 5,72:1; `critical` sobre
  `surface` 8,63:1; `fieldBorder` sobre `surfaceRaised` 3,69:1.
- Nenhuma informação só por cor: estado é ícone mais texto, opção selecionada ganha check, aba
  atual ganha indicador e peso.
- Foco visível: anel de 2 px com 2 px de folga, em `focus`, e `focusOnBand` dentro da faixa
  (CSS global de `app/+html.tsx`). Nunca `outline: none` sem substituto.
- Seleção de texto: fundo `text` e texto `background`.
- Controle indisponível continua focável (`aria-disabled`) e diz o motivo.
- Erro de formulário é anunciado (`role="alert"`) e ligado ao campo (`aria-describedby`).
- Movimento reduzido: `useReducedMotion()` (`src/theme/motion.ts`) tira a escala do toque, e o
  CSS global zera animações e transições sob `prefers-reduced-motion: reduce`.
- Texto escala até 200% sem corte. Ícone, avatar, placar decorativo e barra de ocupação ficam
  fora da árvore de acessibilidade.
- Cada tela tem um `h1` e o título da página por rota.

## Do's and Don'ts

- Faça: separe áreas por camada e espaço, não por contorno. A borda fica nos controles (campo,
  caixa de marcação, botões `outline`, pílulas e opções de escolha, ladrilhos do seletor de ícone,
  botão redondo de recusar membro, contorno de mouse do filtro), nos anéis do avatar e do selo de
  câmera e em dois recipientes que já existem: os resultados de endereço de Criar racha e o resumo
  da exclusão de conta (2 px de `critical`; ver divergência 12).
- Faça: um placar por tela, só onde existe número ou código real. Nas telas do app, a única
  exceção é a marca COLETE decorativa na autenticação.
- O catálogo `app/design-system.tsx` é uma vitrine estática dos tokens e componentes, fora destas
  regras de composição: ele mostra dois placares na mesma tela e amostras de cor e de raio com
  borda `fieldBorder`.
- Faça: diga estado, papel e seleção por extenso; cor e ícone só repetem.
- Faça: use os tokens e os componentes base; cor nova nasce em `colors.ts` com o teste de
  contraste.
- Faça: mantenha `testID`, textos de `pt.ts`, rótulos acessíveis e ordem de foco; são contrato da
  suíte e2e.
- Não faça: tema claro na interface, nem seletor de tema.
- Não faça: âmbar ou caixa alta em lugar novo sem registrar aqui; os usos de hoje são os
  listados em Colors e Typography.
- Não faça: sombra no tema escuro.
- Não faça: fonte ou script de CDN; a CSP só aceita os do próprio domínio.
- Não faça: texto dentro de imagem, nem ícone que carregue sentido sozinho.
- Não faça: alvo de toque menor que 48 fora dos controles compactos de 44 já listados.
- Não faça: rolagem fora dos shells.
- Não faça: um visual de app de aposta (preto com verde ou amarelo neon, odds, cassino), de banco
  ou fintech (frio, corporativo, roxo ou azul genérico), o clichê do gramado verde (campo, bola e
  apito como decoração) ou o template genérico de IA (cards brancos, gradiente roxo, Inter em
  tudo). Decisão de César, 13/10/2026.

## Decisões vigentes

- **13/10/2026 — tom e limites da marca** (`PRODUCT.md`): súmula e árbitro; a lista do que o
  visual não pode parecer está em Do's and Don'ts. A identidade é nova, não evolução do verde do
  scaffold.
- **13/10/2026 — Placar premium aprovado** (`docs/29`).
- **14/10/2026 — só tema escuro.** A interface fica no tema escuro, qualquer que seja a
  preferência do sistema, e não há seletor de tema. O `ThemeProvider` fixa `mode = 'dark'`, o
  `app/+html.tsx` entrega `<html data-theme="dark">` e `color-scheme: dark` desde a primeira
  pintura, e a barra de status nativa usa o estilo `light`. Os tokens do tema claro continuam em
  `src/theme/colors.ts` e no teste de contraste, mas não aparecem na interface; não os use em
  tela. O `docs/15` ainda pede os dois temas; até a fatia de documentação que o atualizar, esta
  decisão prevalece sobre aquele trecho.
- **14/10/2026 — rolagem dentro do shell**, mostrar senha só com ícone em 48 × 48 e o placar
  COLETE na faixa da autenticação em todas as larguras (`docs/29` §0).
- **17/10/2026 — prévia aprovada (PR G)**: barra só com Grupos e Agenda, Perfil pelo avatar,
  botões `outline` e `outline-destructive`, controle compacto de 44 e os tokens `*Soft`, `accent`,
  `avatar`, `textSoft`, `on*`, `track` e `divider` (`docs/29` §9). Os PRs H (ícone do grupo,
  `lilac` e `sand`), M6 (notas) e L (times) seguem a mesma seção.
- **19/10/2026 — cores dos coletes dos times** (`team-coletes.ts`).
- **20/10/2026 — ícone do app** redesenhado na paleta, com fundo #0A1120 (`docs/26`).
- **Manifest do PWA** (`public/manifest.webmanifest`): nome e nome curto "Colete",
  `display: standalone`, `orientation: any`, `theme_color` #0A1120 e `background_color` #0A1120,
  ícones de 192 e 512 `any maskable`. A `<meta name="theme-color">` de `app/+html.tsx` também é
  #0A1120 (`colors.dark.background`).

## Divergências para decidir

Em todas, este arquivo registrou o que o código faz. Nenhuma foi corrigida aqui.

1. **Cores do manifest.** O pedido desta fatia cita tema #0A6335 e fundo #F4F8F5. Esses eram os
   valores do scaffold (`2623be3`). Hoje `public/manifest.webmanifest` tem `theme_color` e
   `background_color` #0A1120, desde `c3bf793` (13/10/2026). O #0A6335 só aparece em `docs/26`,
   como o verde antigo do ícone.
2. **Tema claro nos contratos.** O `docs/15` §1 pede contraste "nos dois temas" e o §2 diz "Tema
   claro e escuro de verdade". O `docs/25` §6.3 repete "contrastes nos dois temas" para as fatias
   do M2, e o `PRODUCT.md` (Accessibility & Inclusion) pede AA "nos dois temas". A interface é só
   escura desde 14/10/2026; o teste de contraste continua cobrindo os dois. A fatia de
   documentação prometida em `docs/29` §0 ainda não foi feita.
3. **Alvo de toque.** O `docs/15` pede ≥ 44 × 44. O `PRODUCT.md` diz ≥ 48. O código usa 48
   (`size.target`), mas os controles compactos tocáveis têm 44 (`size.compact`): botão pílula
   (`AppButton compact`, 44 de altura e 48 de largura mínima), avatar do topo
   (`ProfileAvatarLink`, 44 × 44), botão redondo da gestão de membros
   (`GroupMembersScreen.tsx`), amostra de cor (`GroupAppearanceScreen.tsx`) e filtro da Agenda
   (`MatchesListScreen.tsx`). Cumprem o normativo, mas não o "mínimo de 48 × 48".
4. **`app.json` com `userInterfaceStyle: "automatic"`.** No nativo, o que o sistema desenha
   (teclado, alertas, seletores) segue o tema do aparelho, enquanto a interface é só escura.
5. **Lint de acessibilidade.** O `docs/15` §3 diz que `eslint-plugin-react-native-a11y` roda no
   lint de todo PR. O `eslint.config.js` só usa `eslint-config-expo`, e o plugin não está no
   `package.json`.
6. **`data-theme`.** O `docs/29` §4 diz que o `ThemeProvider` grava `data-theme` em `<html>`. No
   código, o atributo é fixo em `app/+html.tsx`, e o `ThemeProvider` não grava nada.
7. **Escala tipográfica.** O `docs/29` §3 lista 10 estilos sem altura de linha. O código tem 19:
   faltam `heading` 28/700, `section` 20/700, `cardTitle` 18/700, `bodyStrong`, `button` 17/700,
   `supportStrong`, `chip`, `caption` e `captionStrong`.
8. **Contagens do `docs/29` §2.** Fala em 25 tokens de cor por tema e 31 pares testados. Hoje são
   42 tokens e 72 pares (51 de texto, um deles repetido, e 21 de componente). O §9 lista os
   tokens novos, mas o §2 não foi atualizado.
9. **Âmbar.** A regra 3 do `docs/29` §1 restringe o âmbar ao numeral, à ação principal e ao
   indicador. O próprio `docs/29` (§5 e §9) e o código o usam também na caixa marcada, no selo de
   câmera, na estrela da nota e no Time A. O código vai além do `docs/29`: bloco de data do cartão
   da Agenda para quem é titular (`MatchCard.tsx`), chip do papel Dono (`group-roles.ts`), número
   da camisa (`profile-view.ts`) e barra de ocupação do placar do Racha (`MatchDetailScreen.tsx`).
   A regra nunca foi reescrita.
10. **Caixa alta fora do placar e da marca.** A regra 6 do `docs/29` §1 reserva a caixa alta ao rótulo do placar
    e à marca. O cabeçalho de semana da Agenda ("Esta semana", "Próxima semana", "Mais adiante")
    usa `typography.overline` e sai em caixa alta (`MatchesListScreen.tsx`, estilo `week`). O
    dia da semana e o mês do bloco de data do cartão ("SÁB", "OUT") também saem em maiúsculas
    (`matchTicket`, `match-format.ts`). As iniciais do avatar são convertidas para maiúsculas
    (`member-initials.ts`).
11. **Margem lateral.** O comentário de `src/theme/spacing.ts` diz "Side margin 24", mas as telas
    autenticadas usam `gutter` 20 desde a prévia; só `AppShell` e `AuthShell` usam 24. O
    `docs/29` não menciona o `gutter`.
12. **Bordas.** A regra 1 do `docs/29` §1 permite borda só no campo de formulário; o §5 aceitou a
    caixa de marcação e o §9 cedeu nos botões `outline`. O código também usa borda nas pílulas de
    escolha do Perfil (`ProfileChoiceField.tsx`) e da nota (`RatingPicker.tsx`), na opção de grupo
    de Criar racha, no ladrilho do seletor de ícone (2 px, `GroupAppearanceScreen.tsx`), no botão
    redondo de recusar membro (`GroupMembersScreen.tsx`), no filtro da Agenda ao passar o mouse,
    nos anéis do avatar e do selo de câmera e em dois recipientes: os resultados de endereço
    (`CreateMatchScreen.tsx`, estilo `results`) e o resumo da exclusão de conta
    (`DeleteAccountCard.tsx`, 2 px de `critical`).
