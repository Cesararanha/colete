# Design system "Placar premium"

**A referência atual de design é o [`DESIGN.md`](../DESIGN.md) da raiz (11/11/2026).** Este
documento fica como histórico das decisões do "Placar premium" e não é mais atualizado. Onde
ele e o `DESIGN.md` divergirem, vale o `DESIGN.md`; as divergências com o código estão listadas
no fim dele.

**Documento não normativo.** Registra o design system aplicado ao app em 13/10/2026.
Não está em `docs/spec-manifest.sha256`. Requisitos, contratos e decisões continuam nos
documentos normativos (`docs/01`–`docs/18`, `docs/22`, `docs/25`); onde este texto e um
deles divergirem, vale o normativo.

A especificação visual foi aprovada pelo César em 13/10/2026 e fica fora do
repositório, junto com as 7 telas de referência (390×844). Este documento resume o que
entrou no código e onde está cada coisa.

## 0. Decisões de 14/10/2026 (polimento pré-apresentação)

- **Só tema escuro (decisão humana de 14/10/2026).** A interface fica só no tema escuro,
  qualquer que seja a preferência do sistema, e o seletor de tema saiu de todas as telas
  (o componente `ThemeToggle` foi removido). O `ThemeProvider` fixa o modo escuro e o
  `app/+html.tsx` entrega `<html data-theme="dark">` com o CSS global escuro desde a
  primeira pintura. Os tokens do tema claro continuam em `src/theme/colors.ts` e no
  teste de contraste. O `docs/15` ainda pede "tema claro e escuro"; ele é normativo e será
  atualizado numa fatia de documentação. Até lá, esta decisão humana prevalece sobre
  aquele trecho. As regras 3, 4 e 5 da seção 1 e as menções ao tema claro abaixo
  descrevem o tema que segue no código, mas não aparece na interface.
- **Rolagem fantasma.** Cada shell rola dentro do próprio `ScrollView`. O documento tem
  exatamente a altura da janela, e `html`, `body` e `#root` têm `overscroll-behavior:
  none`. Por isso a página não rola nem "quica" quando o conteúdo cabe. A prova está em
  `assertNoPhantomScroll` (`e2e/support/layout.ts`), em 390×844.
- **Autenticação.** O texto lateral do layout largo saiu. O placar COLETE fica na faixa
  em todas as larguras.
- **Mostrar senha.** O botão mostra só o ícone (olho, e olho cortado com a senha
  visível), num alvo de 48×48. O nome acessível continua "Mostrar senha"/"Ocultar senha".
- **Grupos.** Entre o topo e o primeiro grupo ficam só o título e o placar: saíram o
  rótulo "Seus espaços" e a descrição. Cada grupo é uma linha inteira tocável, com nome,
  papel (ícone e texto) e chevron. O nome acessível é "Ver grupo: <nome>". O pedido
  pendente segue com relógio e texto, numa linha da camada `surface`, que não é tocável.
- **Detalhe do grupo.** Os membros aparecem em lista (`MemberRow`): iniciais decorativas,
  nome, papel e estado, cada um com ícone e texto. "Sair do grupo" fica separado das
  ferramentas, como ação destrutiva com ícone, mesmo quando desabilitado para o dono.
- **Gestão de membros.** O `AuthenticatedShell` aceita `back`, um botão de volta acima do
  título ("Voltar ao grupo"). O atalho "Configurações do grupo" aparece só para quem a
  tela de configurações já admite: dono ou organizador ativo.

### Correção dos P1 da revisão do PR #66 — 14/10/2026

Autorizada pelo César depois de `rev66.md`, com rebase sobre o merge do #67
(`a496197`). O rebase foi automático, sem conflitos manuais: os textos e fluxos de
perfil/privacidade do #67 e o polimento do #66 ficaram juntos. Entrar e verificar
cadastro continuam levando a `/grupos`, ou a `/join` com convite pendente.

- Credenciais: o texto “E-mail ou senha incorretos.” exige o código Auth exato
  `invalid_credentials`; código ausente não implica credencial incorreta.
