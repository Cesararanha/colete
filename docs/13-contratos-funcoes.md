# Colete — Contratos das funções (v2, implementação incremental)

**A API do app: entradas, saídas, autorização, erros e efeitos transacionais.**
31/08/2026. Fontes: `10-schema-db.md` · `11-telas-v1.md` · `12-notificacoes.md`.

## 0. Envelope e regras comuns

As assinaturas nomeadas neste documento são o **contrato externo**. Toda mutação vai do
cliente para uma Edge Function exclusiva; o cliente nunca chama RPC mutável diretamente. Ele
envia apenas `request_id: uuid`, gerado uma vez por intenção e reutilizado em retries, e os
campos de negócio enumerados na assinatura. Resposta:

```ts
type Result<T> =
  | { data: T; request_id: string }
  | { error: { code: ErrorCode; message: string; fields?: Record<string, string>;
               current?: unknown }; request_id: string };
```

`INTERNAL` não é erro de negócio. É o fallback 5xx para uma falha inesperada que não pode
ser mapeada com segurança para outro código do catálogo, nunca inclui `fields` e é tratada
pelo cliente como falha de transporte.

1. **O cliente não decide regra de negócio.** Tabelas críticas têm escrita revogada; as
   funções validam autorização, fase e invariantes sob lock.
2. **Idempotência transacional.** Em `READ COMMITTED`, a função insere
   `executing_uncommitted` antes dos locks de negócio. A unique faz concorrentes aguardarem
   o commit/rollback. O estado intermediário nunca é commitado: trigger diferido exige
   `completed` no mesmo commit do efeito/outbox. Após commit, o concorrente lê em novo
   statement e reproduz o outcome; após rollback, outro se torna vencedor. Não existe lease
   nem takeover de mutação. A calibragem proposta para a espera é
   `idempotency_wait_timeout_ms=3000`, unidade `milliseconds`; espera excedida retorna
   `IDEMPOTENCY_WAIT_TIMEOUT`, retryable e sem efeito, e o retry conserva o mesmo
   `request_id`. O valor será validado no piloto. Depois de 30 dias o JSON é apagado e a
   linha vira `payload_expired`; retry retorna `IDEMPOTENCY_EXPIRED`. A chave/HMAC ficam por
   24 meses. Entrada diferente retorna `IDEMPOTENCY_CONFLICT`.
3. **Resultados normais não são erros.** Uma entrada que vai para a espera retorna
   sucesso com `status: 'waitlist'`.
4. **Ordem de lock:** idempotência → perfis → grupos → memberships → recorrências → rachas → convites →
   participantes/claims → ciclos → sessões/provas → resoluções/estornos/contestações/casos.
   Múltiplos UUIDs no mesmo nível são travados pelos bytes crescentes.
5. **Outbox atômico.** Auditoria, ledger e notificações são inseridos na mesma transação
   da mudança; entrega por canal ocorre depois, pelo menos uma vez.
6. **Tempo do servidor.** O cliente pode exibir contagens, mas toda validade usa
   `now()` do banco. Funções chamam `apply_due_transitions_locked` antes de decidir.
7. **Identidade interna.** Nas quatro mutações do M1-A, o cliente não envia `auth_user_id`,
   `profile_id`, `session_id` nem ator. A Edge valida o JWT, extrai as claims e a RPC resolve o
   perfil. Em contratos posteriores, um `profile_id` enumerado na assinatura pode ser o alvo
   de uma ação, nunca a identidade do chamador. O vínculo com `auth.users` é detalhe de
   autenticação e pode ser removido na desidentificação.

Outcome idempotente guarda IDs e `logical_result` do efeito; não guarda estado/prazo/posição
mutável de claim/sessão, capacidade restante ou estado financeiro atual. Também nunca guarda
Pix, token/URL/path, nota, prova, fingerprint, input/score privado, motivo livre ou campos de
perfil.
A resposta combina `{ outcome, current }`: `outcome` vem do registro e `current` é projeção
fresca autorizada. Pix por `get_payment_instructions`, upload/leitura de prova pelas Edge
autenticadas, claim/lista por `get_my_match_state` e proposta por
`get_draw_proposal`. Efeito externo é somente uma linha de outbox/saga com `dedupe_key`; nunca
é executado dentro da promessa transacional do banco.

### 0.1 Canonicalização idempotente v1

Há dois contratos de transporte:

- **externo, cliente → Edge:** `request_id` + entrada de negócio. Não existem
  `input_hmac`, `hash_key_version` ou contexto de ator no body;
- **interno, Edge → RPC:** entrada normalizada + `request_id` +
  `actor_auth_user_id`/`actor_session_id` extraídos exclusivamente das claims verificadas +
  `input_hmac` + `hash_key_version`. A chamada usa o cliente administrativo com secret key.

`public`, `anon` e `authenticated` não recebem `EXECUTE` nas RPCs mutáveis. Após revogar os
defaults, só o papel administrativo usado pelo caminho secreto recebe grant nominal. A Edge
não possui endpoint administrativo genérico nem faz DML livre nas tabelas; chama apenas a RPC
estreita da operação. No banco, esse chamador não é o usuário final: a RPC não pode alegar que
o ator veio de `auth.uid()`. A confiança na origem de `actor_auth_user_id`/`actor_session_id`
vem da Edge autenticada e do grant exclusivo, enquanto autorização de domínio, sessão
revogada, locks, constraints, idempotência e efeitos atômicos continuam sendo revalidados no
banco.

Cada operação possui schema normalizador: rejeita chave desconhecida; preserva a diferença
ausente×`null`; normaliza string em NFC, UUID minúsculo, timestamp UTC com seis casas,
dinheiro em string decimal de duas casas e inteiro no intervalo seguro; rejeita float,
NaN/Infinity. Set-like arrays são ordenados conforme o schema. Serializa por JCS/RFC 8785 em
UTF-8 e calcula:

```text
HMAC-SHA-256(key_v,
  UTF8("colete/idempotency/v1") || 0x00 || UTF8(operation) || 0x00 || JCS(input))
```

Persistem `canonical_version=1` e `hash_key_version`. Vetor comum SQL/TypeScript/job: chave
de teste `00..1f`, operação `join_match`, JCS
`{"list_kind":"field","match_id":"01890f7e-e948-7c53-b13a-4a36e4b7d21e"}` →
`5974c4e8c2434e4d150f2f2199180b3228c869f80e72dabc0f25218132595ee4`.

O HMAC detecta replay/divergência e protege o digest de entradas de baixa entropia; ele não
autentica o ator nem concede autorização. A Edge calcula com a chave do cofre, que nunca entra
no cliente, banco, tabela, configuração SQL ou log. A RPC valida formato e versão, compara o
valor persistido em replay e revalida os campos de negócio. Não se cria
`private.compute_idempotency_hash` em produção sem chamador produtivo; vetores SQL usam
`extensions.hmac` diretamente ou helper exclusivo da suíte.

Erros comuns: `UNAUTHENTICATED` · `FORBIDDEN` · `NOT_MEMBER` · `NOT_ORGANIZER` ·
`OWNER_ONLY` · `NOT_FOUND` · `VALIDATION` · `IDEMPOTENCY_WAIT_TIMEOUT` · `IDEMPOTENCY_CONFLICT` ·
`IDEMPOTENCY_EXPIRED` ·
`CONCURRENT_CHANGE` · `PROFILE_SUSPENDED` · `GROUP_SUSPENDED` · `MATCH_CANCELED` · `MATCH_DONE`.

### 0.2 Testes normativos de idempotência

Este é um plano da suíte, não conteúdo de migration. O harness abre 25 conexões para o caso
simultâneo abaixo e mantém casos menores/maiores conforme a operação.

1. 25 chamadas simultâneas com mesma chave/HMAC produzem um efeito e um `completed`; depois
   do commit, todas recebem o mesmo outcome seguro. Timeout de espera pode retornar somente
   `IDEMPOTENCY_WAIT_TIMEOUT` e o retry converge ao mesmo outcome.
2. Mesma chave com payload diferente, inclusive enquanto o vencedor não commitou, espera a
   decisão da unique, nunca toca domínio e
   retorna `IDEMPOTENCY_CONFLICT`.
3. Crash antes do efeito, depois do efeito e depois da outbox mas antes do commit faz rollback
   de tudo e permite nova execução; crash depois do commit reproduz sem novo efeito.
4. Replay de `claim_open_slot` após expirar devolve `outcome.logical_result='claim_created'`
   + `current.claim_status='expired'`, sem prazo/estado antigo; Pix retorna `CLAIM_EXPIRED`.
5. Replay de sessão ainda utilizável devolve ID + estado atual e o target emite credencial
   nova; finalizada/expirada retorna `UPLOAD_SESSION_NOT_USABLE`, nunca token.
6. Aos 30 dias, outcome é zerado e estado vira `payload_expired`; retry antes dos 24 meses
   retorna `IDEMPOTENCY_EXPIRED` e não cria novo participante, ciclo, prova, draw ou estorno.
7. Teste de dump confirma ausência de Pix, tokens, paths, notas, fingerprints e payloads
   privados em `idempotency_records`.
