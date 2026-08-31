# Colete — Catálogo de notificações (v2, pré-migration)

**Todos os eventos, destinatários, canais e os textos exatos.** 25/08/2026.
Fonte: `01-requisitos.md` §5.8 · `11-telas-v1.md` (fluxos F1–F6).

**Canais:** 🔔 sino in-app (sempre, para todo evento — é a rede de segurança de quem está
sem push) · 📱 push (web push no beta PWA; Expo somente quando houver build nativo) ·
✉️ e-mail transacional via provedor SMTP externo (só eventos críticos). Tocar na
notificação abre a tela indicada em "destino".

**Preferências de alertas externos:** o jogador liga/desliga push/e-mail **por evento**
(tela 14); o fato no sino sempre é criado. Categorias servem só para organização visual.
Eventos 🔒 não permitem suprimir canais externos configurados. N13 é a única preferência
agrupada: um boolean controla o push das duas instâncias, sem remover os registros in-app.
Variáveis entre `{chaves}`.

---

## 1. Lista e vagas (categoria: "Lista")

| # | Evento | Gatilho | Para quem | Canais |
|---|---|---|---|---|
| N1 | Lista vai abrir | T0 − 30 min, fixo | membros do grupo | 📱🔔 |
| N2 | Janela de mensalistas abriu | TP | mensalistas do grupo | 📱🔔 |
| N3 | Lista geral abriu | T0 | membros do grupo | 📱🔔 |
| N4 | Abriu vaga | desistência com espera vazia, ou pós-T1 sem fila | membros fora da lista | 📱🔔 |

- **N1** · *"⚽ {grupo}"* — "A lista do racha de {dia} abre em 30 min. Prepara o dedo."
  → destino: detalhe do racha
- **N2** · *"⚽ {grupo}"* — "Sua janela de mensalista abriu — garanta sua vaga antes de
  todo mundo." → detalhe do racha
- **N3** · *"⚽ {grupo}"* — "A lista do racha de {dia} às {hora} está aberta!"
  → detalhe do racha
- **N4** · *"⚽ {grupo}"* — "Abriu vaga no racha de {dia}. Reserve no app antes de
  pagar." (variante pré-T1: "Abriu vaga no racha de {dia} — entra aí!") → detalhe do
  racha
- Anti-spam do N4: no máximo **1 por hora por racha** — vagas abertas no intervalo são
  agrupadas ("Abriram {n} vagas…").

> Entrar na lista/ficar na espera **não** gera push: é ação do próprio usuário, com
> resposta imediata na tela. Fica só no 🔔 sino, como registro. (Ajuste sobre a tabela
> original dos requisitos — push aqui seria ruído.)

## 2. Minha vaga e pagamento (categoria travada 🔒)

| # | Evento | Gatilho | Para quem | Canais |
|---|---|---|---|---|
| N5 🔒 | Prazo do Pix acabando | T1 − 2 h, ou ao virar starter pendente já dentro da janela | titulares sem pagamento | 📱🔔 |
| N6 🔒 | Perdeu a vaga (T1) | T1, pendente sem comprovante | o jogador | 📱🔔 |
| N7 🔒 | Vaga reservada com prazo | promoção da espera ou adição manual pós-T1 | o jogador | 📱🔔 |
| N8 🔒 | Subiu sem claim de pagamento | desistência pré-T1 ou promoção já quitada/`presumed`/`exempt` | o jogador | 📱🔔 |
| N9 🔒 | Pagamento aprovado | decisão do organizador | o jogador | 📱🔔✉️ |
| N10 🔒 | Pagamento rejeitado | decisão do organizador | o jogador | 📱🔔✉️ |
| N11 🔒 | Análise atrasou | `max(envio + 2 h, T1)` sem decisão; nunca altera escalação após o início | o jogador | 📱🔔 |

- **N5** · *"💸 Falta pagar"* — "Seu Pix do racha de {dia} vence às {hora}. Depois disso
  a vaga segue para a fila." → pagamento
- **N6** · *"😬 Você perdeu sua vaga"* — "O prazo venceu sem pagamento. Ainda dá para
  voltar pela fila; se abrir vaga sem espera, reserve no app antes de pagar." → detalhe
  do racha
- **N7** · *"🎉 Sua vaga chegou!"* — "Você subiu para titular no racha de {dia}. A vaga
  está reservada para você por {min} min — pague até {hora}." → pagamento. Variante
  manual: *"🎉 Você foi adicionado ao racha"* — "O organizador reservou uma vaga para
  você no racha de {dia}. Pague até {hora}." → pagamento