- Quota Auth: HTTP 429, `over_request_rate_limit` e
  `over_email_send_rate_limit` recebem “Muitas tentativas. Aguarde alguns minutos e
  tente de novo.”. Rede e 5xx continuam `TransportError`; as demais recusas mantêm
  o tratamento anterior. `same_password` só nomeia uma recusa de validação na
  recuperação, sem sobrepor o texto de quota.
- Saída: `GroupConfirmation` mostra “Sair de <grupo>?” dentro do detalhe, com
  “Sair do grupo” destrutivo e “Cancelar”. Abrir/cancelar não chama a Edge;
  cancelar devolve o foco e conserva a membership. O dono continua bloqueado;
  confirmação chama a mesma RPC com o mesmo intent idempotente.

Contraprovas no código rebaseado antes das correções: 4 unitários falharam pelos
motivos esperados (ausência de código e quotas); 2 e2e móveis falharam porque o
429 sem código mostrou credenciais incorretas e a saída não tinha confirmação.
Depois das correções, os mesmos 31 unitários relevantes passaram e o e2e prova
zero chamadas ao abrir/cancelar, membership ainda ativa e uma chamada ao confirmar.

Validação medida nesta correção:

- `verify:app`: exit 0, 30 arquivos / 337 testes unitários; 1 aviso de lint herdado
  do #67 (`View` não usado em `PrivacyAccountScreen`), sem erro.
- Auth: 10 passaram / 2 pulados; privacidade: 4 passaram / 4 pulados; grupos: 62
  passaram; CORS web: 4 passaram; smoke: 6 passaram.
- pgTAP: 19 arquivos / 1259 asserções; os 11 harnesses `db:test:*` passaram.
- `test:staging`: 98 passaram; `test:audit`: 94 passaram; `audit:high`: exit 0
  com as 2 exceções ativas existentes, sem mudança de dependência.
- Censo final: `auth.users`, `profiles`, `groups`, `group_members`,
  `idempotency_records` e `invite_rate_limits` em 0. Resíduos de auditoria Auth,
  prova automatizada de rolagem longa e consolidação de tema nos normativos
  permanecem fora desta correção, por decisão humana.

## 1. Regras de composição

1. **Sem contorno.** As áreas se separam por camada (`background` → `surface` →
   `surfaceRaised`) e por espaço. Borda só em campo de formulário (`fieldBorder`).
2. **Um placar por tela**, e só onde existe número ou código real. Perfil, Criar grupo,
   Entrar em grupo e Configurações não têm placar.
3. **Âmbar** só no numeral do placar, na ação principal e no indicador ativo do tema
   escuro. No tema claro a ação principal e o indicador são azul-noite, e o âmbar fica
   só nos numerais.
4. **Tema claro:** uma faixa azul-noite no topo, com raio inferior de 28, e numerais em
   âmbar. No tema escuro a faixa tem a cor do fundo e não aparece.
5. **O placar é igual nos dois temas.**
6. **Caixa alta** só no rótulo do placar e na marca COLETE.
7. **Nenhum comportamento novo.** Rotas, dados, fluxos, `testID`, textos existentes,
   rótulos acessíveis e ordem de foco são os de antes.

## 2. Tokens

| Arquivo | Conteúdo |
|---|---|
| `src/theme/colors.ts` | 25 tokens de cor por tema (`ThemeColors`). `surfaceStrong` virou `surfaceRaised` e `border` virou `fieldBorder` |
| `src/theme/colors.test.ts` | calcula a razão de contraste WCAG de todos os 31 pares da especificação, nos dois temas, e confere que o placar é igual nos dois |
| `src/theme/spacing.ts` | espaço `4·8·12·16·24·32·40`, raios (`tile` 8, `field` 14, `row` 18, `scoreboard` 22, `band` 28, `pill`) e tamanhos (alvo 48, botão 56, campo 56) |
| `src/theme/typography.ts` | famílias e escala tipográfica (seção 3) |
| `src/theme/elevation.ts` | sombra apenas no tema claro (cartão e barra de navegação) |
| `src/theme/motion.ts` | `useReducedMotion()` |

O teste calcula a razão de cada par a partir dos tokens. Os valores da tabela da
especificação servem só de conferência. Pares que a especificação marca como ausentes em
um tema também são testados nesse tema, e todos passam.

