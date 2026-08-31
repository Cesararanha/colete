# Colete — Mapa de telas e fluxos (v1)

**Especificação funcional completa das telas do produto real**, sem decisões visuais.
25/08/2026 — substitui a especificação antiga de 6 telas (recorte de faculdade, mantido
no histórico do projeto). Fonte das regras: `01-requisitos.md` · `10-schema-db.md`.

**25 telas: 4 de autenticação, 11 de jogador, 10 de organizador.**

---

## 0. Regras globais (valem para toda tela — não se repetem abaixo)

**Estados obrigatórios:** toda tela tem *carregando* (esqueleto, nunca spinner em tela
cheia), *erro de rede* (mensagem honesta + botão tentar de novo — nunca confirmação
otimista em ação de corrida), e *vazio* (com explicação e ação, nunca tela em branco).

**Acessibilidade (critério de aceite, não etapa):** rótulo em todo campo e ícone · foco
visível · erro anunciado por leitor de tela · toque mínimo 44×44 · contraste ≥ 4.5:1 nos
dois temas · sem informação só por cor · respeita `prefers-reduced-motion`.

**Tela larga (web ≥ ~768 px):** abas inferiores viram navegação lateral; conteúdo com
largura máxima; QR Code vira secundário (copia-e-cola principal); upload aceita arrastar
e soltar.

**Papéis na mesma tela:** organizador vê a tela do jogador **mais** blocos extras —
nunca uma tela paralela. O que é só dele está marcado 🔧 abaixo.

---

## 1. Arquitetura da informação

```
Colete
│
├── NÃO AUTENTICADO
│   ├── 1. Entrar
│   ├── 2. Criar conta
│   ├── 3. Verificar código (OTP)
│   └── 4. Esqueci minha senha
│
└── AUTENTICADO ── abas: Rachas · Grupos · Perfil ── 🔔 sino global no cabeçalho
    │
    ├── 🏟 RACHAS (aba inicial)
    │   ├── 5. Estado vazio
    │   ├── 6. Lista de rachas
    │   └── 7. Detalhe do racha
    │       ├── 8. Pagamento (bloco/modal)
    │       ├── 9. Times publicados + trilha
    │       ├── 🔧 19. Painel do organizador
    │       ├── 🔧 20. Aprovar comprovante
    │       ├── 🔧 21. Avaliar jogadores
    │       ├── 🔧 22. Sortear e publicar
    │       └── 🔧 23. Cancelar racha
    │
    ├── 👥 GRUPOS
    │   ├── 10. Lista de grupos
    │   ├── 11. Detalhe do grupo (membros · histórico)
    │   ├── 12. Entrar com código / convite pendente
    │   ├── 🔧 16. Criar grupo
    │   ├── 🔧 17. Gestão de membros
    │   ├── 🔧 18. Criar/editar racha
    │   ├── 🔧 24. Convites do grupo
    │   └── 🔧 25. Configurações do grupo
    │
    ├── 👤 PERFIL
    │   ├── 13. Meus dados (+ vínculo de contas)
    │   ├── 14. Preferências de notificação
    │   └── (Sair · Excluir conta)
    │
    └── 🔔 15. Central de notificações
```

---

## 2. Autenticação

### 1 · Entrar
E-mail + senha (mostrar/ocultar) · **Entrar** · Google · esqueci a senha · criar conta.
No beta PWA, Apple fica fora: entra junto do app nativo/publicação em loja. Se o OAuth
não trouxer nome suficiente, o próximo passo obrigatório é completar o perfil.
Estados extra: erro de credencial acima do formulário, sem limpar campos.

### 2 · Criar conta
| Campo | Validação |
|---|---|
| Nome | obrigatório, mín. 2 caracteres (sem exigir sobrenome) |
| E-mail | obrigatório, formato válido, normalizado |
| Senha | mín. 8 caracteres, indicador de força |
| Confirmar senha | idêntica |
| Aceite LGPD | obrigatório, links para Termos e Política |

Comportamento: valida ao sair do campo; após 1º erro, o campo valida em tempo real;
botão sempre habilitado (ao tocar com erro, foco vai ao primeiro campo inválido);
mensagem diz o que fazer, não o que está errado.