- **N8** · *"🎉 Você subiu!"* — "Vagou no racha de {dia} e você agora é titular. Envie
  o comprovante até {hora}; depois desse prazo, a vaga segue para a fila." → pagamento.
  Variante já quitada/`presumed`/`exempt`: "Vagou no racha
  de {dia} e você já está confirmado." → detalhe do racha
- **N9** · *"✅ Pagamento confirmado"* — "Presença garantida no racha de {dia} às {hora}.
  Até lá!" → detalhe do racha
- **N10** · *"❌ Comprovante recusado"* — "Abra o detalhe autenticado para ver o motivo.
  {antes_t1: 'Sua vaga segue com você até {hora}; envie outro comprovante.'}
  {apos_t1: 'Sua vaga foi liberada; volte pela fila.'}" → detalhe do racha. Motivo livre
  fica na projeção financeira privada, não no payload/push/e-mail.
- **N11** · *"⏳ Comprovante sem resposta"* — "O organizador ainda não analisou seu
  comprovante e o prazo passou. Você entrou na faixa prioritária da fila; isso não tira
  a vaga de quem já está confirmado." → detalhe do racha. Variante quando o jogo já
  começou: "O prazo de análise passou, mas sua participação não será alterada depois do
  início. O comprovante continua pendente de decisão financeira." → detalhe do racha

Se N8 já informa o prazo ao promover dentro da janela de N5, a mesma transação não cria
N5 adicional. A chave de N5 é por jogador+racha+T1, mesmo após sair/voltar.

## 3. Times e lembretes (categorias: "Times" · "Lembretes")

| # | Evento | Gatilho | Para quem | Canais |
|---|---|---|---|---|
| N12 | Times publicados | Publicar | todos os participantes | 📱🔔 |
| N13 | Lembrete do jogo | **duas instâncias fixas:** véspera 20h no fuso e 3 h antes | todos os participantes no 🔔; 📱 só com `match_reminders.external_enabled=true` | 📱🔔 |
| N14 🔒 | Racha alterado | edição material ou remoção que invalida times | participantes afetados | 📱🔔 |
| N15 🔒 | Racha cancelado | cancelamento | participantes | 📱🔔✉️ |

- **N12** · *"📋 Times saíram!"* — "Você está no {time} no racha de {dia}. Veja a
  escalação completa." → times publicados
- **N13** · *"⚽ Amanhã tem racha"* / *"⚽ Hoje, {hora}"* — "{local}. Você está
  confirmado." → detalhe do racha. O único toggle controla o push das duas; não existe opção
  para receber só uma. Os dois fatos continuam na Central.
- **N14** · *"⚠️ Mudança no racha"* — "O racha de {dia} mudou: {o_que_mudou}. Confere se
  ainda dá para você." → detalhe do racha. Variante de escalação invalidada para quem
  permanece: "Um participante saiu e os times precisam ser publicados novamente."
  Variante para remoção apenas do racha: "Você foi retirado do racha de {dia} pelo
  organizador. {se_pagou: 'O valor está marcado como a devolver.'}"
- **N15** · *"🚫 Racha cancelado"* — "O racha de {dia} em {grupo} foi cancelado.
  {se_pagou: 'Seu pagamento está marcado como a devolver — fale com o organizador.'}
  {se_em_analise: 'Seu comprovante continua em análise apenas para resolver o estorno.'}
  {se_claim_upload: 'Se você já concluiu o Pix no banco, avise o organizador.'}"
  → detalhe do racha

## 4. Grupo (categoria: "Grupo")

| # | Evento | Gatilho | Para quem | Canais |
|---|---|---|---|---|
| N16 | Aprovado no grupo | organizador aprova | o jogador | 📱🔔 |
| N17 🔒 | Removido do grupo | expulsão | o jogador | 🔔✉️ (sem push) |
| N24 🔒 | Visibilidade das notas mudou | dono torna notas visíveis ou privadas | membros ativos | 📱🔔✉️ |
| N25 🔒 | Papel ou titularidade mudou | promoção/rebaixamento ou transferência | pessoas afetadas | 📱🔔✉️ |

- **N16** · *"👥 Bem-vindo ao {grupo}!"* — "Seu pedido foi aprovado. O próximo racha já
  aparece na sua lista." → detalhe do grupo