## 3. Tipografia e fontes

- Barlow 400, 600 e 700 na interface. Barlow Condensed 700 nos numerais do placar e na
  marca.
- Cada peso é importado por subcaminho (`@expo-google-fonts/barlow/400Regular` etc.), e
  só esses quatro arquivos `.ttf` entram no bundle. Nada vem de CDN: a CSP `font-src
  'self'` continua como estava.
- `app/_layout.tsx` chama `useFonts` com `font-display: swap` e nunca espera a fonte para
  renderizar. No web, cada família é uma pilha que termina na fonte do sistema com o peso
  correto, então o texto aparece de imediato e troca para a Barlow quando ela carrega.
- `body { font-synthesis: none }` em `app/+html.tsx` impede o navegador de engrossar uma
  face que já é negrito.
- Escala: placar 64, código do convite 56, marca 24 (+3), display 32/700, título 22/600,
  linha 18/600, corpo 17/400, apoio 15/400, rótulo do placar 13/600 em caixa alta,
  navegação 13/600.

## 4. Foco e superfícies do navegador

O anel de foco tem 2 px com 2 px de folga e é definido no CSS global de `app/+html.tsx`,
gerado a partir dos tokens. Ele segue o tema do app pelo atributo `data-theme`, que o
`ThemeProvider` grava em `<html>`, e não só a preferência do sistema. Dentro da faixa
(`data-band`) o anel usa `focusOnBand`. A seleção de texto também segue o tema. O CSS
global é um `<style>` e não um `<script>`, então os hashes de script da CSP não mudam.

## 5. Componentes (`src/components/ui`)

| Componente | O que mudou |
|---|---|
| `Scoreboard` (novo) | Placar estático com grupos de caracteres, grupo de referência em `digitDim`, tamanhos `xl` (64) e `lg` (56) e layouts `inline` (com "/") ou `stacked`. Placar com número real tem `role="img"` e rótulo legível; as pastilhas ficam fora da árvore de acessibilidade. Placar `decorative` fica inteiro fora dela. As pastilhas encolhem em telas estreitas (320 px) |
| `AppIcon` (novo) | Ícone Feather sempre decorativo. Fica fora de elementos com `role` ou `testID` cujo texto é anunciado ou testado, porque o glifo é um caractere de uso privado |
| `ThemeToggle` | Removido em 14/10/2026 (seção 0) |
| `BrandBand` (novo) | A faixa do tema claro (`data-band`) e a marca COLETE |
| `SurfaceContext` (novo) | Dentro de um cartão, o botão secundário usa a cor do fundo para não sumir no cartão |
| `AppButton` | Variantes `primary`, `secondary`, `tertiary` (novo) e `destructive`. A opção selecionada (`pressed`) ganha o fundo `indicator` e um ícone de check. A assinatura antiga continua valendo; `icon` e `iconPosition` são opcionais. O toque reduz a escala para 0,98 em 100 ms e volta em 160 ms; com movimento reduzido, não há escala |
| `AppCard` | Sem borda, `surfaceRaised`, raio 18, sombra só no tema claro |
| `AppTextField` | Altura 56, borda `fieldBorder` de 1 px, raio 14. No erro, borda `critical` de 2 px e mensagem com ícone. O botão de mostrar senha fica dentro do campo e mostra só o ícone (seção 0) |
| `AppCheckbox` | Caixa de 24 com `fieldBorder`. Marcada: fundo `primary` e ícone de check |
| `AppNavLink` | Variantes `link`, `tab` (barra inferior) e `rail` (lateral larga). O item ativo tem indicador de 4 px e rótulo mais forte |
| `AppAlert`, `AppStatus`, `AsyncNotice`, `AppSkeleton`, `SectionHeading` | Só tokens. Todo estado mostra ícone e texto |
| `AppShell`, `AuthenticatedShell`, `AuthShell` | Barra superior sem borda, faixa no tema claro e navegação na mesma posição do DOM. O `AuthenticatedShell` aceita um `hero` opcional (o placar da tela) dentro da faixa |

## 6. Telas