8. Golden vectors rodam nos três runtimes; casos negativos cobrem ordem de objeto, NFC/NFD,
   `null`/ausência, timestamp com offset, dinheiro, arrays set-like e alteração de um campo.

## 1. Lista, fila e reserva

Campos `payment_status` desta API são **rótulos projetados**, não uma segunda autoridade:
`approved|marked_paid` derivam do tipo da única resolução de `payment_cycles`; os demais
derivam do estado do ciclo atual.

### 1.1 `join_match(match_id, list_kind, request_id)`

Entrada normal na lista de `field` ou `goalkeeper`.

- **Quem:** membro ativo; convidado avulso usa `accept_match_invite` na seção 5.
- **Locks/autorização:** resolve IDs sem lock; trava perfil→grupo→membership→racha e então
  revalida conta/membership/grupo e `match.group_id`. Remoção, saída, suspensão ou exclusão
  concorrente não pode deixar participante ativo sem membership no instante linearizado.
- **Pré:** TP/T0 permite a pessoa; fase `open`; `now() < payment_due_at`. Depois de T1,
  esta função nunca ocupa vaga: usa-se `claim_open_slot`.
- **Saída:** `{ outcome: { match_player_id, payment_cycle_id,
  logical_result: 'joined'|'waitlisted' }, current: { status: 'starter'|'waitlist'|'left'|'removed',
  waitlist_pos?, payment_status, payment_due_at } }`; `current` é recalculado no retry.
- **Idempotência sem ambiguidade:** retry devolve outcome gravado + `current` fresco;
  nova intenção após `left` precisa de novo `request_id` e recebe nova `queue_seq`. Nova
  chave enquanto já está ativo apenas devolve o estado com `already: true`.
- **Erros:** `MATCH_NOT_OPEN` · `LIST_CLOSED` · `MONTHLY_ONLY` · `OTHER_LIST`.
- **Efeitos:** cria/reativa `match_players`, incrementa `matches.revision`; `joined_at`
  preserva o histórico e a fila usa `(queue_tier, queue_seq)`.

### 1.2 `leave_match(match_id, request_id)`

- **Pré:** próprio registro; antes de T2; permitido em `pending`, `presumed`, `exempt` ou
  `refunded`. `under_review`, `approved`, `marked_paid` e `refund_due` bloqueiam.
- **Saída:** `{ ok: true, promoted_profile_id?: uuid, refund_due?: false }`.
- **Erros:** `PAYMENT_IN_REVIEW` · `PAYMENT_ALREADY_REAL` · `LIST_CLOSED`. Já estar fora
  é sucesso idempotente.
- **Efeitos:** marca `left`, cancela claim; antes de T1 promove o primeiro da espera
  (**N8**) ou anuncia vaga (**N4**). Depois de T1, quitado/presumido/isento sobe direto
  (N8) ou pagante recebe claim (N7); só anuncia vaga quando a fila elegível acaba.
  Incrementa a revisão.

### 1.3 `claim_open_slot(match_id, list_kind, request_id)`

Reserva uma vaga **antes** de abrir o banco.

- **Pré:** `payment_due_at <= now() < closes_at`; capacidade disponível; nenhuma pessoa
  elegível na fila; sem claim ativa incompatível; cooldown não violado.
- **Saída pagante:** `{ outcome: { match_player_id, payment_cycle_id, claim_id,
  logical_result: 'claim_created' }, current: { claim_status, claim_expires_at?,
  payment_status } }`. Estado/prazo ficam só em `current`.
- **Saída mensalista/isento:** `{ outcome: { match_player_id, payment_cycle_id,
  logical_result: 'confirmed_without_claim' }, current: { payment_status:
  'presumed'|'exempt', confirmed: true } }`.
- **Concorrência:** trava o racha e serializa a contagem. Só um pedido ocupa a última
  vaga; os demais recebem `NO_OPEN_SLOT`, sem instrução de pagamento.
- **Erros:** `WAITLIST_HAS_PRIORITY` · `NO_OPEN_SLOT` · `CLAIM_ACTIVE` ·
  `CLAIM_COOLDOWN` · `LIST_CLOSED`.
- **Efeitos:** pagante recebe claim `open_slot` de 10 min; `presumed`/`exempt` ocupa
  diretamente. Ambos incrementam revisão. Depois do sucesso, o cliente chama
  `get_payment_instructions`; o replay desta mutação nunca devolve Pix.

### 1.3.1 `get_payment_instructions(match_id)` — projeção sensível

- **Quem:** organizador ou o próprio starter com ciclo atual `pending`; em/após T1, o
  próprio jogador precisa de claim `active` não expirada.
- **Saída não persistida:** `{ type, key, receiver_name, receiver_city, amount,
  payment_cycle_id, valid_until? }`.
- **Erros:** `PAYMENT_CYCLE_NOT_FOUND` · `CLAIM_REQUIRED` · `CLAIM_EXPIRED` · `FORBIDDEN`.
  Claim já expirada continua negada mesmo quando `claim_open_slot` é repetida com a chave antiga.

### 1.4 `apply_payment_deadline(match_id)` — sistema

- **Pré:** `now() >= payment_due_at`.
- **Saída:** `{ applied, demoted, claims_created }`; marker existente devolve
  `applied: false`.
- **Efeitos sob um lock:** marca T1 uma única vez; starters `pending` voltam ao fim da
  fila. Para cada vaga, promove imediatamente o primeiro `approved`/`marked_paid`/
  `presumed`/`exempt`; o primeiro `pending` recebe claim `promotion` de 30 min e
  `under_review` aguarda decisão. A ordem sempre segue
  `(queue_tier, queue_seq)`; grava **N6/N7/N8/N4** deduplicadas.

### 1.5 `expire_slot_claims(match_id)` — sistema

- **Saída:** `{ expired, next_claims_created }`.
- **Efeitos:** expira claims sem comprovante finalizado, devolve o jogador à fila com
  nova sequência e promove o próximo elegível; `approved`/`marked_paid`/`presumed`/
  `exempt` sobe imediatamente e `pending` recebe nova claim. Claim `manual` expirada em/
  após T2 não promove ninguém automaticamente. Nunca remove starter válido.

### 1.6 `add_player(match_id, profile_id, list_kind, request_id)` /
`remove_player(match_id, profile_id, reason, request_id)`

- **Quem:** organizador.
- **Pré da adição de membro:** `closes_at <= now() < starts_at`, fase fechada,
  `current_publication_id is null` e capacidade disponível. Uma publicação histórica já
  invalidada não bloqueia a correção; apenas a publicação atual bloqueia. Antes de T2, a corrida é
  respeitada e o organizador não pode usar esta RPC para furar a fila; convidado avulso
  usa o convite auditado da seção 5.
- **Pré da remoção:** `now() < starts_at`; comprovante `under_review` exige decisão ou
  retirada antes. Times já publicados não bloqueiam: são invalidados atomicamente.
- **Saída:** `{ outcome: { match_player_id,payment_cycle_id?,claim_id?,
  logical_result:'player_added'|'player_removed',invalidated_publication_id? }, current: {
  payment_status,claim_status?,claim_expires_at?,refund_due?:{amount} } }`.
- **Erros da adição:** `OTHER_LIST` · `NO_OPEN_SLOT` · `TEAMS_ALREADY_PUBLISHED` ·
  `MATCH_STARTED`. **Erros da remoção:** `PROOFS_PENDING` · `MATCH_STARTED`.
- **Efeitos:** `manual_add`/`manual_remove` na trilha. Remoção de pagamento real cria
  evento `refund_due`; não marca `refunded` automaticamente. Adição pagante pós-T1 cria
  claim `manual` até `least(now()+30min, starts_at)` e N7 na variante manual;
  `presumed`/`exempt` entra direto. Se a remoção atingir a publicação atual, preserva-a
  como histórico, limpa o ponteiro, volta a fase para `closed`, incrementa a revisão,
  grava `publication_invalidated` e envia N14 aos afetados; será preciso novo sorteio.

## 2. Comprovante e financeiro

Nas mutações desta seção, IDs/`logical_result` formam `outcome`; `payment_status`, deadline,
contagens e disponibilidade formam `current` fresco, ainda quando a notação estiver achatada
para legibilidade. Credencial/evidência nunca pertence a nenhum dos dois; só à projeção
sensível não persistida explicitamente marcada.

### 2.1 `create_proof_upload(match_id, request_id)`

- **Quem:** próprio starter, ciclo atual `pending`; em/após T1, claim ativa.
- **Saída:** `{ outcome: { upload_session_id, constraints: { mime_types:
  ['image/jpeg','image/png','image/webp','application/pdf'], max_bytes } },
  current: { session_status, expires_at? } }`; estado/prazo não são persistidos no outcome.
- **Erros:** `NOT_STARTER` · `PAYMENT_CYCLE_NOT_FOUND` · `CLAIM_REQUIRED` ·
  `CLAIM_EXPIRED` · `ALREADY_UNDER_REVIEW` · `PAYMENT_ALREADY_RESOLVED`.
- Caminho e credencial não entram na resposta idempotente. Criar sessão não altera vaga
  nem dispara N18.

### 2.2 `PUT /proof-upload-sessions/:id/content` — Edge autenticada