- **N17** · *"Você saiu de {grupo}"* — "Você foi removido do grupo pelo organizador.
  {se_pagou: 'Pagamentos de rachas futuros estão marcados como a devolver.'}"
  → lista de grupos. **Sem push** de propósito: constrangimento não precisa vibrar no
  bolso; e-mail + sino registram.
- **N24** · *"🔐 Visibilidade das notas mudou"* — "Em {grupo}, as notas agora estão
  {visibilidade}. Você sempre pode ver e contestar a sua." → detalhe do grupo
- **N25** · *"🛡️ Seu papel em {grupo} mudou"* — "Agora você é {papel}. Alteração feita
  por {ator} em {data}." → detalhe do grupo. Variante de titularidade avisa antigo e novo dono.

## 5. Segurança e acesso (categoria travada: "Segurança")

| # | Evento | Gatilho | Para quem | Canais |
|---|---|---|---|---|
| N26 🔒 | Acesso administrativo mudou | suspensão, banimento ou restauração | usuário afetado ou gestores do grupo | 🔔✉️ |

- **N26** · *"⚠️ Acesso ao Colete alterado"* — "O acesso de {target_display_name} foi {situação} em
  {data}. Veja o motivo e como pedir revisão." → detalhe do recurso/canal de suporte.
  Não inclui o motivo sensível no e-mail; o detalhe é fornecido após verificação de
  identidade pelo canal de suporte, que continua acessível sem sessão ativa.

## 6. Organizador (categoria: "Organização" — só quem é organizador vê)

| # | Evento | Gatilho | Para quem | Canais |
|---|---|---|---|---|
| N18 🔒 | Comprovante para analisar | finalização válida do comprovante | organizadores do racha | 📱🔔 |
| N19 | Pedido de entrada no grupo | entrada por link | organizadores | 📱🔔 |
| N20 🔒 | Falta avaliar — sorteio travado | T1 concluído, 3 h antes do jogo ou novo titular sem nota pós-T1 | organizadores | 📱🔔 |
| N21 | Racha recorrente criado | racha anterior vira terminal | organizadores | 🔔 |

- **N18** · *"🧾 Comprovante de {nome}"* — "R$ {valor} — analise até {hora}; o SLA é 2 h
  e a vaga nunca vence antes de T1." → aprovar comprovante. Agrupável: "{n} comprovantes
  aguardando".
- **N19** · *"👥 {nome} quer entrar"* — "Pedido de entrada em {grupo} aguardando sua
  aprovação." → gestão de membros
- **N20** · *"⭐ Falta avaliar {n} jogador(es)"* — "O sorteio do racha de {dia} está
  travado até todo mundo ter estrela." → avaliar jogadores. Se T1 coincidir com 3 h
  antes, a chave lógica produz um único aviso; novas inclusões pós-T1 atualizam o total
  com anti-spam, sem esconder o bloqueio no painel.
- **N21** · *"🔁 Racha de {dia} criado"* — "O próximo racha recorrente já está agendado.
  A lista abre {quando}." → detalhe do racha (só sino — rotina não precisa de push)

---

## 7. Estornos (categoria travada 🔒)

| # | Evento | Gatilho | Para quem | Canais |
|---|---|---|---|---|
| N22 🔒 | Estorno devido | `refund_due` criado sem N15/N17 equivalente na mesma transação | o jogador | 📱🔔✉️ |
| N23 🔒 | Estorno registrado | organizador marca `refunded` | o jogador | 📱🔔✉️ |

- **N22** · *"💸 Valor a devolver"* — "O organizador registrou R$ {valor} a devolver no
  racha de {dia}. O app não movimenta o dinheiro; acompanhe com ele." → detalhe do racha
- **N23** · *"↩️ Estorno registrado"* — "O organizador informou que devolveu R$ {valor}
  em {data}. Confira sua conta; se não recebeu, conteste pelo detalhe do racha." → detalhe
  do racha. O texto não diz "estorno confirmado", porque não há integração bancária.

N15 e N17 já carregam `refund_due`; para não vibrar/e-mailar duas vezes na mesma transação,
substituem N22. N23 nunca é suprimida.

---

## 8. Contestações financeiras (categoria travada 🔒)