| Tela | Placar | Fonte do dado |
|---|---|---|
| Grupos | grupos ativos `NN / 05` | tamanho de `getOwnGroups`, só memberships `active`. O limite vem de `MAX_ACTIVE_GROUPS = 5` (`src/features/groups/group-limits.ts`, D6 de `docs/09`; confere com `private.app_limits` da `0015`). Pedido pendente aparece com relógio e `pt.groups.list.pending` |
| Detalhe do grupo | membros ativos `NN` | a leitura `getGroupMembers` que a tela já fazia, filtrada por `status === 'active'`. Sem capacidade, porque o contrato não traz esse dado |
| Convites | código 5 + 5, decorativo | `InviteShare.code`. O `Text selectable testID="invite-code"` continua logo abaixo do placar |
| Autenticação | marca COLETE, decorativa | — (o nome "Colete" continua como texto na região `banner`) |
| Demais telas | — | só tokens, tipografia e ícones |

O catálogo `app/design-system.tsx` (código em `src/features/design-system/`) é estático e
não tem dado de usuário. Ele tem a mesma política de acesso de `/foundation` e um link
discreto no fim dela.

## 7. Escolhas onde a especificação e o contrato se cruzaram

- **Convites:** o placar do código fica no cartão, logo acima do texto selecionável, e
  não na faixa do topo. O material do convite é carregado dentro do cartão, e o código
  precisa ficar visível e selecionável junto do placar.
- **Convites → Pedidos:** a linha "Pedidos" da referência não entrou. Seria um link novo
  para `/grupos/[groupId]/membros` na tela de convites, ou seja, navegação nova.
- **Títulos:** o `h1` de cada tela continua sendo o título atual. A referência mostra o
  nome do grupo no topo, mas isso mudaria a hierarquia de cabeçalhos testada.
- **Rótulos curtos acima dos títulos:** os textos de `pt.ts` continuam, mas sem caixa
  alta, que ficou reservada ao rótulo do placar.
- **Textos novos em `pt.ts`:** `groups.list.activeOverline` e `activeCount`,
  `groups.detail.activeMembers` e o bloco `designSystem`. Os rótulos acessíveis do placar
  não existiam antes.
- **`e2e/m0-a-smoke.spec.ts`:** a cor esperada da ação principal no tema escuro passou a
  ser a do token novo (`#FFB940`).

## 8. Depois da apresentação

- Vibração (`expo-haptics`).
- Virada animada do placar (240 ms por dígito, 60 ms entre dígitos; com movimento
  reduzido, troca instantânea).
- Contagem de membros na lista de grupos, capacidade do grupo no detalhe e contagem de
  pedidos na tela de convites. Todas dependem de contrato novo.
- Contar só grupos não arquivados no placar quando o arquivamento existir. Hoje
  `getOwnGroups` não filtra arquivados, e o arquivamento é pós-piloto.

## 9. Prévia aprovada (PR G, 17/10/2026)

O César aprovou seis telas de referência (Agenda, Grupo, Racha, Membros, Perfil e Ícone
do grupo), itens 5, 12, 13, 14 e 15 do feedback do teste. Onde esta seção e as seções
anteriores divergem, vale esta seção, que é a decisão mais recente.

- **Navegação.** A barra tem só Grupos e Agenda. O Perfil abre pelo avatar com iniciais
  no topo, à direita, em toda tela autenticada (`ProfileAvatarLink`, link para `/perfil`,
  nome acessível "Abrir perfil de <nome>"). O topo de cada tela tem o voltar, ou a marca
  COLETE na primeira tela de uma aba, e o avatar. O topo fica fora do `main`, com
  `role="banner"`. O modal Criar racha não tem avatar. As abas usam `backBehavior:
  "history"`, então o "Voltar" do Perfil volta à aba de onde ele foi aberto.
- **Botões com contorno.** A regra 1 da seção 1 ("sem contorno") cede nos botões da
  prévia. `AppButton` ganhou as variantes `outline` e `outline-destructive` (1 px de
  `fieldBorder` ou `critical`) e a opção `compact` (pílula de 44 px).