- Reautentica o titular e revalida perfil ativo, sessão `created`, `now()<expires_at`, ciclo
  `pending` e claim, quando exigida, antes de aceitar o corpo.
- O cliente nunca recebe signed URL, token ou path. A Edge resolve o caminho internamente,
  aplica MIME/magic bytes/tamanho, usa service role apenas naquele objeto e `upsert=false`.
- **Saída não persistida:** `{ uploaded: true, upload_session_id }`.
- **Erros:** `UPLOAD_SESSION_EXPIRED` · `UPLOAD_SESSION_NOT_USABLE` · `CLAIM_EXPIRED` ·
  `PAYMENT_ALREADY_RESOLVED` · `UPLOAD_INVALID`. Sessão vencida nunca aceita bytes.

### 2.3 Upload binário e `finalize_proof(upload_session_id, request_id)`

Sucesso do Storage não submete o comprovante. A finalização exige objeto presente, valida
magic bytes/tamanho/allowlist e, sob racha → jogador/claim → ciclo → sessão, cria prova,
completa claim, muda ciclo para `under_review`, grava ledger e **N18**.

- **Saída:** `{ proof_id, payment_cycle_id, payment_status: 'under_review',
  review_expires_at, duplicate_signal: boolean }`.
- `review_expires_at = greatest(finalized_at + interval '2 hours', payment_due_at)`.
- **Erros:** `UPLOAD_SESSION_EXPIRED` · `UPLOAD_SESSION_NOT_USABLE` ·
  `STORAGE_OBJECT_MISSING` · `UPLOAD_INVALID` · `CLAIM_EXPIRED` ·
  `SESSION_ALREADY_FINALIZED` · `PAYMENT_CYCLE_CONFLICT`.
- SHA-256 bruto é transitório. O banco guarda HMAC versionado com domínio e `group_id`;
  arquivo igual no mesmo grupo produz sinal igual, em grupo diferente produz outro valor.
  API nunca retorna fingerprint/origem e dump sem chave não permite localizar arquivo.

### 2.3.1 `GET /proofs/:proof_id/content` — Edge autenticada

Revalida em cada requisição se o ator é titular ou autoridade financeira elegível do mesmo
grafo composto e se o binário ainda existe. Faz stream dos bytes obtidos com service role,
sem redirect e sem revelar path, com `Cache-Control: private, no-store, max-age=0` e
`Pragma: no-cache`. Perda de membership, caso reatribuído, suspensão ou purge corta a próxima
leitura. Uma cópia já baixada pelo usuário autorizado não pode ser revogada pelo servidor.
Erros: `PROOF_EVIDENCE_PURGED` · `FINANCIAL_CASE_NOT_ASSIGNED` · `FORBIDDEN`.

### 2.4 `delete_own_proof(proof_id, request_id)`

Antes de decisão, marca `proof_withdrawn`, volta ciclo a `pending` e, em/após T1, libera a
vaga/promoção. Depois de decisão, apaga apenas binário/caminho/fingerprint. Se a prova foi
encerrada por resolução externa, ledger/resolução continuam. Saída:
`{ ok, slot_released, binary_deleted, payment_cycle_id }`.

### 2.5 `decide_proof(proof_id, decision, reason, confirm_evidence_unavailable, request_id)`

- **Quem:** organizador elegível ou Admin de `financial_case` atribuído; Admin usa a função
  2.12. `decision` é `approved|rejected`; rejeição exige motivo ≤ 500.
- **Saída:** `{ decision, payment_cycle_id, payment_status, resolution_id?, slot_released,
  late_resolution }`.
- Trava ciclo antes da prova. Aprovação cria exatamente uma `payment_resolutions` do tipo
  `proof_approved`. Se `mark_paid`/pagamento cancelado já venceu, retorna
  `PAYMENT_ALREADY_RESOLVED`; mesma decisão previamente aplicada é sucesso idempotente.
- Prova `resolved_elsewhere` não pode ser aprovada/rejeitada (`PROOF_RESOLVED_ELSEWHERE`).
  Binário expurgado exige confirmação e motivo, ou `PROOF_EVIDENCE_PURGED`.
- Aprovação tardia nunca desloca starter: sem capacidade/publicação/em ou após o início,
  cria `refund_due` e N22. Em cancelado, aprovação também cria resolução + obrigação, sem
  reabrir lista. Rejeição volta ciclo a `pending`; em/após T1 libera a vaga. Envia N9/N10
  conforme o resultado.

### 2.6 `mark_paid(match_id, profile_id, amount, confirm_amount_mismatch, reason, request_id)`

Somente organizador elegível, starter e racha não cancelado. Sob ciclo lock, cria a única
resolução `marked_paid`; se houver prova indecidida, marca-a `resolved_elsewhere` na mesma
transação. Valor divergente exige confirmação. Saída:
`{ payment_cycle_id, resolution_id, payment_status: 'marked_paid' }`; envia N9.
Erros: `NOT_STARTER` · `PAYMENT_ALREADY_RESOLVED` ·
`AMOUNT_MISMATCH_CONFIRMATION_REQUIRED` · `FINANCIAL_CASE_OPEN`.

### 2.6.1 `record_canceled_match_payment(match_id, profile_id, amount, confirm_amount_mismatch, reason, request_id)`

Somente organizador elegível e racha cancelado. Cria uma resolução `marked_paid` e a única
obrigação `refund_due` do mesmo ciclo; prova indecidida vira `resolved_elsewhere`. Não ocupa
vaga, não envia N9 e envia N22. Erros: `MATCH_NOT_CANCELED` ·
`PAYMENT_ALREADY_RESOLVED` · `AMOUNT_MISMATCH_CONFIRMATION_REQUIRED` ·
`PAYMENT_RELATION_NOT_FOUND` · `FINANCIAL_CASE_OPEN`.

### 2.7 `mark_refund_due(resolution_id, reason, request_id)` /
`mark_refunded(refund_due_event_id, refunded_at, reference?, request_id)`

Obrigação aponta para resolução; devolução aponta para obrigação. Unique constraints e locks
garantem uma de cada. `refunded_at` não antecede obrigação nem está no futuro; `reference` é
privada, opcional e ≤ 120. Saída:
`{ payment_cycle_id, payment_status, amount, remaining_refunds }`. N22 comunica obrigação;
N23 comunica devolução. O app não afirma confirmação bancária.

### 2.8 `correct_refund(refund_event_id, corrected_at?, reference?, reason, request_id)`

Admin, ou organizador antes de contestação, corrige somente horário/referência de `refunded`
existente. `reason` é obrigatório; cria evento de correção/admin audit e N28. Não cria/apaga
pagamento, não muda beneficiário, valor, resolução ou estado. Erros:
`REFUND_NOT_FOUND` · `REFUND_CORRECTION_FORBIDDEN` · `ADMIN_REASON_REQUIRED`.

### 2.9 `unlock_price_after_refunds(match_id, request_id)`

Só organizador; trava todos os ciclos por UUID e exige resoluções reais `refunded`, nenhuma
prova indecidida e nenhuma disputa `open|responded|resolved_first_instance|appealed|escalated`.
Remove `price_locked_at`, nunca
`pix_locked_at`. Erros: `REFUNDS_PENDING` · `ACTIVE_PAYMENTS_REMAIN` · `DISPUTES_OPEN`.
O update seguinte cria `charge_version+1`; não transforma o ciclo antigo.

### 2.10 Contestação financeira

- `open_financial_dispute(payment_cycle_id, contested_event_id, reason, request_id)`:
  somente pessoa afetada, motivo 1–500, evento aceito/estorno do próprio ciclo/grupo/racha
  por FK composta. Cria disputa, evento append-only, SLA de sete dias, N27 às partes e trilha
  pública sem motivo.
- `respond_financial_dispute(dispute_id, response, request_id)`: organizador ativo elegível,
  texto ≤ 1000; muda `open→responded`, anexa evento e N28.
- `resolve_financial_dispute_first_instance(dispute_id, resolution, reason, request_id)`:
  organizador elegível, somente após resposta; `upheld|rejected|corrected`; muda para
  `resolved_first_instance`, fixa `appeal_deadline=now()+7d` e mantém preço travado.
- `accept_financial_dispute_resolution(dispute_id, request_id)`: somente autor, durante a
  janela; renuncia à apelação, anexa `appeal_waived` e conclui `resolved_final` com o mesmo
  resultado.
- `appeal_financial_dispute(dispute_id, reason, request_id)`: somente autor, uma vez, entre
  primeira decisão e `appeal_deadline`; cria `financial_appeals` unique, muda para `appealed`,
  abre caso Admin `dispute_appeal` e envia N28.
- `escalate_financial_dispute(dispute_id, request_id)` — sistema/autor: após `sla_due_at` sem
  primeira decisão, muda para `escalated`, cria caso Admin único e N28.
- `admin_resolve_financial_dispute(case_id, resolution, reason, request_id)`: somente Admin
  atribuído em `appealed|escalated`; grava decisão final, resolve apelação/caso e N28.
- `finalize_unappealed_disputes` — sistema: depois de `appeal_deadline`, sem apelação,
  promove exatamente uma vez a primeira decisão para `resolved_final`.