### 3 · Verificar código (OTP)
6 dígitos digitáveis (decisão D15 — link não autentica PWA no iOS) · reenviar com
contagem regressiva · erro de código inválido/expirado.

### 4 · Esqueci minha senha
E-mail → OTP → nova senha. Mesmos padrões da tela 2.

---

## 3. Jogador

### 5 · Rachas — vazio
"Nenhum racha à vista" + explicação ("você entra em grupo por convite") +
**Entrar com código** (principal) · Criar meu grupo (secundária).

### 6 · Rachas — lista
Linha do tempo dos próximos rachas de todos os grupos, do mais próximo ao mais distante.
Card: dia/hora · grupo · local · ocupação · **etiqueta de situação** + ação contextual:

| Situação | Etiqueta | Ação no card |
|---|---|---|
| Lista não abriu | "Abre quinta, 20h" | contagem regressiva |
| Janela de mensalistas (não sou) | "Abre para todos às 20h30" | contagem |
| Aberta, estou fora | "6 vagas" | **Entrar na lista** |
| Titular sem pagar | "Falta pagar · vence em 2h" | **Pagar** |
| Comprovante em análise | "Em análise" | — |
| Titular pago | "Titular ✓" | — |
| Reserva | "3º reserva" | Sair da fila |
| Promovido com prazo | "Sua vaga! Pague em 27 min" | **Pagar agora** |
| Vaga aberta, sem fila | "1 vaga · reserve por 10 min" | **Reservar vaga** |
| Reserva de vaga ativa | "Reservada para você · 08:42" | **Pagar agora** |
| Lista fechada (pós-T2), estou fora | "Lista fechada" | — |
| Times publicados | "Time 2" | Ver times |
| Cancelado | "Cancelado" | — |

### 7 · Detalhe do racha
Blocos, de cima para baixo: cabeçalho (data, horário, grupo) · local + **abrir no mapa** ·
situação da lista (barra de ocupação, prazos T1/T2 como contagens) · **titulares**
(numerados, foto, situação de pagamento: pago ✓ · em análise · pendente) · **reservas**
(posição do usuário destacada) · **goleiros** (lista própria; mostra se goleiro paga e
quanto) · valor e pagamento (bloco 8) · **ação principal fixa no rodapé**, mudando com a
situação (Entrar na lista · Pagar · Enviar comprovante · Sair da lista · Ver times).
Todos veem quem está na lista e quem pagou (regra do produto).
Organizador vê também o bloco 🔧 19.

O bloco **Meu financeiro** mostra ciclos/versões, resolução, obrigação e estorno em ordem.
Evento aceito/`refunded` oferece **Contestar registro** e exibe estado, resposta e eventos.
Após decisão de primeira instância, mostra resultado, prazo absoluto de sete dias e ações
**Aceitar decisão** / **Apelar ao suporte**. Apelação é única; depois do prazo ou decisão
Admin, a tela mostra `final`. É o caminho citado por N23, N27 e N28. Outro participante nunca
vê motivo, referência ou histórico financeiro individual.

Quem está fora ou na espera vê o valor, mas não chave/QR/recebedor completos. O bloco Pix
só é carregado por RPC para organizador, starter ou claim válida.

Depois de T1, a ação **Pagar** só aparece para quem tem uma reserva de vaga ativa. Se a
fila estiver vazia, **Reservar vaga** chama o servidor primeiro; só depois do sucesso o
app exibe o Pix e a contagem de 10 min. Pagamento no banco, sozinho, não cria vaga.

### 8 · Pagamento (bloco do detalhe / modal)
Valor da MINHA lista (linha ou goleiro — podem diferir; goleiro isento vê "isento") ·
nome e cidade do recebedor · QR Code Pix com valor embutido · **copia-e-cola** (principal
em tela larga) · enviar comprovante (câmera/galeria/arquivo; imagem ou PDF) · aviso LGPD
no upload (finalidade + retenção de 7 dias) · estado "em análise" com prazo absoluto.
O prazo exibido é absoluto e vale `max(envio + 2h, T1)`; a tela explica que o SLA do
organizador é 2h, mas envio cedo não perde vaga antes do prazo geral.
O envio é uma sessão em duas etapas: o app cria a sessão, envia por endpoint Edge autenticado
(sem URL/token/path de Storage no cliente) e confirma;
só a confirmação concluída muda o estado. SHA transitório/fingerprint e metadados são
calculados no servidor; nenhum deles aparece na tela/API.
Erros: reserva expirada antes do envio · upload interrompido (retomar/tentar de novo com
a mesma operação) · arquivo grande demais · formato inválido · sessão expirada.

