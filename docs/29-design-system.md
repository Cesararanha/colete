# Design system "Placar premium"

**Documento não normativo.** Registra o design system aplicado ao app em 13/10/2026.
Não está em `docs/spec-manifest.sha256`. Requisitos, contratos e decisões continuam nos
documentos normativos (`docs/01`–`docs/18`, `docs/22`, `docs/25`); onde este texto e um
deles divergirem, vale o normativo.

A especificação visual foi aprovada pelo César em 13/10/2026 e fica fora do
repositório, junto com as 7 telas de referência (390×844). Este documento resume o que
entrou no código e onde está cada coisa.

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
| `ThemeToggle` (novo) | Mesmo nome acessível, mesmo `aria-pressed` e mesmo `testID` do botão antigo. Usa os tokens da faixa e mostra o ícone do tema de destino |
| `BrandBand` (novo) | A faixa do tema claro (`data-band`) e a marca COLETE |
| `SurfaceContext` (novo) | Dentro de um cartão, o botão secundário usa a cor do fundo para não sumir no cartão |
| `AppButton` | Variantes `primary`, `secondary`, `tertiary` (novo) e `destructive`. A opção selecionada (`pressed`) ganha o fundo `indicator` e um ícone de check. A assinatura antiga continua valendo; `icon` e `iconPosition` são opcionais. O toque reduz a escala para 0,98 em 100 ms e volta em 160 ms; com movimento reduzido, não há escala |
| `AppCard` | Sem borda, `surfaceRaised`, raio 18, sombra só no tema claro |
| `AppTextField` | Altura 56, borda `fieldBorder` de 1 px, raio 14. No erro, borda `critical` de 2 px e mensagem com ícone. O botão de mostrar senha fica dentro do campo, com ícone e o mesmo texto |
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
- Ícones do PWA (`public/icons`) na identidade nova. Hoje só as cores do manifesto
  mudaram.
- Contar só grupos não arquivados no placar quando o arquivamento existir. Hoje
  `getOwnGroups` não filtra arquivados, e o arquivamento é pós-piloto.