- Suspenso/banido usa canal autenticado mínimo ou suporte com identidade verificada para
  abrir/acompanhar/apelar. Organizador nunca apaga disputa. `unlock_price_after_refunds`
  bloqueia em `open|responded|resolved_first_instance|appealed|escalated`.
- Erros: `DISPUTE_TARGET_INVALID` · `DISPUTE_ALREADY_OPEN` · `DISPUTE_NOT_OPEN` ·
  `DISPUTE_AUTHORITY_REQUIRED` · `DISPUTE_NOT_APPEALABLE` ·
  `APPEAL_DEADLINE_EXPIRED` · `DISPUTE_APPEAL_EXISTS`.

### 2.11 Continuidade da autoridade financeira

`transfer_financial_authority(profile_id, reason, request_id)` é primitiva interna de
suspensão/banimento/exclusão: trava perfis/grupos/casos por UUID, escolhe organizador ativo
elegível; se não houver, abre `financial_case` `admin_financial`. Só então sessões são
revogadas. Exclusão voluntária retorna `FINANCIAL_SUBSTITUTE_REQUIRED` enquanto a pessoa é
parte/autoridade indispensável sem substituto. Havendo substituto, transfere antes de
desidentificar e notifica N28. Na mesma operação, claims/sessões não finalizadas do alvo são
canceladas, participações em rachas ainda não iniciados viram `removed` e publicação atual
atingida é invalidada com N14; resoluções/estornos seguem no caso. Jogo já iniciado conserva
o fato histórico, e exclusão troca o perfil por rótulo desidentificado. Assim convidado com
dinheiro e escalação futura nunca ficam sem autoridade/sem dono visível da correção.

### 2.12 Funções administrativas do caso

- `admin_assign_financial_case(case_id, assignee_id?, reason, request_id)` atribui a
  organizador ativo ou ao próprio canal Admin; não concede membership.
- `GET /admin-cases/:case_id/evidence?reason_code=...` faz o mesmo streaming autenticado da
  seção 2.3.1 apenas para caso atribuído, registra cada acesso e não contorna o purge de sete
  dias; nunca retorna URL assinada.
- `admin_decide_proof(case_id, proof_id, decision, reason,
  confirm_evidence_unavailable, request_id)`, `admin_mark_refunded(case_id, ... )` e
  `admin_resolve_financial_dispute(case_id, ... )` chamam as mesmas primitivas/invariantes, resolvem
  o caso e gravam `admin_financial_intervention` + N28.
- Erros: `FINANCIAL_CASE_NOT_FOUND` · `FINANCIAL_CASE_NOT_ASSIGNED` ·
  `ADMIN_REASON_REQUIRED` · `FORBIDDEN`. Admin vê só sujeito, ciclo, valor, eventos tipados
  e evidência ainda existente daquele caso; não lista membros, notas, outros rachas ou Pix.

## 3. Racha e recorrência

### 3.1 `create_match(group_id, config, request_id)`

`config` inclui início/fim/fuso, local, capacidades, preços, configuração de goleiro,
tipo/chave/nome/cidade Pix, TP/T0/T1/T2 e, opcionalmente, criação/versão de série recorrente.
Pix de racha é materializado em `match_payment_secrets`; se houver série, a configuração
cifrada própria fica em `recurrence_payment_secrets`, fora do JSON do template.

- **Saída:** racha com horários absolutos e `summary` gerado no servidor.
- **Erros:** `TIME_ORDER` · `PRICE_INVALID` · `PIX_INVALID` · `MONTHLY_DISABLED` ·
  `RECURRENCE_INVALID`.
- `TP <= T0 < T1 < T2 < starts_at`; T0 é sempre a abertura geral.

### 3.2 `update_match(match_id, patch, request_id)`

- Após T0, tipo/chave/nome/cidade Pix são imutáveis (`PIX_LOCKED`).
- Depois de TP, TP/T0 são imutáveis (`OPENING_LOCKED`); não se reabre nem se reescreve
  quem teve prioridade. Correção material exige cancelamento e novo racha.
- Preço com pagamento real fica imutável (`PRICE_LOCKED`) até o contrato 2.9. Sem essa
  trava, ciclo `pending|under_review`, sessão ou claim ativa retorna
  `PAYMENT_INTENT_ACTIVE`; somente `presumed`/`exempt` pode ser recomputado com aviso.
- Ao alterar preço depois dos estornos completos e sem disputa, fecha o ciclo antigo e cria
  `charge_version+1` `pending` com o novo valor; ledger antigo permanece e N14 explica.
- A data local da ocorrência nunca muda (`DATE_LOCKED`); para outro dia, cancela-se e
  cria-se outro racha. Mudança apenas do horário que
  afete prazos exige `confirm_deadline_recompute: true`, revalida claims/provas sob lock
  e envia **N14**; local/horário material envia N14.
- T1 com `payment_deadline_applied_at` e T2 com fase já fechada não voltam atrás
  (`DEADLINE_ALREADY_APPLIED`). Mover prazo ainda não aplicado para o passado exige a
  confirmação e aplica a transição na mesma transação.
- **Saída:** `{ match, summary, changed_fields, notified_count }`.

#### 3.2.1 Matriz normativa de recomputação

Toda mudança trava o racha e filhos afetados na ordem global, incrementa `revision` e gera
novo `summary`. Marker/job antigo ainda não aplicado vira `skipped_stale`; evento já enviado
nunca é apagado/retratado e alteração material cria N14. Dedupe inclui o instante derivado,
por exemplo `n1:<general_opens_at>`, `n5:<profile>:<payment_due_at>` e
`n13:<kind>:<scheduled_at>`.

| Campo alterado / condição | Derivados e regras atômicas | Notificação/marker |
|---|---|---|
| T0 antes de TP | Recalcula TP e N1 em **T0−30 min**. Se o novo N1 já passou, marca antigo/novo `skipped_stale`; não envia atrasado | N14 se usuários já viram agenda; N1 usa nova chave |
| T1 atrasado, marker não aplicado | Para prova aberta, `review_expires_at=max(finalized_at+2h,new_T1)`. Claims não podem existir antes do T1 aplicado. Reagenda N5 | Antigo N5 `skipped_stale`; novo N5 só se futuro |
| T1 adiantado, marker não aplicado | Mesma recomputação; se `new_T1<=now()`, chama `apply_payment_deadline` e reconcilia provas cujo novo deadline também venceu, na mesma transação e sem reescrever escalação após o início | N5 obsoleto não dispara; N6/N7/N8/N4/N11 saem dos markers aplicados |
| T1 com marker aplicado | Imutável, mesmo que o valor textual original seja anterior | `DEADLINE_ALREADY_APPLIED` |
| T2 atrasado antes de fechar | Reagenda fechamento/N20. Claim ativa conserva expiração prometida e nunca é estendida; pode terminar antes do novo T2 | Antigo marker/job stale; N14 material |
| T2 adiantado antes de fechar | Se `new_T2<=now()`, fecha a entrada atômica. Claim já ativa conserva sua expiração, limitada por `starts_at`; não cria nova promoção depois do T2 | Reagenda N20/N14; jobs antigos stale |
| T2 com fase fechada | Imutável | `DEADLINE_ALREADY_APPLIED` |
| `starts_at` adiantado, antes do jogo | Recalcula T1/T2 ainda não aplicados pelos offsets relativos e executa suas linhas desta matriz; marker aplicado fica como fato e a edição exige ordem válida. Reduz `claim.expires_at` para `min(atual,new_start)`, nunca aumenta; sessão sem claim válida fica inutilizável | Recalcula N5/N13; instância passada fica stale; N14 |
| `starts_at` atrasado, antes do jogo | Recalcula T1/T2 ainda não aplicados pelos offsets e deadlines de prova decorrentes de T1. Claims ativas não ganham tempo; marker já aplicado não muda. N13 é recalculada | Novas instâncias futuras N5/N13; antigas não enviadas stale; N14 |
| Jogo iniciado/marker de start | Início/fim deixam de ser editáveis; participação e publicação não voltam de fase | `MATCH_STARTED` |
| `ends_at` antes do início | Para prova ainda não purgada, `purge_after=new_end+7d`; nunca ressuscita binário. Se cancelado, prevalece `canceled_at+7d` e mudança não estende | Reagenda `done`; N14 material |
| Local/endereço antes do início | Recompõe resumo/mapa; não toca deadline, claim, prova ou retenção | N14; lembretes futuros usam texto atual |
| Preço destravado | Exige todos os ciclos reais `refunded`, nenhuma prova indecidida/disputa. Fecha ciclo anterior e cria nova versão/valor; nenhum status/evento antigo muda | N14 com nova obrigação; N5 usa ciclo/versão nova |

N13 sempre cria **dois fatos in-app**: 20h do dia anterior no fuso e 3h antes. Um único
boolean controla em conjunto apenas as deliveries externas; não existe preferência para uma
só. Mudança de horário recalcula ambas; entrega já enviada permanece e a outra é reagendada.

### 3.3 `cancel_match(match_id, reason_code, note?, request_id)`