| # | Evento | Gatilho | Para quem | Canais |
|---|---|---|---|---|
| N27 🔒 | Contestação financeira aberta | jogador contesta resolução/estorno | jogador e organizadores elegíveis; Admin somente se caso já atribuído | 📱🔔✉️ |
| N28 🔒 | Contestação/caso atualizado | resposta, escalonamento, troca de autoridade, correção ou resolução | partes afetadas e autoridade atual | 📱🔔✉️ |

- **N27** · *"⚠️ Contestação registrada"* — "A contestação sobre o racha de {dia} foi
  registrada. Resposta prevista até {prazo}." → financeiro do detalhe. Variante do
  organizador: "{nome} contestou um registro financeiro de R$ {valor}. Responda até
  {prazo}." Motivo não entra no push/e-mail.
- **N28** · *"🧾 Contestação atualizada"* — "A contestação do racha de {dia} está
  {situação}. Abra o detalhe para acompanhar." → financeiro do detalhe. Variantes de
  transferência administrativa, correção de estorno e resolução informam ação/estado,
  nunca motivo privado ou evidência.

N27 confirma abertura para o autor e cria tarefa para a autoridade. Responder e resolver
geram N28 distintas, com `dedupe_key` pelo evento append-only. Suspensão/banimento não
suprime aviso: usa sino/e-mail/canal verificado disponível.

---

## 9. Payloads tipados

`notification_contents.payload` é construído pelo servidor e validado antes do insert. IDs de
entidades são UUID; IDs de eventos append-only são inteiros seguros canônicos. Horários são
ISO-8601 UTC, valores são strings decimais `0.00` e textos interpoláveis já chegam
sanitizados e nomes/local ≤ 120 caracteres. `match_id`/`group_id`/`route` são obrigatórios
quando listados; chaves ausentes ou extras retornam `NOTIFICATION_PAYLOAD_INVALID`.

| Tipos | Chaves exatas obrigatórias | Opcionais tipadas |
|---|---|---|
| N1 | `group_id,match_id,group_name,day,route,scheduled_at` | — |
| N2 | `group_id,match_id,group_name,route,scheduled_at` | — |
| N3 | `group_id,match_id,group_name,day,time,route,scheduled_at` | — |
| N4 | `group_id,match_id,group_name,day,route,variant` | `open_count:int(1..30)`; `variant=pre_t1\|post_t1` |
| N5 | `match_id,payment_cycle_id,day,time,route,scheduled_at` | — |
| N6 | `match_id,payment_cycle_id,day,route` | — |
| N7 | `match_id,payment_cycle_id,day,time,minutes,route,variant` | `variant=promotion\|manual`; `minutes:int(1..120)` |
| N8 | `match_id,payment_cycle_id,day,route,variant` | `time`; `variant=pending\|accepted\|presumed\|exempt` |
| N9 | `match_id,payment_cycle_id,day,time,route` | — |
| N10 | `match_id,payment_cycle_id,day,route,phase_variant` | `reason_code`; sem motivo livre |
| N11 | `match_id,payment_cycle_id,route,variant` | `variant=pre_start\|post_start` |
| N12 | `match_id,publication_id,team_number,day,route` | — |
| N13 | `match_id,day,time,local,route,scheduled_at,reminder_kind` | `reminder_kind=prior_day\|three_hours` |
| N14 | `match_id,day,route,change_codes` | `change_codes:string[1..8]` de enum fechado; `refund_due:boolean` |
| N15 | `group_id,match_id,group_name,day,route` | `refund_due:boolean,review_pending:boolean,unfinished_claim:boolean` |
| N16 | `group_id,group_name,route` | — |
| N17 | `group_id,group_name,route` | `refund_due:boolean` |
| N18 | `group_id,match_id,payment_cycle_id,profile_display_name,amount,time,route` | `aggregate_count:int(1..100)` |
| N19 | `group_id,group_name,profile_display_name,route` | — |
| N20 | `match_id,day,missing_count,route` | `missing_count:int(1..30)` |
| N21 | `group_id,match_id,day,opens_at,route` | — |
| N22 | `match_id,payment_cycle_id,refund_event_id,amount,day,route` | — |
| N23 | `match_id,payment_cycle_id,refund_event_id,amount,declared_at,route` | — |
| N24 | `group_id,group_name,visibility,route` | `visibility=private\|members` |
| N25 | `group_id,group_name,role,actor_display_name,changed_at,route` | `role=owner\|organizer\|player` |
| N26 | `target_type,target_display_name,situation,changed_at,route` | `target_type=profile\|group`; nome sanitizado ≤120; `situation=suspended\|banned\|restored` |
| N27 | `match_id,payment_cycle_id,dispute_id,profile_display_name,day,amount,sla_due_at,route,recipient_role` | `recipient_role=player\|organizer\|admin` |
| N28 | `match_id,payment_cycle_id,day,status,route,update_kind` | união discriminada abaixo; somente os IDs condicionais daquela variante |