- **Tokens novos** (`src/theme/colors.ts`): `positiveSoft`, `warningSoft`, `infoSoft`,
  `criticalSoft`, `primarySoft`, `accent`, `accentSoft`, `avatar`, `textSoft`,
  `onPositive`, `onWarning`, `track` e `divider`; o PR H acrescentou `lilac`,
  `lilacSoft`, `sand` e `sandSoft`. O teste de contraste calcula cada par
  de texto sobre fundo (≥ 4,5:1) e cada barra sobre o trilho (≥ 3:1), nos dois temas. No
  tema escuro, o menor par de texto novo é 6,5:1.
- **Avatar.** Iniciais sobre um de 5 tons, escolhido de forma fixa pelo id do perfil
  (FNV-1a, `avatar-tone.ts`). O avatar é sempre decorativo: o nome está ao lado dele, ou
  no controle que o contém. Conta excluída usa a camada neutra. Com foto (`0030`), a foto
  ocupa o mesmo círculo (`PhotoAvatar`) e, se não carregar, volta às iniciais. No Perfil, o
  avatar de 96 é o botão "Foto de perfil", com o selo de câmera em `primary` e anel na cor
  do fundo como único sinal de que abre as opções; elas aparecem abaixo do e-mail, em
  pílulas `outline` compactas, sem texto de ajuda.
- **Ícone do grupo.** O dono escolhe o ícone (bola, gol, campo, apito, camisa, troféu,
  raio ou chama) e a cor (azul, verde, laranja, rosa, lilás ou areia) na tela "Ícone do
  grupo", aberta por Configurações (PR H, `0027`). Azul, verde, laranja e rosa usam
  `info`, `positive`, `warning` e `accent` com o fundo `*Soft`; lilás e areia têm
  `lilac`/`lilacSoft` e `sand`/`sandSoft`. O glifo sobre o fundo suave passa de 4,5:1 nos
  dois temas (no escuro, o menor é 7,5:1, azul). `GroupIcon` desenha os SVGs da prévia no
  web e glifos da fonte de ícones já instalada no nativo. Todo grupo começa como bola
  azul. Com foto (`0030`), `GroupPhotoIcon` põe a foto no mesmo ladrilho, com o mesmo
  raio; a página do convite usa só `GroupIcon`.
- **Notas (PR M6, `0031`).** A escolha de 1 a 5 é um grupo de rádio de pílulas de 48 px
  com estrela e número na condensada; a escolhida ganha `indicator` e o check, nunca só a
  cor. A escolha é rascunho: "Salvar nota" grava, para as setas não enviarem uma nota por
  passo. "Sem nota" é chip `warning`; a nota atual, chip neutro com estrela. A visibilidade
  usa as pílulas `outline` com `aria-pressed`, e "Minha nota" uma linha `surface` com a
  estrela em `digit`.
- **Times do sorteio (PR L, `0032`).** No Racha, a seção "Times" vem depois de
  Confirmados, com o título de seção e sem rótulo acima. Cada time é um cartão na camada
  `surface` com uma faixa de 6 px à esquerda na cor do colete: Time A âmbar (`digit`, o
  dígito do placar), B azul (`info`), C verde (`positive`) e D rosa (`accent`). O nome
  ("Time A") usa a condensada de 24 px; abaixo, a cor dita em palavras ("Colete âmbar")
  na mesma cor, porque é qual colete vestir, e a contagem. "Sem time" usa a faixa
  `fieldBorder`. A escolha de 2, 3 ou 4 times são pílulas `outline` compactas com
  `aria-pressed` e o check do `AppButton`; "Times desatualizados" é um chip `warning`. Os
  jogadores de cada time vêm por nome, nunca na ordem das notas, e tamanhos diferentes
  pedem confirmação na própria tela. No tema escuro, a menor cor de colete sobre `surface`
  passa de 4,5:1 (`team-coletes.test.ts`).
- **Placares.** A Agenda e o Grupo perderam o placar. O Racha mantém um: confirmados
  sobre vagas, com o chip de estado e a barra.
- **Dados que a prévia mostra e o contrato não tem:** posição na fila no cartão da Agenda
  (só o detalhe a tem), racha cancelado, apelido e posição nos pedidos e na lista de
  membros (`get_group_members` traz só `display_name`, que já é o apelido quando existe).