- **Saída:** `{ ok, refunds: [{ profile_id, payment_cycle_id, resolution_id,
  refund_due_event_id, amount, status: 'refund_due' }], reviews_pending,
  canceled_claims, total }`.
- `reason_code` é `organizer_decision|venue_unavailable|weather|other`; `note` privada ≤500.
- Se o racha pertence a série, resolve `recurrence_id` sem lock e trava
  grupo→recorrência→racha antes de qualquer filho; nunca tenta travar recorrência depois do racha.
- **Transação:** cancela racha e claims, marca todos os pagamentos reais
  cria uma obrigação `refund_due` por resolução, reduz `purge_after` das provas para
  cancelamento + 7 dias, grava exatamente um `match_canceled` com somente `reason_code`
  e **N15**. Provas `under_review` continuam decidíveis; não viram pagamento/estorno
  automático nem voltam à fila/N11: tornam-se pendência financeira visível até decisão ou
  expurgo. Claims são canceladas; sessões ainda não finalizadas viram `cleanup_pending`
  e o worker apaga o objeto antes de gravar `expired`. O texto orienta quem
  já pagou no banco a procurar o organizador.
- A série continua. A criação da próxima ocorrência é idempotente por
  `(recurrence_id, occurrence_key)`.

### 3.4 `advance_recurrence(recurrence_id, terminal_match_id)` — sistema

Trava grupo→recorrência→racha terminal, revalida série `active`, versão e segredo Pix ativo.
Calcula no fuso da série a primeira ocorrência posterior a
`greatest(terminal_match.starts_at, now())`, aplica a política de offset, registra
`skipped_occurrences` e insere com conflito ignorado. Copia rule/template/Pix da versão travada
e registra `recurrence_version`. Cancelamento, conclusão e retries não criam duas ocorrências
nem racha retroativo. Se a série foi desligada, retorna `{created:false,reason:'inactive'}`.
Saída normal: `{ created, match_id?, occurrence_key?, recurrence_version,
skipped_occurrences }`.

### 3.5 `update_recurrence(recurrence_id, patch, request_id)` /
`set_recurrence_active(recurrence_id, active, confirm_cancel_generated_match, request_id)`

- **Quem:** dono ou organizador ativo do grupo.
- Patch de regra/template/Pix é schema fechado, incrementa `version` e afeta somente a próxima
  ocorrência ainda não criada; racha materializado nunca muda por edição de série.
- `active=false` trava a série e o eventual próximo racha. Se ele ainda não possui
  participante/ciclo, cancela-o na mesma transação; se possui efeito, exige confirmação e usa
  `cancel_match`, com estornos/auditoria/notificação normais. A corrida desligar×advance termina
  sem ocorrência futura ativa.
- Reativar exige configuração Pix `active` e calcula a primeira ocorrência futura; nunca
  ressuscita segredo purgado nem ocorrência cancelada.
- Erros: `RECURRENCE_INVALID` · `RECURRENCE_INACTIVE` ·
  `RECURRENCE_CANCEL_CONFIRMATION_REQUIRED` · `PIX_PURGED` · `NOT_ORGANIZER`.

## 4. Notas, sorteio e publicação

### 4.1 `set_rating(group_id, profile_id, stars, request_id)`

- **Quem:** organizador; `stars` inteiro 1–5.
- **Saída:** `{ ok, matchday_logged }`.
- **Erro:** `STARS_RANGE`.
- **Efeitos:** histórico privado sempre; se houver racha relevante fechado no dia,
  trilha pública `rating_changed_matchday` sem nota anterior/nova. Incrementa a revisão
  dos rachas ainda sorteáveis afetados.

### 4.1.1 `get_my_rating(group_id)` e contestação de nota

`get_my_rating` retorna a própria nota atual e `rating_history_id` alvo, independentemente de
`ratings_visibility`; permanece disponível à pessoa removida enquanto essa versão estiver no
prazo de retenção. A política do grupo controla somente a visão da nota de terceiros.

- `open_rating_dispute(group_id, rating_history_id, reason, request_id)`: somente o perfil
  alvo daquela FK composta; motivo 1–500; cria disputa/hold apenas da versão e prazo de sete
  dias. Erros: `RATING_DISPUTE_TARGET_INVALID` · `RATING_DISPUTE_ALREADY_OPEN`.
- `respond_rating_dispute(dispute_id, response, request_id)`: dono/organizador elegível,
  resposta ≤1000; nunca altera a nota silenciosamente.
- `resolve_rating_dispute(dispute_id, resolution, corrected_stars?, reason, request_id)`:
  `corrected|upheld|deleted`; correção chama `set_rating`, grava
  `corrected_rating_history_id` e troca `ratings.current_history_id` atomicamente; delete só é
  aceito se a versão contestada ainda for a atual. Admin só após SLA/escalonamento. Erros:
  `RATING_DISPUTE_NOT_OPEN` · `RATING_DISPUTE_AUTHORITY_REQUIRED` · `CONCURRENT_CHANGE`.
- `escalate_rating_dispute` após SLA cria o evento uma vez. A trilha de disputa é append-only;
  o purge suspende exclusivamente `rating_history_id` alvo até resolução e revisão do prazo.

### 4.2 `POST /draw { match_id, team_count, confirm_unequal_sizes, request_id }` — Edge

- **Pré:** organizador; lista reconciliada em fase `open` ou `closed`; titulares de linha
  pagos, presumidos ou isentos conforme a regra; todos com nota. Antes de T2, a lista
  continua aberta durante o cálculo e só fecha no commit bem-sucedido.
- **Processo:** lê `{ revision, snapshot }`, executa a especificação binária v3 com semente
  de 256 bits (ramo exato em streaming para N≤12; heurística com orçamento de avaliações
  versionado para N>12) e chama
  `commit_draw(expected_revision, ...)`, que fecha a lista atomicamente se ainda estava
  aberta. Entrada concorrente muda a revisão e produz `DRAW_STALE`, sem congelamento.
- **Saída estável/idempotente:** `{ draw_id, algorithm_version: 'v3', revision, exact,
  evaluation_count }`. Times/notas não entram no outcome.
- **Erros:** `RATINGS_MISSING` · `PAYMENTS_PENDING` · `TEAM_COUNT_INVALID` ·
  `UNEQUAL_TEAMS_CONFIRMATION_REQUIRED` · `LIST_EMPTY` · `DRAW_TIMEOUT` · `DRAW_STALE`.
- Semente/snapshot não saem do servidor. Timeout de parede retorna `DRAW_TIMEOUT` e não chama
  commit nem persiste resultado parcial. Fim do orçamento heurístico retorna o melhor estado
  de passe completamente avaliado, de forma determinística. O benchmark adversarial é gate.

### 4.2.1 `get_draw_proposal(draw_id)` — projeção privada

Revalida organizador ativo, racha e retenção do artefato. Retorna
`{ teams: [{ team_number, players: [{ profile_id, stars }], average }], score }` somente para
ajuste; retry de `/draw` não embute essa projeção. Após purge: `DRAW_PRIVATE_ARTIFACT_EXPIRED`.

### 4.3 `publish_draw(match_id, draw_id, final_teams, request_id)`

- Revalida revisão, conjunto de jogadores, duplicatas, tamanhos permitidos e autoria.
- `final_teams` é um draft completo: pode ter ficado temporariamente inválido apenas no
  cliente, mas o commit exige cada jogador exatamente uma vez e o mesmo multiconjunto de
  tamanhos permitido pela proposta. Ajustes são calculados no servidor comparando proposta e
  composição final; cada perfil que mudou vira `manual_move(from_team,to_team)`, ordenado por
  UUID. Nenhum estado intermediário 2/4 é persistido.
- **Saída:** `{ published_at, team_count, notified_count }`.
- **Erros:** `DRAW_STALE` · `PLAYER_MISMATCH` · `TEAM_SIZE_INVALID` ·
  `ALREADY_PUBLISHED` quando existe publicação atual. Histórico invalidado não bloqueia;
  republicação exige novo draw e fica na trilha.
- **Efeitos:** cria uma `team_publications` imutável, seus `teams`/`team_members` e
  `team_rating_snapshots`, aponta `matches.current_publication_id`, muda a fase para
  `teams_published` e grava **N12** na mesma transação.

## 5. Grupo, convites, identidade e privacidade

Todas as mutações abaixo também recebem `request_id`.