N28 é uma união fechada pelo `update_kind`:

- `response|first_instance|appeal|appeal_waived|escalation|final_resolution` exige
  `dispute_id`; `status` é um dos estados reais da disputa
  (`responded|resolved_first_instance|appealed|escalated|resolved_final`); `case_id` só pode
  aparecer em `appeal|escalation|final_resolution` quando houver caso;
- `authority_transfer` exige `case_id`, usa `status=assigned` e admite `dispute_id` somente
  se o caso estiver ligado a uma disputa;
- `refund_correction` exige `refund_event_id` inteiro, usa `status=corrected` e admite
  `dispute_id` somente quando a correção integra uma disputa já existente.

Qualquer combinação diferente, ID extra ou estado incompatível falha no validador.

Globalmente proibidos em qualquer nível: `pix`, `key`, `proof`, `path`, `fingerprint`,
`token`, `stars`, `rating`, `reason`, `email`, `phone`, `cpf`, `cnpj`, endereço completo e
payload arbitrário do cliente. `route` é enum de rotas internas, não URL fornecida pelo ator.

## 10. Regras transversais

1. **Todo evento do catálogo vai ao sino**, sempre — push e e-mail são camadas por cima.
2. **E-mail** só em N9, N10, N15, N17 e N22–N28 (dinheiro, remoção, privacidade, papel, acesso e contestação): assunto = título,
   corpo = texto + botão para a tela destino.
3. **Sem horário de silêncio no beta**: os eventos 🔒 são urgentes por natureza (prazo
   de 30 min não pode esperar amanhecer) e os demais permitem desligar canais externos por
   evento — a granularidade é o controle (requisito de acessibilidade/TDAH).
4. **Entrega pelo menos uma vez:** o outbox tem `dedupe_key` única (evento + racha +
   destinatário + marco). Cada destino/canal — inclusive cada dispositivo — vive em
   `notification_deliveries`, com retry exponencial e limite. A unicidade evita criação
   lógica duplicada; como um
   provedor pode aceitar a mensagem e perder a confirmação, o cliente também deduplica
   push pelo `notification_id`. E-mail pode repetir raramente; texto é seguro para replay
   e aponta ao estado atual. Não se promete "exactly once".
5. **Deep link:** todo push carrega a rota destino; no PWA, URL; no nativo, deep link —
   mesma rota (Expo Router).
6. **Tom dos textos:** direto, de grupo de WhatsApp, sem burocratês — mas o dado
   essencial (dia, hora, valor, prazo) sempre presente, porque o push pode ser a única
   coisa que a pessoa lê.
7. **Concorrência:** a notificação nunca é autoridade para a vaga. Ao abrir o destino, o
   app consulta o estado atual; botões expirados ou já consumidos mostram a situação
   real sem repetir a mutação.
8. **Privacidade e logs:** payloads não incluem comprovante, chave Pix, nota privada nem
   token. Logs guardam identificadores técnicos, resultado do canal e erro sanitizado.
9. **Evento agendado atrasado:** markers registram `sent` ou `skipped_stale`. N1 é
   obsoleto em T0; N2 em T0; N3 e N5 em T1; N13 quando o jogo começa. Reconciliação tardia
   aplica o estado correto, mas não despeja lembretes contraditórios. Eventos materiais
   (vaga perdida/promovida, decisão financeira, alteração, cancelamento e remoção) não são
   descartados por atraso.
10. **Reagendamento:** marker/dedupe incorpora o instante derivado. Em mudança de horário,
    job antigo não enviado vira `skipped_stale`; notificação já entregue permanece; N14
    comunica a mudança. N13 recalcula `prior_day` e `three_hours` separadamente, mas o único
    boolean continua controlando as deliveries externas de ambas.
11. **Retenção física:** `notifications` guarda o fato mínimo; o payload fica em
    `notification_contents` e é apagado em 90 dias. Deliveries/metadados ficam 12 meses sem
    depender do filho. Não se substitui payload por `{}`; entrega ainda pendente vira
    `dead/content_expired` antes do purge.