### 9 · Times publicados
Um cartão por time (Time 1, Time 2…) com jogadores — mostra **posição preferida** como
info (D9), nunca a nota. Goleiros à parte. Indicador discreto de equilíbrio (sem
números de nota). **Trilha de auditoria** recolhível, visível a todos: nº de sorteios,
trocas manuais, adições manuais, alterações de estrela no dia (**sem valores** — D7),
republicações, quem/quando.

### 10 · Grupos — lista
Todos os grupos (inclusive sem racha marcado) + selo do meu papel (dono/organizador) e
selo mensalista quando houver. Ações: abrir grupo · **Criar grupo** · Entrar com código.

### 11 · Detalhe do grupo (membro)
Foto/nome · membros (nomes e papéis; mensalista visível se o grupo usa) · **histórico de
rachas** (passados e cancelados) · **minha nota neste grupo**, sempre visível para mim,
inclusive durante a retenção após remoção, com versão e caminho para contestar. O detalhe da
contestação mostra alvo, resposta, SLA, escalonamento e resolução; se a configuração for “membros”, a lista mostra também as
notas atuais dos membros ativos, nunca o histórico · sair do grupo (bloqueado para o dono, com explicação
"transfira a titularidade primeiro").
🔧 Organizador vê também: criar racha · gestão de membros · convites · configurações.

### 12 · Entrar com código / convite por link
Dois estados que não se confundem:

- **Convite de grupo:** campo de código ou link → confirmação ("Entrar no Racha da
  Firma?") → **aguardando aprovação** até o organizador decidir; N16 ao aprovar.
- **Convite avulso de racha:** link mostra grupo, data, local, valor e aviso "você entra
  só neste racha" → autenticação, se necessária → confirmação → consumo atômico e detalhe
  do racha; não cria membership nem entra em espera.

Erros: código inválido · convite revogado/expirado/já usado · racha sem vaga/cancelado.
O token não entra em analytics, Sentry, título da página nem storage persistente do app.

### 13 · Perfil — meus dados
Nome, apelido, foto, posição preferida (com texto: "aparece no cartão do time"), perna,
número da camisa · **Vínculo de contas**: conectar/desconectar Google no beta (Apple
quando houver app nativo) · trocar senha · **Sair** · **Excluir conta** (com explicação
da anonimização LGPD, dupla confirmação; bloqueada para dono/caso financeiro sem substituto,
com aviso acionável "transfira a titularidade/caso antes"; grupo realmente solo e sem caso
é arquivado). Vincular um provedor exige reautenticação e confirmação explícita
quando o e-mail já estiver associado a outro perfil. **Baixar meus dados** mostra
`preparando|pronto|expirado`, exige reautenticação para um download único em até 24 h e
explica exclusões. A exclusão vira pedido acompanhado: ao confirmar, o acesso é bloqueado
imediatamente; limpeza de Storage/Auth pode concluir por retry sem reabrir a conta.

### 14 · Preferências de alertas externos
Interruptor de **push/e-mail por tipo de evento** (lista abriu, prazo do Pix, times
publicados…). A tela explica: “A Central mantém o histórico; estes controles alteram somente
alertas fora do app”. Eventos de segurança/financeiros obrigatórios aparecem ligados e
bloqueados; os demais podem desligar canais externos individualmente. Categorias visuais
ajudam a localizar eventos, mas não substituem a preferência granular.
**Lembretes do jogo** é um único interruptor: ligado envia push nas duas instâncias fixas;
desligado suprime ambas. Os dois registros permanecem na Central. Não há subtoggles.
No iOS/PWA sem push: aviso claro + botão "como instalar o app na tela inicial" (guia
ilustrado). A Central continua recebendo os registros mesmo sem push.

### 15 · Central de notificações (sino)
Lista das notificações com não-lidas — a rede de segurança de quem está sem push (D13).
Cada item leva à tela do evento.

---

## 4. Organizador 🔧

### 16 · Criar grupo
Nome + foto → cria e já abre a tela 24 (convites) com o convite pronto para compartilhar.
Limite: 5 grupos ativos (erro claro ao estourar).

### 17 · Gestão de membros
Três listas: **pendentes de aprovação** (aprovar/recusar — a mais visível quando não
vazia) · **membros** (promover/rebaixar organizador — só o dono; expulsar, com
confirmação e aviso "sai das listas de rachas futuros; pagamento vira a devolver; times
já publicados que incluam a pessoa precisarão ser sorteados novamente";
selo **mensalista** liga/desliga — só aparece se o grupo tem mensalista habilitado) ·
**convidados avulsos** de rachas futuros.
Expulsão fica desabilitada com motivo se houver comprovante em análise; primeiro é preciso
aprovar/rejeitar e, se aprovado, registrar a obrigação de estorno.

### 18 · Criar/editar racha — a tela mais complexa do app
Seções, com tudo pré-preenchido do racha anterior:

1. **Quando** — data, início, término. Recorrência: liga/desliga ("toda quinta") e edição
   de regra/template/recebedor futuro, com resumo “vale para o próximo ainda não criado”.
   Desligar mostra o eventual próximo já gerado: sem participação ele é cancelado; com efeito,
   exige confirmação e usa o cancelamento financeiro normal. A série nunca edita o racha atual.
2. **Onde** — nome do local + endereço.
3. **Vagas de linha** — por capacidade de time (N por time → total múltiplo) ou total
   livre.
4. **Goleiros** — quantidade (0 = sem lista de goleiro) · **goleiro paga?** (não/sim) ·
   se sim, **quanto** (pré-preenchido com o valor da linha, editável).
5. **Pagamento** — valor por jogador de linha · tipo e chave Pix · nome e cidade do
   recebedor. Esses dados ficam travados quando a lista abre.
6. **Horários da lista** (bloco recolhido, padrões visíveis) — abertura geral (T0) ·
   início da prioridade de mensalistas (TP, se habilitada) · prazo de pagamento (T1,
   "3 h antes do jogo") · fechamento (T2, "1 h antes") — tudo em tempo **relativo ao
   jogo**.
7. **Frase-resumo gerada:** *"A lista abre terça às 20h, o pagamento vence quinta às 17h
   e a lista fecha quinta às 19h."*

Validações: TP ≤ T0 < T1 < T2 < início (mensagem clara) · valor > 0 · vagas > 0 ·
recebedor Pix completo.
**Edição com lista aberta:** local/horário editáveis (push obrigatório a todos) · Pix
nunca muda depois de T0 · valor com pagamento real só destrava quando todos os ciclos estão
devolvidos e sem contestação (campo com caminho: registrar estorno); o novo valor cria nova
versão · mudança de horário mostra antes de salvar o resumo de claims, provas, purge e
lembretes recompostos; promessa ativa nunca é estendida ·
TP/T0 travados depois de TP · T1/T2 travados depois de aplicados · data nunca (cancela e
cria outro).

### 19 · Painel do organizador (bloco no detalhe do racha)
**Financeiro:** esperado · arrecadado · pendente · presumido (mensalistas, separado).
Obrigações **a devolver** mostram ciclo/resolução, valor e ação **Registrar como
devolvido** (data + referência opcional, confirmação dura); o jogador será orientado a
conferir no banco, porque o app não verifica o estorno.
**Fila de trabalho:** comprovantes aguardando (→ tela 20, com SLA de 2h e prazo absoluto) ·
**contestações financeiras** abertas/respondidas (SLA, parte, ciclo/evento, ação Responder e
decisão de primeira instância; janela de apelação fica visível, sem delete) · **casos
transferidos/apelados** mostram autoridade atual e histórico; Admin não usa
este painel, apenas a projeção operacional externa daquele caso ·
**adicionar jogador manualmente** (busca membro; habilitado somente após T2, antes do
início e sem times atuais publicados; pagante recebe reserva de até 30 min e aviso) ou **gerar link de convidado
avulso** (exceção auditada à corrida, sempre limitada à capacidade) · remover jogador ·
botão **Avaliar jogadores** (com "faltam N") ·
botão **Sortear times** (desabilitado com motivo explícito: "2 sem estrela · 1 pagamento
pendente") · **Cancelar racha**. Bloco **Saúde das automações** mostra último T1/T2,
avisos de atraso e ação protegida **Reconciliar agora**; toda execução manual vai para o
ledger operacional e para a trilha sanitizada do racha.
Remover alguém depois da publicação exige confirmação explícita: a escalação atual some,
a versão anterior fica no histórico e o painel direciona para avaliar/sortear/publicar de novo.

### 20 · Aprovar comprovante
Imagem/PDF em tela cheia carregada por stream autenticado sem cache/link compartilhável ·
dados esperados lado a lado (valor, chave, recebedor) · alerta
apenas para duplicata binária exata detectada pelo fingerprint HMAC do servidor (não é OCR nem prova
de fraude; sinal restrito ao mesmo grupo e sem identificar a outra origem) · **Aprovar** · **Rejeitar** (pede motivo curto, salvo no detalhe privado; push apenas aponta para ele) ·
**Marcar pago sem comprovante** (dinheiro/maquininha). A decisão mostra o estado atual e
trata repetição da mesma ação como sucesso idempotente; aprovação e marcação externa são
mutuamente exclusivas. Se outra resolução vencer, a prova aparece “resolvida por outro meio”
e as ações ficam indisponíveis; conflito real pede atualização.
Se o prazo LGPD já removeu o arquivo, a tela não simula preview: mostra “evidência
expurgada”, orienta conferir outra fonte (como o extrato do recebedor) e exige confirmação
dura + motivo para aprovar ou rejeitar. O caso aparece como incidente na saúde operacional.

### 21 · Avaliar jogadores (estrelas)
Lista dos membros com o widget 1–5 · quem falta destacado no topo ("3 sem nota — o
sorteio não roda sem isso") · convidado avulso incluído · goleiro aparece como opcional ·
aviso de visibilidade ("as notas são privadas neste grupo") · alterações no dia com lista
fechada disparam aviso: "isso vai aparecer na trilha pública (sem o valor)".

### 22 · Sortear e publicar
Escolhe o nº de times → **Sortear** (roda no servidor) → proposta na tela: cartões por
time; para o organizador, com as notas e as médias visíveis; tamanhos inevitavelmente
desiguais aparecem antes da confirmação → **Sortear de novo** (contador visível: "3º
sorteio — fica na trilha") · **Ajustar na mão** por arrastar **ou** por "Mover para o
Time…" em um **rascunho**. Ele pode ficar momentaneamente 2/4, anuncia contagens/erro e
bloqueia Publicar até cada pessoa aparecer uma vez e os tamanhos finais serem válidos;
somente o commit grava um `manual_move` por pessoa alterada →
**Publicar** (confirmação: "congela as notas e avisa todo mundo") → push a todos.
Republicar depois de publicado: exige refazer o sorteio, registrado (regra do
congelamento). A proposta informa a versão do algoritmo (v3) e um identificador opaco do
sorteio; semente, notas e snapshot integral continuam privados.

### 23 · Cancelar racha
Confirmação dura: motivo opcional + lista de quem pagou marcada **"a devolver"** com
valor total + seção separada de comprovantes ainda em análise + quantidade de claims/uploads
que serão cancelados + aviso "o app não devolve dinheiro — combine o estorno; quem já pagou
no banco deve avisar" → push a todos.

### 24 · Convites do grupo
Código do grupo (copiar) · link de convite (compartilhar; revogar/regenerar) · link de
**convidado avulso** por racha (escolhe o racha, validade nunca posterior ao início e
limite de usos; convidado entra fora da corrida, somente se houver capacidade). No
resgate pós-T1, a tela reserva a vaga e só então busca o Pix por projeção fresca, mostrando
uma contagem de até 30 min; antes de
T1, mostra o prazo geral. É a única autorização de autoatendimento que pode sobreviver a
T2; convite vencido, revogado, consumido, times atuais publicados ou racha cheio não revela Pix.

### 25 · Configurações do grupo
Nome/foto · **mensalista habilitado?** (toggle — desligado por padrão; ao ligar, explica
janela e pagamento presumido) · **visibilidade das notas** (privadas, padrão; ou visíveis
aos membros ativos — nunca públicas na internet; só o dono altera, e tornar visíveis exige confirmação com
explicação) · **transferir titularidade** (só o dono; escolhe membro, dupla confirmação) ·
**arquivar grupo** (só o dono).

---

## 5. Fluxos críticos (com caminhos de erro)

**F1 · Entrar na lista (a corrida)**
Push "lista abriu" → card → Entrar na lista → servidor decide →
✅ "Você é titular" (pagamento pendente, prazo visível) | 🟡 "Lotou — você é o 3º reserva"
| 🔴 rede falhou → erro honesto + tentar de novo (o mesmo `request_id` devolve outcome
seguro, sem criar outra inscrição; Pix é buscado de novo apenas se ainda autorizado).
Mensalista na janela: entra direto como titular-presumido.

**F2 · Pagar**
Antes de T1: detalhe → copia Pix (ou QR) → paga no banco → volta → inicia upload →
confirma o envio → "em análise" (prazo `max(envio+2h,T1)`) → push "aprovado" → Titular ✓.
Depois de T1: primeiro **Reservar vaga** (ou receber promoção); o Pix só é liberado por
`get_payment_instructions` após
a reserva atômica, com 10 ou 30 min visíveis. Pagamento no banco sem reserva não garante
entrada e exige tratamento manual pelo organizador.
Erros: rejeitado antes de T1 → mantém vaga e pode reenviar; rejeitado em/após T1 → libera
e volta à fila normal · prazo `max(envio+2h,T1)` sem decisão → sai da titularidade e entra
na faixa prioritária da espera, sem desalojar quem
já ocupa uma vaga válida · sessão/upload falhou → reutilizar a sessão ainda válida e pedir
novo token; sessão expirada nunca é renovada.

**F3 · O prazo T1 acontece (automático)**
T1 chega → quem está `pendente` sem comprovante perde a vaga (push "você perdeu sua vaga
— entre novamente pela fila") → 1º reserva promovido com reserva de 30 min (push "sua
vaga! pague em
30 min") → não pagou → próximo da fila → espera vazia → vaga aberta ao grupo, push
"abriu vaga — reserve no app". Nessa última fase, `claim_open_slot` reserva uma vaga por
10 min antes de mostrar o Pix; pedidos concorrentes são serializados no servidor.
Mensalista presumido ou goleiro isento que chegar à vez é confirmado imediatamente, sem
mostrar Pix nem segurar claim financeira.

**F4 · Sortear e publicar (organizador)**
T2 (ou commit bem-sucedido do primeiro sorteio fecha a lista) → pendências zeradas (tela
19 mostra o que falta) → Avaliar quem falta → Sortear → re-sortear/ajustar (tudo contado)
→ Publicar →
push a todos → tela 9 com trilha.
Erros: jogador sem nota (botão desabilitado com lista) · menos jogadores que times
(bloqueado com aviso) · alteração concorrente na lista (proposta descartada e recálculo
obrigatório) · timeout do algoritmo (sem publicação parcial).

**F5 · Desistir**
Antes de pagar: sai na hora → 1º reserva sobe (F3) ou lista reabre.
Depois de pagar: app orienta falar com o organizador (reembolso por fora; remoção manual).
Se os times já saíram e o jogo ainda não começou, a remoção invalida a publicação e obriga
novo sorteio; ninguém continua vendo uma escalação atual com a pessoa removida.

**F6 · Cancelar racha (organizador)**
Tela 23 → confirmação com "a devolver" + pendências → cancela claims/sessões → push a
todos → racha fica no histórico como cancelado → comprovantes já finalizados continuam
decidíveis só para resolver pagamento/estorno → recorrência **continua** (D2).

---

## 6. Ordem de construção das telas (casada com os marcos do roadmap)

| Marco | Telas |
|---|---|
| M1 | 1–4 e 13 (perfil, exportação e exclusão essenciais) |
| M2 | 5, 10, 11, 12, 16, 17, 24, 25 |
| M3 | 18 (e 6 parcial) |
| M4 | 6 e 7 (listas) |
| M5 | 8, 19, 20 e 23 |
| M6 | 21, 22 e 9 |
| M7 | 14, 15 + push de verdade |
| M8 | acabamento e auditoria transversal das 25 telas |