| Função | Saída principal | Erros específicos | Efeitos |
|---|---|---|---|
| `create_group(name, request_id)` | `{ group_id, invite_id }` | `GROUP_LIMIT` | trava perfil; reconta até 5 grupos; `owner_id` = criador; membership `organizer` |
| `join_by_code(code, request_id)` / `join_by_invite(token, request_id)` | `{ status: 'pending', reentry: boolean }` | `CODE_INVALID` · `INVITE_REVOKED` · `INVITE_EXPIRED` · `INVITE_USED` · `GROUP_FULL` · `GROUP_ARCHIVED` · `GROUP_LIMIT` | trava perfil→grupo→membership→convite; incremento condicional `used_count<max_uses`; `removed` volta somente a `pending`, com novo pedido, `player`, mensalista off e aprovação obrigatória; capacidade pending+active; N19 |
| `approve_member(group_id, profile_id, approve, request_id)` | `{ status }` | `MEMBERSHIP_ALREADY_DECIDED` · `GROUP_LIMIT` · `GROUP_FULL` | trava perfil→grupo→membership; reconta cota/capacidade; trilha; aprovado → N16 |
| `remove_member(group_id, profile_id, reason, request_id)` | `{ ok, refunds, invalidated_matches }` | `IS_OWNER` · `PROOFS_PENDING` | sob locks em ordem estável, remove de rachas futuros, invalida publicações atingidas, cria ledger/N14 para restantes, trilha do grupo e N17 para a pessoa; membership muda por último |
| `set_role(group_id, profile_id, role, request_id)` | `{ role: 'organizer' ou 'player' }` | `OWNER_ONLY` | papel do owner continua definido por `groups.owner_id`; trilha do grupo + N25 ao afetado |
| `set_monthly(group_id, profile_id, enabled, request_id)` | `{ enabled }` | `MONTHLY_DISABLED` | não altera inscrição já materializada; trilha do grupo |
| `set_ratings_visibility(group_id, visibility, confirm_members_visibility, request_id)` | `{ visibility: 'private' ou 'members' }` | `OWNER_ONLY` · `VISIBILITY_CONFIRMATION_REQUIRED` | confirmação viaja no contrato e é exigida para `members`; trilha do grupo + N24 a todos os membros ativos |
| `transfer_ownership(group_id, new_owner_id, request_id)` | `{ owner_id }` | `NOT_ACTIVE_MEMBER` | troca `groups.owner_id` sob um lock; trilha do grupo + N25 ao antigo e novo dono |
| `leave_group(group_id, request_id)` | `{ ok, refunds, invalidated_matches }` | `OWNER_MUST_TRANSFER` · `PROOFS_PENDING` | mesma remoção atômica dos rachas futuros; publicações atingidas exigem novo sorteio; pagamentos viram `refund_due`; trilha do grupo; membership muda por último |
| `create_match_invite(match_id, expires_at, max_uses, request_id)` | `{ invite_id, expires_at, max_uses }` | `TEAMS_ALREADY_PUBLISHED` · `MATCH_STARTED` | `expires_at <= starts_at`; bloqueia publicação atual; outcome não contém token; banco guarda nonce público + digest |
| `accept_match_invite(token, request_id)` | `{ outcome: { match_player_id,payment_cycle_id,claim_id?,logical_result:'guest_added' }, current: { status,claim_status?,claim_expires_at? } }` | `INVITE_REVOKED` · `INVITE_EXPIRED` · `INVITE_USED` · `NO_OPEN_SLOT` · `TEAMS_ALREADY_PUBLISHED` · `MATCH_STARTED` | resolve IDs e trava perfil→grupo→racha→convite; consumo/capacidade/ciclo são atômicos; prazo/status só em projeção fresca; nunca devolve Pix; `is_guest`; auditoria |

`get_invite_share_link(invite_id)` é projeção sensível para dono ou organizador com membership
`active` no momento da chamada; `created_by` é registro histórico, sem autoridade (decisão
humana M2-D4, 2026-09-26, registrada em `25-plano-m2.md` §8.1). Reconstitui
token autenticado a partir de ID + `token_version` + `public_nonce` de 16 bytes e HMAC do
cofre, revalida revogação/expiração e não
persiste a URL na idempotência. Token usa fragmento, sai do endereço após a troca e não entra
em logs. Bytes são `id(16)||version(u16 BE)||nonce(16)||mac(32)`, base64url sem padding;
domínio é `colete/invite/v1` ou `colete/match-invite/v1`. Rotação incrementa versão, troca
nonce/digest e invalida a anterior. Dump sem chave do cofre não forja nem reconstrói MAC.

### 5.1 Autenticação e vínculo

No beta: e-mail/senha com OTP por SMTP externo e Google OAuth. Callback incompleto leva
a `complete_profile`. `link_google_identity(request_id)` exige sessão recente; conflito
de e-mail nunca mescla perfis silenciosamente. Apple entra apenas com o app nativo.

### 5.2 `accept_policies(versions, request_id)`

`versions` é um array não vazio de
`{ document_type: 'terms'|'privacy', version: string }`, sem duplicatas e ordenado
canonicamente por `document_type` e depois `version`. Esta é toda a entrada externa além de
`request_id`; HMAC, versão de chave e contexto do ator pertencem somente à chamada interna.

- **Quem:** perfil correspondente à sessão verificada, inclusive quando há aceite pendente.
- **Validação:** cada par precisa existir em `private.policy_documents` e ser a única versão
  `mandatory=true` atual do tipo. Versão desconhecida, superada ou não obrigatória retorna
  `VALIDATION`. A operação falha fechada se o catálogo não tiver exatamente uma versão
  obrigatória de `terms` e uma de `privacy`.
- **Fonte:** derivada pelo servidor, nunca pelo payload. O primeiro aceite daquele tipo usa
  `source='signup'`; aceites de novas versões do mesmo tipo usam `source='reauth'`.
- **Saída:** `{ outcome: { accepted: [{document_type,version}], logical_result:
  'policies_accepted' }, current: { accepted_current: [{document_type,version}], pending:
  [{document_type,version}] } }`. O array do outcome conserva a ordem canônica; nem outcome
  nem `current` carregam conteúdo integral dos documentos.
- **Idempotência:** retry reproduz o outcome e relê `current`. Um aceite já existente é
  sucesso sem nova linha/evidência; a unique por perfil/tipo/versão é a segunda barreira.
- **Gate:** mutações comuns retornam `VALIDATION` enquanto houver versão obrigatória pendente.
  Permanecem disponíveis `complete_profile`, `accept_policies`, logout/revogação, leitura
  própria e canais de privacidade.
- **Catálogo vazio, decisão explícita:** o fail-closed acima vale para `accept_policies`, que
  exige exatamente uma versão obrigatória de `terms` e uma de `privacy`. O gate das mutações
  comuns é escrito em outros termos — *enquanto houver versão obrigatória pendente* — e
  portanto **não fecha sobre catálogo vazio**: sem nenhuma versão obrigatória, nada está
  pendente e a mutação passa. Isso é deliberado. O catálogo nasce vazio e só recebe conteúdo
  na migration pré-beta que publica textos e digests efetivos; fechar o gate antes disso
  deixaria o app inutilizável, sem existir aceite possível que o destravasse. A assimetria é
  segura porque as duas metades erram para lados opostos: `accept_policies` nunca registra
  aceite de um catálogo que não sabe descrever, e as mutações comuns nunca ficam bloqueadas
  por uma obrigação que ninguém publicou.
- **O que é proibido é o catálogo pela metade.** Com `terms` obrigatório e `privacy` não,
  `accept_policies` falha fechado enquanto as mutações comuns passam após o aceite de um único
  tipo — a única combinação em que o gate mede algo diferente do que o aceite exige. O
  catálogo é coerente em exatamente dois estados: vazio, ou com uma versão obrigatória de cada
  tipo. A suíte pgTAP afirma essa invariante, e `16-roadmap.md` §2 transforma o estado povoado
  em gate de convite ao beta.

### 5.3 `request_data_export(request_id)` / `delete_account(request_id)`

- `request_data_export` cria `privacy_requests` + `data_exports(queued)` e enfileira
  `build_data_export:<export_id>`. O ZIP contém somente categorias enumeradas no mapa, schema
  `colete-export-v1`, manifesto/checksum e dados do próprio titular; exclui credencial, Pix,
  binário/fingerprint, HMAC, segredos push e PII de terceiros além do mínimo contextual.
- Quando pronto, expira em no máximo 24 h. `GET /data-exports/:id/content` exige sessão não
  revogada e reautenticação recente. Sob row lock, faz compare-and-set `ready→downloaded` e
  grava o instante **antes** de abrir o stream sem signed URL/cache; logo apenas uma tentativa
  concorrente vence. Queda posterior consome o one-shot e exige gerar novo export. A Edge
  enfileira purge ao terminar/abortar, e a reconciliação remove qualquer `downloaded` restante;
  só depois do delete confirmado zera path/digest.
- `delete_account` não tenta apagar Auth dentro da RPC. Na transação inicial, transfere grupos/
  casos, cancela e enfileira purge de exports, cria `deletion_requests`, muda para
  `deletion_pending`, revoga o `session_id` atual e remove toda autoridade de RLS/RPC. Grupo
  solo é arquivado. Sem substituto/canal seguro retorna `FINANCIAL_SUBSTITUTE_REQUIRED` e não
  inicia a saga.
- Worker limpa ownership/objetos/assinaturas, chama `auth.admin.deleteUser` com retry e depois
  `finalize_deletion`. `not found` após tentativa conta como Auth já apagado. O finalize
  desidentifica e conclui; ledger/auditoria necessários permanecem pelo prazo sem depender de
  `auth.users`. JWT antigo não recupera acesso porque `deletion_pending` é consultado em toda
  autorização.
- **Saídas:** export `{ export_id,status:'queued' }`; exclusão
  `{ deletion_request_id,status:'requested' }`. Status é consultado por projeção própria.
- **Erros:** `EXPORT_ALREADY_PENDING` · `EXPORT_EXPIRED` · `RECENT_REAUTH_REQUIRED` ·
  `DELETION_ALREADY_PENDING` · `FINANCIAL_SUBSTITUTE_REQUIRED`.

### 5.4 Operações administrativas sem painel

- `set_group_suspension(group_id, suspended, reason, request_id)`: somente Admin; exige
  motivo. Ao suspender, abre/transfere antes cada prova/estorno/disputa aberta para
  `financial_case` Admin; então muda `suspended_at`, revoga mutações e grava log + N26/N28.
  Restaurar cria novo evento e reatribuição explícita; nunca altera o de suspensão.
- `set_profile_access(profile_id, status, reason, request_id)`: somente Admin; `status` é
  `active|suspended|banned`; exige motivo. Antes de revogar sessões, chama 2.11 e prova que
  cada caso foi transferido/aberto. Grava log + N26 ao afetado e N28 às partes financeiras.
  `active` é restauração auditada.
- `admin_transfer_ownership(group_id, new_owner_id, reason, request_id)`: somente Admin,
  novo dono ativo; atualiza a fonte única `groups.owner_id`, grava trilha administrativa,
  trilha do grupo e N25 às pessoas afetadas.
- Conta suspensa bloqueia mutações comuns, não leitura própria, exportação, contestação ou
  pedido de revisão. Grupo suspenso bloqueia novas inscrições, convites, edição, draw e
  publicação; casos financeiros passam à autoridade substituta. Exclusão pode ser bloqueada
  pelo contrato 2.11. Erros: `PROFILE_SUSPENDED` · `GROUP_SUSPENDED` ·
  `FINANCIAL_SUBSTITUTE_REQUIRED`.

### 5.5 `revoke_current_session(request_id)`

Grava o `session_id` do JWT atual na denylist antes de o cliente encerrar a sessão no Auth.
Cobre logout seguro; perder todas as sessões de uma vez continua sendo efeito de
`delete_account` e de `set_profile_access`, via `deletion_pending` e suspensão.

- **Quem:** qualquer sessão autenticada cujo JWT traga `session_id`. Conta suspensa ou banida
  pode revogar a própria sessão: é operação de segurança do titular, não mutação de domínio,
  e cabe na mesma exceção de §5.4 que preserva leitura própria, exportação e recurso.
- **Entrada canônica:** `{}`. O ator vem do contexto de claims verificadas pela Edge e nunca
  do payload externo; no caminho administrativo, `auth.uid()` não representa o usuário final.
- **Saída:** `{ outcome: { session_id, revoked_at, logical_result: 'session_revoked' },
  current: { session_active: false } }`. O `session_id` do outcome é o do próprio chamador,
  que já o carrega no token. O `expires_at` fica fora do outcome: prazo de sessão é estado
  mutável, proibido por §0.1.
- **Erros:** `UNAUTHENTICATED` (sem sessão, ou JWT sem `session_id`) · `VALIDATION` · erros
  comuns de idempotência.
- **Idempotência:** retry com o mesmo `request_id` devolve o outcome gravado. `request_id`
  novo sobre sessão já revogada também é sucesso: a inserção é `on conflict do nothing` e o
  `expires_at` original é preservado, para que uma segunda chamada não encurte a negação.
- **Efeitos:** insere em `private.revoked_auth_sessions` com
  `expires_at = revoked_at + auth_session_max_lifetime_seconds`, lido de
  `private.app_limits`. Nenhum efeito externo: encerrar a sessão no Auth é ação do cliente, e
  falhar nela não desfaz a revogação — a partir do commit o token já não vale em nenhum
  caminho privilegiado.
- **Por que o tempo máximo de sessão e não a validade do access token:** `jwt_expiry`
  (`3600s`) é a vida do access token. Com rotação de refresh token ligada, a sessão continua
  cunhando access tokens novos com o mesmo `session_id`. Se a linha da denylist expirasse
  junto com o token, o job de limpeza a removeria e a sessão revogada voltaria a valer —
  falha silenciosa e temporizada. A negação precisa cobrir a vida máxima da sessão.

### 5.6 `update_profile(patch, request_id)`

Edição dos próprios dados da tela 13. Não é evento de grupo: não gera notificação nem trilha.

- **Quem:** o próprio titular, conta `active`.
- **Allowlist de campos graváveis:** `name`, `nickname`, `position`, `dominant_foot`,
  `shirt_number`. Qualquer outra chave em `patch` retorna `VALIDATION`. O payload nunca
  escolhe `id`, `auth_user_id`, `account_status`, `status_changed_at`, `deidentified_at` ou
  `created_at`.
- **Semântica do patch:** ausência não altera o campo; `null` explícito limpa campo opcional.
  `name` não aceita `null`. É a distinção ausência×`null` de §0.1, e por isso ela precisa
  sobreviver à canonicalização.
- **Validação:** `name` em NFC, 2–80 caracteres após trim; `nickname` ≤ 30;
  `dominant_foot` em `left|right|both`; `shirt_number` inteiro de 0 a 99; `position` em
  `goalkeeper|defender|midfielder|forward`. Todos os opcionais aceitam `null`.
- String vazia (ou só espaços, após trim) em campo de texto opcional retorna `VALIDATION`,
  não vira `null` silenciosamente. `null` é a única forma de limpar campo opcional — duas
  grafias para o mesmo estado é como nasce bug de comparação na projeção pública.
- `position` é preferência exibida, não papel operacional. Aparece no cartão do time e, por
  `01` §5.7, não entra no sorteio na v1 — balanceamento por posição é v2, restrição suave.
  `position = 'goalkeeper'` não tem relação com a vaga de goleiro do racha, que é conceito de
  match, tem contagem e preço próprios e é decidida por `list_kind`. Nenhuma função pode
  derivar uma coisa da outra.
- `photo_url` fica fora desta allowlist até existir o bucket `avatars`. Quando entrar, a
  validação exige caminho do próprio perfil dentro de `avatars`, nunca URL arbitrária.
- **Saída:** `{ outcome: { logical_result: 'profile_updated' }, current: { name, nickname,
  position, dominant_foot, shirt_number } }`. O outcome não ecoa os campos gravados: eles
  continuam mutáveis depois do commit e `current` é projeção fresca.
- **Erros:** `VALIDATION` · `UNAUTHENTICATED` · `FORBIDDEN` · `PROFILE_SUSPENDED` · erros
  comuns de idempotência.
- **Idempotência:** patch vazio é sucesso sem efeito. Retry com o mesmo `request_id` devolve
  o outcome gravado e `current` recalculado.
- **Efeitos:** grava apenas as colunas presentes no patch, em uma única atualização da
  própria linha.

### 5.7 `complete_profile(profile, request_id)`

Cria o vínculo interno para uma sessão verificada que ainda não possui perfil. A entrada
externa é `{ name, nickname?, position?, dominant_foot?, shirt_number? }` + `request_id`;
nenhum ator, status ou ID é aceito. Somente a Edge exclusiva pode iniciar a RPC interna.

- **Validação:** `name` é obrigatório. Trim, NFC, limites, enums, inteiros e semântica de
  opcionais são exatamente os de `update_profile`; `photo_url` continua fora. O Auth ID é
  extraído das claims verificadas pela Edge. `profiles.auth_user_id unique` permanece como
  barreira independente contra dois perfis.
- **Ator bootstrap:** antes de consultar se o perfil existe, deriva-se
  `actor_key='bootstrap:' || digest_hex`, válido exclusivamente para
  `operation='complete_profile'`, com hexadecimal minúsculo e:

  ```text
  digest = SHA-256(
    UTF8("colete/bootstrap-actor/v1") || 0x00 || UUID_BYTES(auth_user_id)
  )
  ```

  `UUID_BYTES` são os 16 bytes em ordem textual/RFC 4122: remove-se o hífen da forma canônica
  minúscula e decodificam-se os 32 hexadecimais; não se hasheia o texto do UUID. Vetor comum:
  `01890f7e-e948-7c53-b13a-4a36e4b7d21e` → bytes
  `01890f7ee9487c53b13a4a36e4b7d21e` → digest
  `21409156bb1cbd9d8cadf3814edcf230153e3378c09dc03ebf5ed8940c9c4d3a`.
- **Transação:** `actor_id` pode ser nulo em `executing_uncommitted`. Depois de inserir o
  perfil, a mesma transação liga o registro idempotente a `actor_id=profile_id` antes de
  marcar `completed`; ele não permanece nulo.
- **Saída:** `{ outcome: { profile_id, logical_result: 'profile_created' }, current: { name,
  nickname, position, dominant_foot, shirt_number } }`, com `current` relido por projeção
  autorizada.
- **Idempotência:** o mesmo `request_id` encontra a chave bootstrap mesmo depois da criação e
  reproduz o outcome. Outro `request_id` após a criação retorna `VALIDATION`; em qualquer
  corrida, a unique de `auth_user_id` impede o segundo perfil.
- **Erros:** `VALIDATION` · `UNAUTHENTICATED` · erros comuns de idempotência.

## 6. Preferências, dispositivos e entrega

- `set_notification_preference(event_type, external_enabled, request_id)`: por evento e
  somente para push/e-mail. O registro in-app sempre é criado. Tipos `required=true` retornam
  `PREFERENCE_REQUIRED` ao tentar desligar entrega externa. Para N13 existe apenas
  `event_type='match_reminders'`: ligado cria deliveries externas para as duas instâncias
  fixas (dia anterior 20h e 3h antes); desligado suprime/cancela ambas as deliveries ainda
  não enviadas, mas mantém os dois registros no sino. Não há subtoggle.
- `register_push_subscription(endpoint, keys, device_label, request_id)`: faz upsert do
  dispositivo do próprio perfil; a unicidade global transfere/desabilita vínculo anterior
  do mesmo endpoint em aparelho compartilhado e mata deliveries pendentes da conta
  anterior antes da transferência. Endpoint/chaves nunca aparecem em logs.
- `revoke_push_subscription(subscription_id, request_id)`: próprio dispositivo.
- `mark_notification_read(notification_id, request_id)`: próprio destinatário.

O dispatcher reivindica cada `notification_delivery` por lease, registra tentativa,
resposta sanitizada e próximo retry. Resposta 404/410 do push revoga a assinatura. Após
o limite, move a entrega para dead-letter e alerta; a notificação in-app permanece.

## 7. Reconciliação e jobs

### 7.1 `reconcile_match(match_id, request_id)`

Pode ser chamado por cron, sistema ou organizador. Resolve o vínculo sem lock e, se recorrente,
trava grupo→recorrência→racha; se avulso, grupo→racha. Sob esses locks, aplica na ordem: TP, T0,
T1, claims vencidas, análises vencidas, T2, fechamento financeiro do início, done e
recorrência. Cada transição tem
`transition_markers`; lembrete atrasado obsoleto recebe `skipped_stale`, conforme o
catálogo, em vez de ser enviado. Repetir produz o mesmo estado. Ação humana exige
organizador, grava `job_runs` com `run_key=request:<request_id>` e o evento público
sanitizado `match_reconciled`; não usa o log reservado às ações globais do Admin.

Na análise expirada antes de `starts_at`, o jogador sai da titularidade e entra no tier
prioritário 10; a prova segue pendente. Se `now() >= starts_at`, a participação não muda:
o marker registra atraso financeiro e N11 usa a variante pós-início. No fechamento do
início, toda espera com resolução aceita que não foi adicionada recebe `refund_due` +
N22; starter com ciclo `under_review` permanece para decisão humana. Isso não desloca starter válido.
Racha cancelado não executa a transição de fila; apenas sinaliza a pendência financeira.
Aprovação tardia segue 2.5.

| Job | Frequência | Contrato observável |
|---|---|---|
| `reconcile_due_matches` | por minuto | reconcilia transições vencidas; grava `job_runs` |
| `dispatch_notifications` | por minuto | lease, retry/backoff por canal, dead-letter |
| `expire_upload_sessions` | 10 min | marca `cleanup_pending`, remove órfão e só então grava `expired`; falha faz retry |
| `purge_proofs` | diário | apaga binário; nulifica caminho/fingerprint; ledger `proof_purged` após sucesso |
| `process_external_effects` | por minuto | sagas Auth/Storage/export por `dedupe_key`, lease, reconciliação e backoff |
| `expire_data_exports` | por hora | remove arquivo antes de marcar `expired`; exclusão pendente tem prioridade |
| `finalize_financial_appeal_windows` | por hora | finaliza primeira instância sem apelação ou garante caso Admin único |
| `expire_rating_dispute_sla` | por hora | escalona somente a disputa/versão alvo, sem evento duplicado |
| `purge_draw_private_artifacts` | diário | apaga input/seed/HMAC/score/snapshots após 12 meses, não composição |
| `purge_idempotency_outcomes` | diário | outcome 30d → `payload_expired`; tombstone até 24 meses |
| `apply_retention` | diário | aplica mapa, inclusive conteúdo de notificação separado; disputa não estende binário/fingerprint além de 7 dias |
| `health_check_jobs` | 5 min | alerta atraso/falha e alimenta saúde no painel |

## 8. Catálogo de erros estáveis

Esta lista é a autoridade única. Um código novo precisa entrar aqui antes de ser usado:

`ACTIVE_PAYMENTS_REMAIN · ADMIN_REASON_REQUIRED · ALREADY_PUBLISHED ·
ALREADY_UNDER_REVIEW · AMOUNT_MISMATCH_CONFIRMATION_REQUIRED · AUDIT_PAYLOAD_INVALID ·
APPEAL_DEADLINE_EXPIRED · CLAIM_ACTIVE · CLAIM_COOLDOWN · CLAIM_EXPIRED · CLAIM_REQUIRED ·
CODE_INVALID · CONCURRENT_CHANGE · DATE_LOCKED · DEADLINE_ALREADY_APPLIED ·
DELETION_ALREADY_PENDING · DISPUTES_OPEN · DISPUTE_ALREADY_OPEN ·
DISPUTE_APPEAL_EXISTS · DISPUTE_AUTHORITY_REQUIRED · DISPUTE_NOT_APPEALABLE ·
DISPUTE_NOT_OPEN · DISPUTE_TARGET_INVALID · DRAW_PRIVATE_ARTIFACT_EXPIRED · DRAW_STALE · DRAW_TIMEOUT ·
EXPORT_ALREADY_PENDING · EXPORT_EXPIRED ·
FINANCIAL_CASE_NOT_ASSIGNED · FINANCIAL_CASE_NOT_FOUND · FINANCIAL_CASE_OPEN ·
FINANCIAL_SUBSTITUTE_REQUIRED · FORBIDDEN · GROUP_ARCHIVED · GROUP_FULL · GROUP_LIMIT ·
GROUP_SUSPENDED · IDEMPOTENCY_CONFLICT · IDEMPOTENCY_EXPIRED ·
IDEMPOTENCY_WAIT_TIMEOUT · INTERNAL · INVITE_EXPIRED · INVITE_REVOKED · INVITE_USED · IS_OWNER ·
LIST_CLOSED · LIST_EMPTY · MATCH_CANCELED · MATCH_DONE · MATCH_NOT_CANCELED ·
MATCH_NOT_OPEN · MATCH_STARTED · MEMBERSHIP_ALREADY_DECIDED · MONTHLY_DISABLED ·
MONTHLY_ONLY · NOT_ACTIVE_MEMBER · NOT_FOUND · NOT_MEMBER · NOT_ORGANIZER · NOT_STARTER ·
NOTIFICATION_PAYLOAD_INVALID · NO_OPEN_SLOT · OPENING_LOCKED · OTHER_LIST ·
OWNER_MUST_TRANSFER · OWNER_ONLY · PAYMENTS_PENDING · PAYMENT_ALREADY_REAL ·
PAYMENT_ALREADY_RESOLVED · PAYMENT_CYCLE_CONFLICT · PAYMENT_CYCLE_NOT_FOUND ·
PAYMENT_INTENT_ACTIVE · PAYMENT_IN_REVIEW · PAYMENT_RELATION_NOT_FOUND · PIX_INVALID ·
PIX_LOCKED · PIX_PURGED · PLAYER_MISMATCH · PREFERENCE_REQUIRED · PRICE_INVALID · PRICE_LOCKED ·
PROFILE_SUSPENDED · PROOFS_PENDING · PROOF_EVIDENCE_PURGED · PROOF_RESOLVED_ELSEWHERE ·
RATINGS_MISSING · RATING_DISPUTE_ALREADY_OPEN · RATING_DISPUTE_AUTHORITY_REQUIRED ·
RATING_DISPUTE_NOT_OPEN · RATING_DISPUTE_TARGET_INVALID · RECENT_REAUTH_REQUIRED ·
RECURRENCE_CANCEL_CONFIRMATION_REQUIRED · RECURRENCE_INACTIVE · RECURRENCE_INVALID · REFUNDS_PENDING ·
REFUND_CORRECTION_FORBIDDEN · REFUND_NOT_FOUND · SESSION_ALREADY_FINALIZED ·
STARS_RANGE · STORAGE_OBJECT_MISSING · TEAMS_ALREADY_PUBLISHED · TEAM_COUNT_INVALID ·
TEAM_SIZE_INVALID · TIME_ORDER · UNAUTHENTICATED · UNEQUAL_TEAMS_CONFIRMATION_REQUIRED ·
UPLOAD_INVALID · UPLOAD_SESSION_EXPIRED · UPLOAD_SESSION_NOT_USABLE · VALIDATION ·
VISIBILITY_CONFIRMATION_REQUIRED · WAITLIST_HAS_PRIORITY`.

`IDEMPOTENCY_WAIT_TIMEOUT` é retryable; `CONCURRENT_CHANGE` e `DRAW_STALE` exigem refetch;
os demais só são retryable quando o envelope trouxer `retry_after`. Validador central de
auditoria/notificação devolve, respectivamente, `AUDIT_PAYLOAD_INVALID` e
`NOTIFICATION_PAYLOAD_INVALID`; eles nunca são expostos como sucesso parcial.

Código novo entra neste documento e em teste de contrato antes de entrar na aplicação.
