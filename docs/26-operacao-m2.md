# Operação e evidências do M2

Status deste documento: operacional. Ele não altera requisitos nem substitui
as fontes normativas `10`, `13`, `14`, `16`, `17`, `22` e `25`. Continua de
`23-operacao-m1-b.md`. Fica fora de `docs/spec-manifest.sha256` pelo mesmo
precedente de `19`–`21` e `23`: registra o que aconteceu, não é contrato
congelado.

Este documento registra as fatias do M2 à medida que entram: fundação,
membership, convites e renomeação do grupo.

## Fatia 1 — `0015_group_foundation.sql`

### O que foi entregue

| Objeto | Contrato provado |
| --- | --- |
| `public.groups`, `public.group_members`, `public.group_invites` | colunas exatas de `10` §3, sem `role='owner'` e sem `code_digest` (M2-D3 é da `0017`); FKs sem cascade; `max_uses > 0`, `0 <= used_count <= max_uses`, `removal_count >= 0`, `public_nonce` de 16 bytes, `token_version > 0`, `token_digest` único |
| três linhas novas em `private.app_limits` | `max_active_groups_per_profile=5 groups`, `max_group_capacity=100 members`, `group_invite_default_max_uses=100 uses`; o vocabulário de unidades cresce de forma append-only com `groups`, `members` e `uses` |
| índices | `groups(owner_id)`, `group_members(profile_id, status)`, parcial `group_members(group_id) where status in ('pending','active')` e `group_invites(group_id)` |
| trigger constraint diferido `private.enforce_group_owner_membership` | `DEFERRABLE INITIALLY DEFERRED` em `groups` (insert e update de `owner_id`/`archived_at`) e em `group_members` (update de `status`, `group_id`, `profile_id` e delete); relê o estado corrente pelo `group_id` e recusa no commit grupo não arquivado sem membership `active` do dono |
| RLS forçada e três policies de leitura | `groups`: membro ativo de grupo não arquivado; `group_members`: membro ativo lê o grupo, pendente lê somente a própria linha; `group_invites`: dono ou organizador `active` no momento da leitura (M2-D4) |
| grants por coluna para `authenticated` | `groups` sem `photo_url`, `archived_at` e `created_at`; `group_members` sem `removed_at` e `removal_count`; `group_invites` somente `id`, `group_id`, `expires_at`, `revoked_at`, `max_uses`, `used_count` e `created_at` |
| helpers de policy `private.current_group_profile_id`, `is_active_group_member`, `can_read_group_invites` | `security definer`, sem recursão de RLS; conta `deletion_pending|deleted` não resolve perfil |
| bucket `group-photos` | privado, sem policy de cliente, sem limite de tamanho ou MIME antes de existir produtor |
| `private.group_deletion_candidates` | organizadores elegíveis de `10` §6: perfil `active`, membership `active`, papel `organizer`, diferente de quem sai |
| `private.require_financial_deletion_substitute(uuid, uuid[], uuid[])` | agora `volatile`; recebe grupos e candidatos já travados, revalida sob lock, transfere pela M2-D8, bloqueia com `FINANCIAL_SUBSTITUTE_REQUIRED` ou arquiva o grupo solo pela M2-D9; a assinatura antiga foi removida |
| `public.delete_account` | resolve sem lock, trava `FOR NO KEY UPDATE` (M2-D13) perfis do titular e dos candidatos em bytes crescentes, depois grupos, depois memberships; passa a `removed` toda membership não-dona; enfileira `delete_storage_object`/`group_photo` com chave por ocasião |
| `private.group_photo_deletion_request` | relação `group_photo → grupo → owner → deletion_request`, exigindo grupo arquivado e a chave da ocasião da saga |
| `deletion_has_pending_storage`, `sync_deletion_failure_from_effect`, `worker_get_deletion_effect_target`, `worker_confirm_deletion_effect` | `group_photo` na lista fechada do fence, no mapeamento de falha terminal com marcador durável e no alvo e confirmador fenced do handler genérico |
| `public.update_profile`, `public.request_data_export` (M2-D14) | redefinidas a partir do texto vivo com a trava do perfil do ator em `FOR NO KEY UPDATE`; mais nenhuma mudança |
| `worker_get_data_export_build_target` e `supabase/functions/_shared/data-export.ts` | `groups.json` no `colete-export-v1`: uma entrada por membership própria com `group_id`, `group_name`, `role`, `status`, `is_monthly`, `joined_at`, `removed_at` e `removal_count`, em ordem de `group_id` |
| `scripts/test-group-foundation.mjs` (`db:test:groups`) | harness de commit real, barreira de concorrência e Storage local, também no job `database-security` |
| `scripts/lock-barrier.mjs` | barreira de `25` §2 compartilhada: tratador na mesma instrução que cria a promessa, espera amarrada ao detentor, conexões distintas afirmadas, registro das promessas em voo |
| `scripts/harness-guard.mjs` | guarda de catorze harnesses: `db:test:groups`, `db:test:export`, `db:test:idempotency`, `db:test:invites`, `db:test:members`, `db:test:membership`, `db:test:rename`, `db:test:matches`, `db:test:match-players`, `db:test:ratings`, `db:test:teams`, `db:test:geocode`, `db:test:group-deletion` e `db:test:photos`: na falha, inclusive por `unhandledRejection`, relata a causa primeiro, recusa trabalho novo por um sinal de abort, espera o trabalho em voo com prazo e, estourado o prazo, encerra as conexões do harness pelo `application_name`; só então limpa, numa conexão própria, roda o censo à parte e sai com código 1; marca e varredura dos usuários Auth de harness, que nunca apaga usuário com perfil |

### Decisões de implementação

- **Fonte textual canônica.** A versão viva de `delete_account` não existia como
  texto em migration nenhuma: a `0013` a reescreveu dinamicamente a partir da
  `0012`. O texto da `0015` partiu do `pg_get_functiondef` do banco recriado até
  a `0014`. As quinze funções que a `0015` cria ou redefine são comparadas pelo
  harness, byte a byte, com o corpo vivo. A contraprova embutida acusa um byte a
  mais e o texto antigo da `0012`, que ainda cita `public.data_exports`.
- **Assinatura do guard.** Pelo §3.3, o guard recebe os grupos já travados, o
  que exige nova assinatura. A antiga foi removida para não restar overload
  morto. O guard trava de novo os grupos recebidos, na mesma ordem crescente,
  para nunca operar sobre linha que não travou. No caminho de `delete_account`
  essa aquisição nunca espera: o lock que protege as linhas do guard é o de
  grupos de `delete_account`, tomado depois dos perfis e antes das
  memberships. A prova `guard-lock` observa os dois separadamente (ver
  “Correções da revisão independente”).
- **Modo das travas (M2-D13).** Travas de domínio usam `FOR NO KEY UPDATE`;
  `FOR UPDATE` fica só onde a transação apaga a linha ou altera coluna de
  chave. A regra vem da M2-D13 (PR #37), que emendou o `docs/25` §2 e o
  `docs/10` §10 (“sempre `FOR UPDATE`”), e da M2-D14, que manda redefinir as
  funções do M1-B que gravam idempotência e travam o perfil do próprio ator. As
  doze cláusulas de lock das funções que a `0015` cria ou redefine:

  | Função | Linha travada | Modo | Justificativa |
  | --- | --- | --- | --- |
  | `require_financial_deletion_substitute` | `groups` | `FOR NO KEY UPDATE` | altera `owner_id` e `archived_at`, que não são chave; não apaga |
  | `delete_account` | `profiles` do titular e dos candidatos | `FOR NO KEY UPDATE` | altera `account_status` e `status_changed_at`; não apaga nem toca `id` ou `auth_user_id` |
  | `delete_account` | `groups` | `FOR NO KEY UPDATE` | o guard altera `owner_id` e `archived_at`; não apaga |
  | `delete_account` | `group_members` | `FOR NO KEY UPDATE` | altera `status` e `removed_at`; a chave `(group_id, profile_id)` não muda; não apaga |
  | `worker_get_deletion_effect_target` | `external_effects` | `FOR NO KEY UPDATE` | não altera nem apaga o efeito |
  | `worker_confirm_deletion_effect` | `external_effects` | `FOR NO KEY UPDATE` | não altera nem apaga o efeito |
  | `worker_confirm_deletion_effect` | `data_exports` | **`FOR UPDATE`, mantido** | zera `storage_path`, coluna `unique` desde a `0003`: o próprio `UPDATE` toma `FOR UPDATE`, e travar mais fraco antes seria promover o lock na transação |
  | `worker_get_data_export_build_target` | `external_effects` | `FOR NO KEY UPDATE` | não altera nem apaga o efeito |
  | `worker_get_data_export_build_target` | `profiles` | `FOR NO KEY UPDATE` | só lê o perfil; o lock existe para serializar com a exclusão e continua conflitando com `FOR NO KEY UPDATE` e com o `FOR UPDATE` das funções do M1-B |
  | `worker_get_data_export_build_target` | `data_exports` | `FOR NO KEY UPDATE` | altera `status` e `snapshot_at`; o índice único de `profile_id` é parcial e não conta como chave |
  | `update_profile` (M2-D14) | `profiles` do ator | `FOR NO KEY UPDATE` | altera `name`, `nickname`, `position`, `dominant_foot` e `shirt_number`, que não são chave; não apaga |
  | `request_data_export` (M2-D14) | `profiles` do ator | `FOR NO KEY UPDATE` | não altera o perfil; o lock serializa os pedidos do titular, e o segundo recebe `EXPORT_ALREADY_PENDING` |
- **Revalidação por igualdade de conjuntos.** Sob lock, o guard recalcula os
  grupos próprios não arquivados e os organizadores elegíveis. Qualquer
  diferença do conjunto resolvido sem lock, nos dois sentidos, aborta com
  `CONCURRENT_CHANGE`. Isso cobre candidato que ficou inelegível, organizador
  elegível fora do conjunto e grupo próprio novo.
- **Trigger de owner também nas colunas da chave.** O §3.1 pede update de
  `status` e delete. Mudar `group_id` ou `profile_id` da linha do dono o retira
  do grupo do mesmo modo; o trigger também dispara nessas colunas e reavalia o
  grupo antigo e o novo. Ele é `security definer` porque as tabelas têm RLS
  forçada: executado por papel sujeito a RLS, leria zero linhas e falharia
  aberto (`14` §5.2).
- **`removed` sempre com `removed_at`.** `group_members_removed_at_check` fixa
  `(status = 'removed') = (removed_at is not null)`, que `10` §3 (reentrada zera
  `removed_at`) e a M2-D9 pressupõem.
- **Âncora da foto na saga.** O efeito é reconhecido pela chave da ocasião
  (`delete_storage_object:group_photo:<group_id>:<deletion_request_id>`) e, no
  fence, também pelo próprio objeto: grupo arquivado do titular com
  `photo_url` e sem efeito `dead`. `delete_account` enfileira o efeito para todo
  grupo próprio arquivado com foto. No M2 só a própria saga arquiva grupo, então
  o conjunto coincide com “grupos arquivados nesta exclusão”; a escolha evita
  que um arquivamento futuro por outra via deixe o fence esperando um efeito
  que ninguém criou.
- **Grupo vivo nunca perde a foto.** Alvo e confirmador respondem `VALIDATION`
  quando a chave não é a da ocasião ou o grupo não está arquivado sob o dono
  daquela saga. Grupo transferido tem outro dono e não casa.
- **Grants por coluna.** O plano manda conceder somente as colunas das telas
  10, 11, 17 e 25. `archived_at` e `created_at` ficaram de fora porque a policy
  não devolve grupo arquivado e nenhuma dessas telas mostra a criação;
  `removed_at` e `removal_count` ficaram de fora porque nenhuma tela os exibe e
  a reentrada chega pelo outcome da RPC. A revisão da fatia pode ampliar a
  lista, nunca incluir `photo_url`, `token_digest`, `public_nonce` ou
  `created_by`.
- **Testes antigos ajustados.** `0008_settle_rls_debt.test.sql` passa a contar
  as três tabelas novas entre as que têm leitor direto, e
  `0012_account_deletion.test.sql` substitui o guard pela nova assinatura para
  continuar provando o bloqueio atômico do ponto de extensão. O precedente é a
  `0013`, que ajustou os mesmos arquivos. `src/lib/database.types.ts` foi
  regenerado pelo `generate:db-types`.

### Provas e números medidos

Medidos em 2026-09-27, depois da correção da conferência da segunda revisão,
sobre `origin/main` com o #37 e o #38, PostgreSQL 17.6 local (imagem
`17.6.1.171`), Supabase CLI 2.118.0, Node 24.15.0, no banco recriado do zero
pelas quinze migrations. Os números da primeira entrega (2026-09-26: 937
asserções, 115 na `0015`, 21 linhas `ok` no harness), os da primeira rodada de
correções (964 e 142), os da segunda (27 linhas `ok` e 74 usuários no harness
de grupos) e as dez execuções por harness da terceira ficam substituídos por
estes. Os tempos são de parede de `npm run`, medidos por execução.

- `npm run db:test`: 14 arquivos, **968** asserções, todas verdes. O arquivo
  `0015_group_foundation.test.sql` tem **146** asserções: as 115 da entrega e
  as 31 de ACL (uma de cobertura da lista e duas por função, nas 15 funções).
- `npm run db:test:groups`: **29** linhas `ok` e `Group foundation harness
  passed.` em **5** execuções seguidas, de 2,13 s a 2,25 s. Em todas,
  `mutual-storm` imprimiu `pairs with 40P01=0, CONCURRENT_CHANGE=20, both
  ok=0`, e o disparo do mesmo titular imprimiu `pairs with 40P01=0,
  DELETION_ALREADY_PENDING=20`. Cada execução cria e remove 96 usuários Auth,
  96 perfis, 65 grupos e três objetos no bucket `group-photos`; o censo de
  tabelas termina igual ao baseline, exceto `auth.audit_log_entries`, que o
  GoTrue escreve por desenho: **+98** linhas por execução, nas cinco.
- `npm run db:test:export`: **16** linhas `ok` em **5** execuções seguidas, de
  1,78 s a 1,82 s; em todas, o `groups.json` do ZIP real tem os **477** bytes
  esperados e o disparo do mesmo titular imprimiu `pairs with 40P01=0,
  EXPORT_ALREADY_PENDING=20`. O censo termina igual ao baseline, exceto
  `auth.audit_log_entries`: **+36** por execução.
- `npm run db:test:idempotency`: **7** linhas `ok` em **5** execuções seguidas,
  de 5,14 s a 5,22 s; em todas, o disparo de `update_profile` do mesmo ator
  imprimiu `pairs with 40P01=0`, e a fixture termina sem resíduo.
- `auth.users` tinha 0 linhas antes das quinze execuções acima e 0 depois;
  `public.profiles`, `private.idempotency_records`, `private.job_runs` e
  `private.external_effects`, também 0.
- Os demais harnesses continuam verdes: `db:test:gateway` (9 linhas `ok`),
  `db:test:worker` (8) e `db:test:deletion` (10).
- Browser: `test:auth:web` 8 testes em 10,7 s; `test:privacy:web` 4 em 13,6 s;
  `test:smoke:web` 6 em 1,9 s. Unitários: 164 testes em 20 arquivos.
- Correção lateral do harness de grupos: com 74 usuários, a criação em rajada
  única fez o GoTrue local recusar pedidos, e os IDs só eram registrados depois
  de todas as criações, então a limpeza não alcançava os já criados (142
  usuários residuais observados e removidos do banco local). A criação passou a
  lotes de oito, com cada ID registrado assim que o usuário existe.

Correspondência entre `25` §3.5 e a evidência:

| Prova exigida | Onde |
| --- | --- |
| banco do zero | `npm run db:reset` aplica `0001`–`0015` |
| constraints e FKs | pgTAP, seções “Estrutura” e “Constraints e FKs” |
| trigger de owner em commit real | harness, prova `owner-trigger` |
| RLS positiva e cruzada por tabela | pgTAP, “RLS positiva e cruzada com o papel-sonda” |
| zero DML administrativo | pgTAP, grants por coluna e negações sob `service_role` |
| transferência ao organizador elegível; M2-D8 com as duas fixtures | harness, prova `deletion` |
| transferência em grupo suspenso com `suspended_at` inalterado (M2-D10) | harness, prova `deletion` |
| `FINANCIAL_SUBSTITUTE_REQUIRED` sem organizador elegível | pgTAP e harness, prova `deletion` |
| grupo solo com pendente arquivado (M2-D9) | pgTAP (fence) e harness, prova `deletion` |
| memberships não-donas em `removed`, contagem caindo em um | harness, prova `deletion`: `pending + active` de 3,2 para 2,1 |
| guard `volatile` travando sob concorrência | harness, prova `guard-lock`: o lock de grupos de `delete_account`, observado antes das memberships e do guard, nas ordens A→B e B→A; e o lock do próprio guard, chamado diretamente sobre grupo do caso 3; as duas provas que `25` §3.3 exige desde a oitava emenda |
| grupo transferido conserva a foto e não recebe efeito | harness, prova `deletion`, fixture `susp` com objeto real no bucket |
| foto pendente impedindo Auth | pgTAP e harness, prova `photo-fence` |
| crash e retry do `delete_storage_object` de `group_photo` | harness, prova `photo-fence`: antes do delete, depois do delete e depois da confirmação; e o worker Edge real de ponta a ponta |
| `groups.json` byte a byte e allowlist negativa | `data-export.test.ts`, snapshot pgTAP e `db:test:export`: ZIP real pedido pelo gateway Edge, construído pelo worker Edge e baixado pela Edge de export, comparado byte a byte com literal escrito à mão |
| ACL de toda função nova ou redefinida | pgTAP, “ACL de toda função nova ou redefinida pela 0015”: `pg_proc.proacl` exato e `has_function_privilege` para `service_role`, `authenticated`, `anon` e `PUBLIC` nas 15 funções |
| censo por valor | pgTAP, “Censo por valor”, com contraprova |
| ausência de resíduo | harness, censo de tabelas e de objetos, rodado pelo guard depois da limpeza, também quando o harness falha; usuários Auth pela marca do harness, varridos no início e no fim |
| pares sem `40P01` | harness, provas `lock-order` (dono × organizador escolhido), `mutual-order` (candidatura mútua) e `export-order` (exclusão × build), nas duas ordens, pela barreira de `25` §2; e `mutual-storm`, 20 pares simultâneos sem barreira |
| par do mesmo titular em `delete_account` (M2-D13, `25` §2) | harness, prova `same-titular`: barreira nas duas ordens e 20 pares simultâneos; uma chamada cria a saga e a outra recebe `DELETION_ALREADY_PENDING` |

### Contraprovas executadas

Cada mutação foi aplicada ao banco local recriado, a prova correspondente rodou
(`COLETE_GROUP_PROOF=<prova>`, `supabase test db` ou `db:test:export`) e o
banco foi recriado em seguida. Todas reprovaram:

| Mutação | Prova | Saída |
| --- | --- | --- |
| guard `stable` | `guard-lock` | `guard A→B: the owner deletion: rejected 0A000 SELECT FOR NO KEY UPDATE is not allowed in a non-volatile function` |
| lock de perfis de `delete_account` de volta a `FOR UPDATE` | `mutual-order` | `mutual order 1: low → high: the barrier observed a deadlock (SQLSTATE 40P01): deadlock detected` |
| idem | `mutual-storm` | `mutual storm: 20 of 20 pairs hit 40P01` |
| idem | `lock-order` | `pair 1 organizer: expected CONCURRENT_CHANGE, got fulfilled {…}` |
| sem o lock de grupos de `delete_account` | `guard-lock` | `guard A→B: the wait happened after the memberships lock, so delete_account did not lock the group` |
| sem o lock do próprio guard | `guard-lock` | `guard direct call: the competitor finished before its lock wait was observed: rejected P0001 FINANCIAL_SUBSTITUTE_REQUIRED` |
| efeito `group_photo` para todo grupo próprio com foto, arquivado ou não | `deletion` | `photo_effects: 1` e `storage_pending: true` contra `0` e `false` esperados |
| `grant execute` de `enforce_group_owner_membership()` a `PUBLIC` | pgTAP | `0015` testes 92 e 107 (`proacl exato` e `EXECUTE … pela ACL da função`); nenhuma asserção anterior acusava |
| `grant execute` de `worker_confirm_deletion_effect` a `anon` | pgTAP | `0015` testes 101 e 116, além do `0011` teste 49 |
| `grant execute` do guard a `service_role` | pgTAP | `0015` testes 85, 96 e 111 e `0004` teste 86; a negação por papel (`0015` teste 82), que depende de `USAGE` no schema, continua passando, porque só a ACL mudou |
| snapshot com as memberships de todos do grupo | `db:test:export` | `groups.json differs byte for byte: […]` |
| trigger só em `groups` | `owner-trigger` | `owner membership removed through group_members only: the owner invariant was not enforced at commit` |
| escolha só por `profile_id` | `deletion` | `M2-D8: the oldest joined_at must win over insertion order and profile_id` |
| escolha por ordem física | `deletion` | idem |
| perfis dos candidatos travados depois do grupo | `lock-order` | `owner deletion → chosen organizer deletion: the barrier observed a deadlock (SQLSTATE 40P01): deadlock detected` |
| `group_photo` fora de `deletion_has_pending_storage` | `photo-fence` | `after deletion: {"status":"deleting_auth","storage_pending":false,"auth_ready":true,"auth_effects":1}` |
| validador do export aceitando `photo_url` | `data-export.test.ts` | `rejects forbidden group photo locator in the negative allowlist counterproof` → `expected [Function] to throw an error` |

A numeração dos testes de ACL acima foi remedida em 2026-09-27 sobre o código
desta rodada, com as 15 funções na lista.

| Mutação (M2-D14 e `25` §3.3) | Prova | Saída |
| --- | --- | --- |
| trava de `request_data_export` de volta a `FOR UPDATE` | `db:test:export` | `same-actor export order 1: the barrier observed a deadlock (SQLSTATE 40P01)` |
| idem | 20 pares sem barreira | `same-actor export storm without barrier: 20 pairs, pairs with 40P01=15, EXPORT_ALREADY_PENDING=5` |
| trava de `update_profile` de volta a `FOR UPDATE` | `db:test:idempotency` | `same-actor update_profile order 1: the barrier observed a deadlock (SQLSTATE 40P01)` |
| idem | 20 pares sem barreira | `same-actor update_profile storm without barrier: 20 pairs, pairs with 40P01=20` |
| sem o lock de grupos de `delete_account` e sem o do guard | `guard-lock` | `guard A→B: the wait happened after the memberships lock, so delete_account did not lock the group` |

O `docs/25` §3.3, vindo do #37, dizia que retirar somente o lock de grupos de
`delete_account` não reprovava a prova do guard e que a contraprova precisava
retirar os dois. A prova desta fatia é mais estrita: a sonda da membership
distingue as duas aquisições, e retirar somente o lock de `delete_account` já a
reprova (tabela acima). A oitava emenda do `docs/25` substituiu aquele parágrafo
pelas duas provas que a fatia entrega, cada uma com a contraprova que a reprova.

### Achado da barreira, corrigido pela revisão independente

A versão anterior deste documento dizia, sobre o par dono × organizador
escolhido: “Não há `40P01` nem violação da ordem global.” A frase era falsa. Ela
generalizava a partir de uma topologia em que o ciclo não pode existir, e a
revisão independente do PR #36 (achado 1, P1) o reproduziu.

**Causa.** O `INSERT` do registro de idempotência, feito por
`private.acquire_delete_account_idempotency` antes da resolução dos candidatos,
executa a FK `idempotency_records.actor_id → profiles` (`0004`, linha 28). A
verificação da FK toma `FOR KEY SHARE` no perfil do próprio titular e o segura
até o commit. É um lock de perfil tomado fora da aquisição em bytes crescentes,
implícito, sem `select … for update` no texto. `FOR KEY SHARE` conflita com
`FOR UPDATE`. Com dois titulares A e B, A dono de um grupo em que B é
organizador ativo e B dono de um grupo em que A é organizador ativo, e
`id(A) < id(B)`:

1. A insere a idempotência e segura `FOR KEY SHARE` em A;
2. B insere a idempotência e segura `FOR KEY SHARE` em B;
3. A trava `{A, B}` em ordem: obtém A e espera B, por causa do `FOR KEY SHARE`
   de B;
4. B trava `{A, B}` em ordem: espera A, que A segura `FOR UPDATE`;
5. ciclo: `40P01 deadlock detected`.

No par que a barreira exercitava, a candidatura existe num só sentido, e o
`FOR KEY SHARE` do organizador só era pedido depois de o dono já segurar o
perfil dele. Por isso o organizador “esperava no `INSERT` da idempotência”, o
sintoma observado e registrado como inofensivo.

**Correção.** A M2-D13 (emenda ao `docs/25` §2 e ao `docs/10` §10, no PR de
documentação paralelo) fixa `FOR NO KEY UPDATE` para travas de domínio e
reserva `FOR UPDATE` para a transação que apaga a linha ou altera a chave. A
`0015` aplica a regra nas cláusulas de lock que define (tabela em
“Decisões de implementação”). `FOR NO KEY UPDATE` é compatível com o
`FOR KEY SHARE` da FK e conflita com `FOR NO KEY UPDATE` e `FOR UPDATE`, então
duas exclusões continuam serializadas entre si e com o build do export.

**Efeito no par já existente.** Na ordem dono → organizador, o organizador
deixa de esperar na FK: passa pela idempotência, resolve sem grupos próprios e
espera o dono no lock do próprio perfil. Depois do commit do dono, a
revalidação sob lock encontra o grupo recebido fora do conjunto resolvido e
aborta com `CONCURRENT_CHANGE`, exatamente o que o §3.3, caso 1, manda. O retry
com o mesmo `request_id` arquiva o grupo como solo. A prova `lock-order` passou
a exigir esse aborto e o retry; o estado final exigido é o mesmo de antes.

**Provas novas.** `mutual-order` roda o par de candidatura mútua com a
barreira do §2 nas duas ordens. O detentor segura `FOR NO KEY UPDATE` o segundo
recurso de A, que nas duas ordens é o perfil de maior byte, e B precisa ser
observado esperando por A. `mutual-storm` dispara 20 pares ao mesmo tempo, sem
barreira, imprime a contagem e reprova com qualquer `40P01`; todo
`CONCURRENT_CHANGE` é repetido com o mesmo `request_id` e precisa concluir, e
cada par termina com os dois grupos arquivados, as quatro memberships
`removed` e os dois titulares em `deletion_pending`.

**Números medidos** em 2026-09-27, contra o banco local:

| Implementação | `mutual-order`, ordem 1 (A de menor byte) | `mutual-order`, ordem 2 (A de maior byte) | `mutual-storm`, pares com `40P01` |
| --- | --- | --- | --- |
| `8242f29`, todas as travas em `FOR UPDATE` | `40P01` | sem ciclo: B espera A no `INSERT` da idempotência e depois conclui sem `CONCURRENT_CHANGE` | **19/20** |
| correção com só o lock de perfis de `delete_account` de volta a `FOR UPDATE` | `40P01` em **10 de 10** execuções | idem | **20/20** em três execuções |
| correção | A conclui, B recebe `CONCURRENT_CHANGE`, retry arquiva os dois grupos | idem | **0/20**; 20 `CONCURRENT_CHANGE`, todos convergidos no retry |

Na ordem 2 a implementação antiga não fecha ciclo porque A já segura o perfil
de B antes de B inserir a idempotência. O ciclo depende de os dois titulares
inserirem a idempotência antes de qualquer um travar o perfil do outro; a
ordem 1 da barreira força essa intercalação, e o disparo simultâneo a produz
naturalmente.

### M2-D14: o mesmo padrão no perfil do próprio ator

A primeira rodada de correções registrou, como achado lateral para decisão
humana, que funções do M1 não redefinidas pela `0015` repetiam o padrão. A
decisão M2-D14 (2026-09-27) mandou a `0015` redefini-las.

**Mecanismo.** A função grava a idempotência, cuja FK segura `FOR KEY SHARE` no
perfil do ator, e depois trava o mesmo perfil `FOR UPDATE`. Duas chamadas
concorrentes da mesma pessoa, com `request_id` diferentes (dois cliques, duas
abas), seguram cada uma o próprio `FOR KEY SHARE` e pedem `FOR UPDATE` no mesmo
perfil: cada uma espera o `FOR KEY SHARE` da outra, e o upgrade termina em
`40P01`. A nota do `docs/25` §2 vinda do #37 dizia que a serialização
continuava; para o mesmo ator, isso era falso, e a nota foi reescrita.

**Auditoria pelo banco vivo.** Depois do `db:reset`, foram listadas pelo
`pg_proc` todas as funções que gravam idempotência, diretamente ou pelos
envelopes `private.acquire_idempotency`,
`private.acquire_delete_account_idempotency` e
`private.acquire_request_data_export_idempotency`, com as cláusulas de lock de
cada corpo e dos helpers que ele chama:

| Função | Entra? | Por quê |
| --- | --- | --- |
| `update_profile` | **sim** | grava idempotência e trava o próprio perfil `FOR UPDATE` (`0006`, linha 613) |
| `request_data_export` | **sim** | grava idempotência e trava o próprio perfil `FOR UPDATE` (`0013`, linha 823) |
| `delete_account` | já redefinida | a `0015` já a reescrevia; todas as suas travas estão em `FOR NO KEY UPDATE` |
| `accept_policies` | não | grava idempotência e insere `policy_acceptances`, cuja FK toma só `FOR KEY SHARE`; não trava o perfil, e nenhum helper que chama o trava |
| `revoke_current_session` | não | grava idempotência e insere `revoked_auth_sessions`, cuja FK toma só `FOR KEY SHARE`; não trava o perfil |
| `complete_profile` | não | a idempotência nasce sem `actor_id` (ator ainda sem perfil), o perfil é inserido na própria transação e não há trava sobre perfil existente |
| `finalize_deletion` | não | trava o perfil `FOR UPDATE`, mas é do worker e não grava idempotência; zera `auth_user_id`, coluna única, caso em que a regra manda `FOR UPDATE` |

As duas funções foram redefinidas na `0015` a partir do `pg_get_functiondef`
do banco recriado até a `0014`; a única mudança é o modo da trava, com
comentário. `create or replace` preserva a ACL (`{postgres=X/postgres,
service_role=X/postgres}`), que o pgTAP afirma. O comparador de texto canônico
passou a cobrir quinze funções.

**Provas.** No harness de cada domínio, pela barreira do §2, nas duas ordens: o
detentor segura o perfil em `FOR NO KEY UPDATE`, compatível com os dois
`FOR KEY SHARE`; A e B são observadas esperando pelo detentor, entre a
idempotência e a trava do perfil. O módulo `scripts/lock-barrier.mjs` reúne a
barreira usada pelas duas provas.

- `db:test:export`: `request_data_export` do mesmo titular. Exige um pedido
  vencedor e o outro com `EXPORT_ALREADY_PENDING`, e um único export por
  titular.
- `db:test:idempotency`: `update_profile` do mesmo ator, cada chamada com um
  campo diferente. Exige as duas concluídas e o perfil final com as duas
  mutações.
- Nos dois, 20 pares disparados ao mesmo tempo, sem barreira, com a contagem
  impressa antes das asserções e reprovação com qualquer `40P01`.

**Números medidos** em 2026-09-27:

| Implementação | Barreira, ordem 1 | Barreira, ordem 2 | 20 pares sem barreira, pares com `40P01` |
| --- | --- | --- | --- |
| `request_data_export`, `FOR UPDATE` (texto da `0013`) | `40P01` | — | **8**, **12** e **9** em três execuções |
| `request_data_export`, correção com a trava de volta a `FOR UPDATE` | `40P01` em **10/10** | `40P01` em **3/3** | **15**, **5** e **9** |
| `request_data_export`, correção | um vence, outro `EXPORT_ALREADY_PENDING` | idem | **0**; 20 `EXPORT_ALREADY_PENDING` |
| `update_profile`, `FOR UPDATE` (texto da `0006`) | `40P01` | — | **20**, **20** e **20** |
| `update_profile`, correção com a trava de volta a `FOR UPDATE` | `40P01` em **10/10** | `40P01` em **3/3** | **20**, **19** e **20** |
| `update_profile`, correção | as duas concluem, serializadas | idem | **0** |

Na primeira linha de cada função, a prova parou na ordem 1; a ordem 2 foi
medida sobre a correção com a trava revertida.

### Correções da revisão independente

A revisão independente do PR #36 registrou um P1, tratado na seção anterior, e
quatro P3. Os quatro foram corrigidos nesta fatia.

- **Prova do guard (achado 2).** A prova `guard-lock` antiga passava mesmo sem o
  lock do guard, porque a espera que observava era a do lock de grupos que
  `delete_account` toma antes de chamá-lo. Ela agora observa o lock que de fato
  protege as linhas do guard: com o detentor segurando o grupo, o perfil do
  titular já está travado e a membership do dono ainda está livre, o que fixa
  a espera no passo de grupos de `delete_account`. Sem esse lock, a espera só
  acontece dentro do guard, depois das memberships, e a prova reprova. Além
  disso, uma chamada direta do guard, como `postgres`, sobre grupo do caso 3,
  que não faz `UPDATE`, isola o lock do próprio guard: sem ele, a chamada
  responde sem esperar e a prova reprova. A mutação `stable` continua acusada,
  agora com `SELECT FOR NO KEY UPDATE is not allowed in a non-volatile
  function`.
- **Grupo transferido (achado 3).** A fixture `susp` ganhou foto com objeto
  real no bucket. Depois do commit real da exclusão, a prova `deletion` exige
  `photo_url` preservado, zero efeito `group_photo` para o grupo,
  `deletion_has_pending_storage` falso, um efeito `delete_auth_user` e o
  objeto ainda presente no Storage.
- **ACL das funções (achado 4).** A negação “`service_role` não chama o guard”
  passava pela falta de `USAGE` no schema `private`, não pela ACL da função. A
  asserção foi mantida, com descrição que diz isso, e o pgTAP ganhou, para as
  15 funções que a `0015` cria ou redefine, `pg_proc.proacl` exato e
  `has_function_privilege` para `service_role`, `authenticated`, `anon` e
  `PUBLIC`, que não consulta o schema. `EXECUTE` a `PUBLIC` em
  `enforce_group_owner_membership()` só é acusado por essas asserções.
- **`groups.json` real (achado 5).** O `db:test:export` cria um titular com uma
  membership própria de dono e uma `removed` num grupo alheio, com terceiro
  ativo nos dois grupos, foto e convite. O pedido passa pelo gateway Edge
  (`identity/request_data_export`), o build pelo worker Edge real
  (`worker/process_external_effects`) e o download pela Edge de export. O
  `groups.json` do ZIP baixado é comparado byte a byte com um literal escrito à
  mão, que fixa JCS, ordem por `group_id`, UTF-8 cru e o formato
  `+00:00` com que o PostgreSQL emite `timestamptz` em `jsonb`, e com a entrada
  do `manifest.json` (tamanho e SHA-256). A allowlist negativa percorre o ZIP
  inteiro: IDs e nomes do terceiro e do dono alheio, localizador da foto,
  digest, nonce, ID do convite e as chaves `photo_url`, `owner_id`,
  `profile_id`, `token_digest`, `public_nonce`, `created_by` e `token`.

### Correções da segunda revisão independente

A segunda revisão independente do PR #36 (sobre `ab624fc`) deu “merge após
correções”, com um P2 e seis P3, e levou ao planejador nove travas do M1-B. Os
números abaixo foram medidos em 2026-09-27 na pilha local; as mutações de banco
foram aplicadas por `create or replace` a partir do `pg_get_functiondef` vivo e
restauradas pelo mesmo texto, e as de arquivo, revertidas antes da validação.

- **`unhandledRejection` nos harnesses da M2-D14 (P2).** `db:test:export` e
  `db:test:idempotency` não registravam o tratador que `25` §2 exige; uma
  rejeição sem tratador derrubava o processo antes de qualquer `finally`, e o
  censo do export, uma asserção dentro do `finally`, podia substituir a causa
  real na execução seguinte. Auditoria dos harnesses `db:test:*`: somente
  `db:test:groups` já registrava o tratador; `db:test:export` e
  `db:test:idempotency`, que usam `scripts/lock-barrier.mjs`, não o
  registravam; `db:test:gateway`, `db:test:worker` e `db:test:deletion` não o
  registram e não usam a barreira. O módulo novo `scripts/harness-guard.mjs`
  instala o tratador nos três harnesses que usam a barreira: ele relata a causa
  primeiro, roda a limpeza uma única vez, depois de as promessas acompanhadas
  assentarem, e sai com código 1; se a limpeza falhar, a falha aparece depois
  da causa. O censo do export e a asserção de resíduo da idempotência saíram de
  dentro do `finally` e passaram a rodar na limpeza do guard. O export ganhou
  limpeza inicial da fixture de IDs fixos. Contraprova, com uma rejeição sem
  tratador injetada no meio de cada harness: com o tratador, os três saem com
  código 1 e a mensagem começa por `not ok - db:test:<harness>: unhandled
  promise rejection: Error: INJECTED …`; sem o tratador, os três caem com o
  erro do Node, sem limpeza, e o resíduo cresce de 0 para 96 usuários e 96
  perfis (grupos), 108 e 105 (export) e 109 e 106 (idempotência). A execução
  sem tratador do export deixou também uma linha em `private.job_runs`, fora do
  alcance da varredura de Auth, removida à mão. Esta rodada afirmou também que,
  com o tratador, `auth.users` e `public.profiles` terminavam com 0 linhas nos
  três harnesses. A afirmação não se sustentou: a limpeza corria junto com o
  harness, e a conferência reproduziu resíduo no export e na idempotência. Ver
  a seção seguinte.
- **Barreira sem checagem de conexões (P3).** `sameActorPair` e o `barrierPair`
  e o `guard-lock` do harness de grupos afirmam agora, por
  `assertDistinctConnections`, que observador, detentor, A e B são backends
  distintos, com `application_name` distinto. Contraprova, com
  `request_data_export` de volta a `FOR UPDATE` e A e B na mesma conexão no
  `db:test:export`: sem a checagem, a prova de barreira passa (`ok - same-actor
  export pair: waits observed in both orders, no 40P01`) e só a tempestade
  reprova, com 10 e 2 pares em `40P01` em duas execuções; com a checagem, a
  prova reprova antes (`same-actor export order 1: the barrier needs distinct
  connections`). O papel `service_role` dentro da transação continua coberto
  pela ACL do pgTAP, não pela barreira.
- **Usuários Auth residuais (P3).** A marca de usuário de harness é o e-mail no
  domínio reservado `colete.test` que começa pelo prefixo do próprio harness:
  `group-foundation-`, `export-harness-` (também os criados por SQL, antes
  `export-lock-`), `idempotency-harness-` (antes `profile-lock@`),
  `account-deletion-` e `gateway-`. Os cinco harnesses que criam usuários
  varrem no início e no fim somente os usuários com a própria marca; nos três
  guardados, a varredura final roda depois de o trabalho em voo assentar (ver
  a seção seguinte). A
  criação em lotes do harness de grupos passou a esperar o lote inteiro antes
  de propagar uma falha. Contraprovas: interrompido por `SIGINT` com 8 usuários
  criados, `ab624fc` deixou 12 usuários, e a execução seguinte, verde, os
  manteve; com a correção, a execução seguinte varreu 12 e depois 8 usuários e
  terminou com 0. Uma falha de prova com exclusão em voo (a trava de grupos de
  `delete_account` retirada, prova `guard-lock`) deixou 74 usuários e 74
  perfis em `ab624fc`, com `cleanup failed … revoked_auth_sessions_profile_id_fkey`
  impresso antes da causa; com a correção, a mesma falha terminou com 0, e a
  mensagem é só a causa. Dois usuários sem a marca, um no domínio `colete.test`
  sem prefixo e outro com o prefixo em outro domínio, sobreviveram às
  varreduras dos cinco harnesses. O `db:test:deletion` reprovou nessa rodada
  pelo próprio censo global, que exige `auth.users` vazio, e não removeu os
  dois.
- **Mesmo titular em duas abas em `delete_account` (P3).** `13` §5.3 põe
  `DELETION_ALREADY_PENDING` entre os erros de `delete_account`, e a função o
  levanta sob o lock do perfil quando já existe saga: uma chamada cria a saga e
  a outra recebe `DELETION_ALREADY_PENDING`. A prova `same-titular` do harness
  de grupos roda o par pela barreira nas duas ordens e 20 pares sem barreira.
  Com a trava dos perfis de `delete_account` de volta a `FOR UPDATE`, a ordem 1
  reprova com `the barrier observed a deadlock (SQLSTATE 40P01)` em 3 de 3
  execuções, a ordem 2, isolada, também em 3 de 3, e os 20 pares sem barreira
  têm 20, 19 e 17 pares em `40P01`. Com a correção, em três execuções, as duas
  ordens passam e os 20 pares imprimem `pairs with 40P01=0,
  DELETION_ALREADY_PENDING=20`.
- **`throws_ok` do guard (P3).** A negação de `service_role` sobre o guard
  (`0015` teste 82) exigia só o `SQLSTATE 42501` e passava por três causas.
  Agora exige também a mensagem `permission denied for schema private`. Com
  `USAGE` em `private` e `EXECUTE` do guard concedidos a `service_role`, o texto
  de `ab624fc` deixava o teste 82 verde; o novo reprova com `caught: 42501:
  permission denied for table profiles`. Só com `USAGE`, reprova com
  `permission denied for function require_financial_deletion_substitute`.
- **`docs/25` §3.3 (P3).** O parágrafo sobre a aquisição do guard foi
  substituído, pela oitava emenda, pelo texto proposto na revisão: as duas
  provas, cada uma com a contraprova que a reprova.
- **Documentação (P3).** A tabela de contraprovas deste documento voltou a
  renderizar, com o parágrafo do §3.3 fora dela, e a numeração dos testes de
  ACL foi remedida.
- **Travas do M1-B (para o planejador).** A decisão humana M2-D15 manteve as
  nove travas `FOR UPDATE` do M1-B fora desta fatia e as registrou no `25`
  §8.2, com prazo: uma migration própria as alinha à M2-D13 antes de o M2
  fechar.

### Correção da conferência da segunda revisão

A conferência da segunda revisão (sobre `9e9def7`) deu “não”, com um P2: com o
guard, uma rejeição sem tratador em `db:test:export` e em
`db:test:idempotency` disparava a limpeza enquanto `main` continuava gravando.
A limpeza falhou em 3 de 3 e em 2 de 2 execuções, ficou resíduo, e a execução
seguinte do export reprovou pelo censo, não pela causa. A migration não mudou
nesta rodada. Os números abaixo foram medidos em 2026-09-27, na pilha local,
sobre `origin/main` com o #38.

**Diagnóstico.** Reproduzi os dois pontos da conferência com o guard de
`9e9def7` e um rastreio de toda query e requisição do harness, feito por um
preload fora do repositório. A saída e o resíduo foram os da conferência:

- **Export: `profiles_lifecycle_check`.** O tratador chamava a limpeza na
  hora, e `main` seguia. Os dois usavam o mesmo cliente `pg`, e as queries se
  intercalavam na mesma conexão, inclusive dentro da mesma transação: o `begin`
  da limpeza caía dentro do grafo que `main` gravava. A escrita concorrente era
  a fixture de `proveGroupsThroughEdge`. Primeiro vinham os perfis
  `13a00000-…-1` a `-3`, em `active` e ligados a usuários com a marca, os dois
  grupos, as memberships e o convite. Depois vinham o pedido de export pelo
  gateway Edge, com a idempotência do titular, a linha de `data_exports` e o
  efeito de build; o worker Edge, com a linha de `job_runs`; e o download, com
  o efeito de purge. A limpeza falhou primeiro em `groups`
  (`group_members_group_id_fkey`) e em `profiles` (`groups_owner_id_fkey`), com
  os dois erros engolidos por `.catch`. A exclusão dos três usuários pela API
  admin devolveu 500, e a varredura pela marca apagou `auth.users`. Isso
  dispara `ON DELETE SET NULL` em `profiles.auth_user_id`. Um perfil em
  `active`, sem `auth_user_id` e com `deidentified_at` nulo não satisfaz nenhum
  ramo de `profiles_lifecycle_check`, que só aceita `auth_user_id` nulo em
  `deletion_pending` ou `deleted`.
- **Idempotência: `idempotency_records_actor_id_fkey`.** A limpeza, em conexão
  própria, apagou a idempotência do ator, que ainda não tinha linhas, e pediu o
  `DELETE` do perfil `13e00000-…-1`. O `DELETE` esperou o `FOR NO KEY UPDATE`
  do detentor da barreira. Enquanto isso, `main` seguiu na ordem 1 do par do
  mesmo ator: A e B chamaram `update_profile` e inseriram, cada uma, uma linha
  de idempotência com o `actor_id` do perfil, o que o detentor não bloqueia.
  Quando o detentor commitou, A e B commitaram, e o `DELETE` do perfil acordou
  vendo as duas linhas. A exceção saiu antes da varredura, e o usuário ficou.
- **Execução seguinte do export: `job_runs delta -1`.** A linha de
  `private.job_runs` da execução interrompida entrava na linha de base: a
  varredura inicial não a remove, e `jobBaseline` é o maior `id`. Quando a
  execução seguinte caía no mesmo minuto, o `delete` do slot do minuto em
  `proveGroupsThroughEdge` apagava essa linha, e o censo acusava `-1` no lugar
  da causa.

**Correção, no guard.** `scripts/harness-guard.mjs` passou a tratar toda
falha, seja erro de `main`, seja rejeição sem tratador, pelo mesmo caminho:

1. relata a causa na hora, antes de qualquer outra linha de falha; as falhas
   seguintes saem como comentário, depois dela;
2. aciona um sinal de abort. O guard instrumenta `pg.Client` e `fetch`, e toda
   query, conexão ou requisição do harness consulta o sinal antes de sair.
   Depois do abort, trabalho novo é recusado, `commit` vira `rollback`, e uma
   linha `ok` impressa por `main` sai marcada como ignorada. O mesmo sinal está
   em `guard.signal` e `guard.throwIfAborted()`;
3. espera o trabalho em voo terminar, com prazo de 20 s. Contam como trabalho
   em voo `main`, as promessas da barreira, as queries e as requisições já
   enviadas. Estourado o prazo, o guard encerra por `pg_terminate_backend` as
   conexões com o `application_name` do harness e corta as requisições. Para
   isso, toda conexão dos três harnesses leva um prefixo próprio
   (`colete_groups_`, `colete_export_` ou `colete_idempotency_`), e o guard
   recusa conexão sem ele;
4. limpa numa conexão própria: primeiro a limpeza do harness, em ordem de FK,
   depois a varredura de Auth pela marca. A varredura nunca apaga usuário que
   ainda tem perfil. Ela apaga os demais e reprova com a contagem, em vez de
   disparar o `SET NULL` que viola `profiles_lifecycle_check`;
5. roda o censo depois da limpeza e o relata à parte;
6. sai com código 1.

A limpeza e o censo dos três harnesses saíram de `main` e dos `finally` e
passaram a ser registrados no guard, por `onCleanup` e `onCensus`.

**Contraprova.** Uma rejeição sem tratador foi injetada em três pontos de cada
harness: no início; no meio de uma prova concorrente, a tempestade sem
barreira; e durante uma exclusão ou um export em voo. O harness de idempotência
não tem exclusão nem export, e o terceiro ponto dele é `update_profile` em voo
sob a barreira. Os dois pontos da conferência entraram também. “Antes” é o
guard de `9e9def7`, no mesmo ponto, sobre scripts idênticos aos de `9e9def7`.
O resíduo foi contado em `auth.users`, `public.profiles`,
`private.idempotency_records`, `private.job_runs` e `private.external_effects`,
nessa ordem. “Seguinte” é a execução sem injeção logo depois, no mesmo lado.
Todas as execuções com injeção, dos dois lados, saíram com código 1 e com a
causa injetada na primeira linha `not ok`.

| Harness | Ponto | Antes: limpeza | Antes: resíduo | Antes: depois da causa | Antes: seguinte | Depois: resíduo | Depois: seguinte |
| --- | --- | --- | --- | --- | --- | --- | --- |
| export | conferência: antes do export pela Edge | falhou, `profiles_lifecycle_check` | 3, 3, 1, 1, 2 | segundo `not ok` | reprovou pelo censo, `job_runs` −1 | 0 | verde, 16 `ok` |
| export | início: criação de usuários em voo | falhou, censo (`auth.users` +9) | 9, 0, 0, 0, 0 | — | verde | 0 | verde, 16 `ok` |
| export | tempestade do mesmo titular | falhou, censo (`storage.objects` +3) | 0 | 2 `ok` e segundo `not ok` | verde | 0 | verde, 16 `ok` |
| export | build real do export em voo | rodou | 0 | 2 `ok` e segundo `not ok` | verde | 0 | verde, 16 `ok` |
| idempotência | conferência: depois da fixture do mesmo ator | falhou, `idempotency_records_actor_id_fkey` | 1, 1, 2, 0, 0 | — | verde | 0 | verde, 7 `ok` |
| idempotência | início: 25 competidores em voo | rodou | 0 | segundo `not ok` | verde | 0 | verde, 7 `ok` |
| idempotência | tempestade de `update_profile` | falhou, `idempotency_records_actor_id_fkey` | 1, 1, 1, 0, 0 | — | verde | 0 | verde, 7 `ok` |
| idempotência | `update_profile` em voo sob a barreira | falhou, `idempotency_records_actor_id_fkey` | 1, 1, 2, 0, 0 | 1 `ok` | verde | 0 | verde, 7 `ok` |
| grupos | início: criação de usuários em voo | rodou | 0 | — | verde | 0 | verde, 29 `ok` |
| grupos | tempestade de candidatura mútua | falhou, `profiles_lifecycle_check` | 94, 96, 38, 0, 42 | segundo `not ok` | verde | 0 | verde, 29 `ok` |
| grupos | `delete_account` em voo sob a barreira | falhou, `profiles_lifecycle_check` | 94, 96, 9, 0, 13 | 3 `ok` e segundo `not ok` | verde | 0 | verde, 29 `ok` |

Com o guard novo, nas onze execuções, a limpeza e o censo passaram, nenhuma
linha `ok` de `main` saiu depois da causa, e o trabalho em voo assentou entre
62 ms e 146 ms depois do abort. O caminho do prazo foi exercitado à parte, no
harness de grupos, com uma query `pg_sleep(120)` em voo junto com a rejeição. O
trabalho não assentou em 20 s, o guard encerrou as cinco conexões
`colete_groups_*`, a limpeza e o censo passaram, o resíduo terminou em 0 e a
execução seguinte ficou verde. A primeira tentativa desse caminho achou um
defeito do próprio guard: o encerramento emitia `error` em clientes `pg` sem
listener, e o Node caía antes da limpeza, com 96 usuários residuais. O guard
passou a registrar, no `connect`, um listener que encaminha o erro ao caminho
de falha e o ignora durante o encerramento.

### O que continua fora

- `create_group`, RPCs de membership e titularidade (`0016`), convites ativos,
  HMAC e `code_digest` (`0017`);
- upload, rota de leitura e limites do bucket `group-photos`;
- N28 e trilha na transferência por exclusão (M2-D7);
- a prova de capacidade sob 25 conexões, que pertence à `0017` (`25` §5.4);
- qualquer UI.

## Fatia 2 — `0016_group_membership_rpcs.sql`

### O que foi entregue

| Objeto | Contrato provado |
| --- | --- |
| `public.approve_member`, `remove_member`, `set_role`, `set_monthly`, `set_ratings_visibility`, `transfer_ownership` e `leave_group` | as sete RPCs de `13` §5 (sem `create_group`, que é da `0017`), `security definer`, `volatile`, `search_path` vazio, `EXECUTE` somente para `service_role`; ordem de locks de `25` §4.1, todas as travas em `FOR NO KEY UPDATE` (M2-D13) |
| envelope idempotente | allowlists de operação, outcome e resource ampliadas de forma append-only; `private.acquire_group_idempotency` e `private.complete_group_idempotency` no padrão da `0012`; o validador vivo passou a `private.validate_through_data_export_outcome` e o nome público ganhou as sete formas; `private.enforce_idempotency_conclusion` exige resource `group` igual ao `group_id` do outcome |
| helpers de revalidação | `private.require_group_actor_after_locks` (conta, sessão revogada e aceite, depois dos locks), `private.group_actor_authority` (`NOT_FOUND`, `GROUP_ARCHIVED`, `NOT_MEMBER`, dono derivado de `owner_id`) e `private.require_group_not_suspended` |
| M2-D16 | recusa em `approve_member`: `pending → removed`, `removed_at = now()`, `removal_count` inalterado, sem linha nova |
| M2-D17 | `set_role` e `set_monthly` sobre alvo sem membership `active`: `NOT_ACTIVE_MEMBER` |
| M2-D18 | `reason` de `remove_member`: obrigatório, não vazio depois de trim, até 500 caracteres, senão `VALIDATION`, na Edge e na RPC; não é persistido nem ecoado |
| `private.purge_removed_memberships` | retenção de 12 meses de `17` §2: apaga membership `removed` com `removed_at <= now() - 12 meses`, grava `retention_runs`; job diário `purge_removed_memberships` às 03:53 UTC em `worker_job_slot`, `worker_execute_database_job`, `cron.job` e `WORKER_JOBS` |
| Edge `groups` | `supabase/functions/groups/index.ts` serve somente as sete operações; o gateway saiu de `identity/index.ts` para `_shared/edge-gateway.ts`, e `identity` serve somente as suas seis; normalizadores, parâmetros da RPC e os códigos novos do catálogo em `_shared/operations.ts`, `gateway.ts` e `errors.ts` |
| `scripts/test-group-membership.mjs` (`db:test:membership`) | harness de commit real, barreira, 25 conexões, HTTP real e censo do motivo, sobre `harness-guard.mjs` e `lock-barrier.mjs`; também no job `database-security` |
| `scripts/harness-guard.mjs` | endurecido antes da fatia (ver “Guarda dos harnesses”) |

### Decisões de implementação

- **Autoridade.** Os códigos vêm dos erros comuns de `13` §0.1: sem membership
  `active` no grupo, `NOT_MEMBER`; aprovar, remover e mensalista exigem dono ou
  organizador (`01` §4 e §5, tela 17), senão `NOT_ORGANIZER`; papel,
  visibilidade e transferência exigem o dono, senão `OWNER_ONLY`. A ordem das
  verificações é: grupo inexistente (`NOT_FOUND`), arquivado (`GROUP_ARCHIVED`),
  membership do ator, papel, suspensão (`GROUP_SUSPENDED`) e só então o alvo.
  Assim um estranho não descobre a suspensão, e o arquivamento continua
  alcançável, porque ele passa todas as memberships a `removed`.
- **M2-D19.** As quatro escolhas foram aceitas por decisão humana em
  2026-09-28 e registradas em `25` §8.1 e `13` §5: `approve_member` sem pedido
  devolve `NOT_FOUND`; `remove_member` sobre alvo não ativo devolve
  `NOT_ACTIVE_MEMBER`; `transfer_ownership` exige membership e conta `active`
  do novo dono; transferir para si mesmo conclui sem `UPDATE` em `groups`.
  Os dois demais comportamentos da primeira entrega continuam: `leave_group`
  de quem não é membro ativo devolve `NOT_MEMBER`, e `set_role` aceita o dono
  como alvo sem alterar a titularidade, derivada de `owner_id`.
- **Revalidação depois dos locks.** As mutações de domínio em `groups` e em
  `group_members`, desta fatia e da `0015`, travam antes o grupo. O expurgo
  `purge_removed_memberships` é exceção: trava somente as memberships `removed`
  com retenção vencida, por `FOR UPDATE SKIP LOCKED`, e as apaga. Não trava o
  grupo e nunca espera por linha já travada. Como não toca membership ativa,
  não altera a autoridade que as RPCs leem com o grupo travado.
- **Replay (M2-D20).** Nas sete RPCs, o replay passa pelos mesmos locks e pela
  mesma revalidação de autoridade atual da chamada nova, antes da resposta.
  Pela emenda de 2026-09-28, negação devolve HTTP 200 com somente o outcome,
  sem `current`; a chamada nova conserva o erro. Autorização devolve o outcome
  gravado mais a projeção fresca; não repete o efeito nem a decisão do alvo.
- **Modo das travas (M2-D13).** Vinte e duas cláusulas, lidas do banco vivo pela
  prova `lock-modes`: todas `FOR NO KEY UPDATE`, exceto uma, a do expurgo, em
  `FOR UPDATE SKIP LOCKED`, porque a transação apaga a linha; `SKIP LOCKED` faz
  o expurgo nunca esperar. `worker_execute_database_job`, reescrita para o
  despacho do job, teve a trava de `job_runs` alinhada a `FOR NO KEY UPDATE`,
  como `25` §2 manda para trava do M1-B reescrita; das nove da M2-D15 restam
  oito.
- **Auditoria da regra do P1 do #36, pelo banco vivo.** Sequência de escritas e
  travas de cada função nova, lida de `pg_get_functiondef` depois do
  `db:reset`. A única escrita com FK seguida de trava da tabela referenciada é o
  `INSERT` da idempotência (FK `actor_id → profiles`), antes da trava de
  `profiles`, nas sete RPCs; é o padrão da M2-D13, seguro somente porque a
  trava é `FOR NO KEY UPDATE`, e os pares abaixo o provam. `update groups set
  owner_id` em `transfer_ownership` executa a FK para o novo dono depois das
  travas de perfil, sem trava posterior de perfil. As demais escritas não tocam
  coluna de FK (`group_members` só muda `status`, `role`, `is_monthly` e
  `removed_at`; `complete_group_idempotency` não muda `actor_id`), e nenhuma FK
  aponta para `group_members` ou para `retention_runs`.
- **Testes antigos ajustados.** `0004_idempotency_foundation.test.sql` passa a
  listar 25 rotinas no grant nominal de `service_role`, e
  `0011_worker_foundation.test.sql`, sete agendas. `src/lib/database.types.ts`
  foi regenerado pelo `generate:db-types` com a CLI fixada em 2.118.0; parte da
  diferença é só a forma que essa versão emite (`Args: Record<PropertyKey,
  never>` e quebras de linha).

### Provas e números medidos

Medidos na rodada autora de correção da primeira revisão, em 2026-09-28,
com banco recriado somente pelas dezesseis migrations. Estes números substituem
os totais da primeira entrega (`424bc91`, 1.094 asserções e 43 linhas `ok`).

- `npm run db:test`: 15 arquivos, **1.096** asserções, todas verdes;
  `0016_group_membership_rpcs.test.sql` tem **128** asserções.
- `npm run db:test:membership`: **57** linhas `ok` por execução, em **3**
  execuções completas seguidas: **6,362 s**, **7,275 s** e **10,814 s** de parede.
  Em todas, as catorze tempestades imprimiram zero `40P01`; a prova de 25
  conexões observou as 25 esperando lock, com 1 `ok`, 24 `GROUP_LIMIT` e cinco
  memberships ativas. As duas topologias da exclusão × transferência passaram
  nas duas ordens. Censo: 73 tabelas, quatro corpos, cinco logs de serviços e
  nove tabelas do analytics, sem motivo; sentinela presente 1/1 nos dois canais.
  Resíduo aceito do GoTrue: **+30** entradas de auditoria em cada execução.
- `auth.users`, perfis, grupos e idempotência tinham zero linhas antes e depois
  das três execuções, também depois de cada uma. Tabelas e gatilhos de sonda:
  zero objetos depois das provas.
- Demais harnesses: `db:test:idempotency` 7 `ok`, `db:test:gateway` 9,
  `db:test:worker` 8, `db:test:deletion` 10, `db:test:export` 16,
  `db:test:groups` 29; todos com saída 0 nesta rodada.
- Browser: `test:auth:web` 8 passados e 2 pulados (11,1 s),
  `test:privacy:web` 4 e 4 (13,9 s), `test:smoke:web` 6 (1,9 s).
  `verify:app`: 175 testes em 20 arquivos, com lint, formato, tipos, build e
  verificações PWA/contratos/segredos verdes. `scan:docs`, `scan:secrets`,
  `audit:high` e `git diff --check`: saída 0. Auditoria: 13 moderadas,
  nenhuma alta ou crítica. Nenhum `prettier` foi aplicado a `docs/`.

Ocorrências antes da série verde: a substituição inicial para a topologia
inversa atingiu também `crossFixture` e causou `ReferenceError: inverse is not
defined`; foi corrigida no harness. Depois, uma execução passou as provas de
domínio e falhou em 95,315 s no censo, porque o analytics não ingeriu a sentinela
em 90 s. O Vector local registrava `401 Unauthorized` na ingestão. A pilha foi
parada e recriada, e a série de três passou com a sentinela presente. A causa
interna do 401 não foi isolada; a comparação inicial com o `api_key` de
`_analytics.users` não a provava. Nenhum prazo, asserção ou código de ingestão
foi alterado; nenhuma nova tentativa automática foi introduzida. As duas falhas
terminaram com limpeza e censo residual verdes, sem usuário Auth residual.

Pares da barreira de `25` §2: medição da primeira entrega, confirmada pela
série desta rodada nas duas ordens. A topologia inversa acrescentada está
registrada na primeira revisão abaixo:

| Par | Ordem 1 | Ordem 2 | 20 pares sem barreira |
| --- | --- | --- | --- |
| `approve_member` cruzado | A espera o detentor; B conclui sem esperar | idem | 0 `40P01`; 40 `ok` |
| `remove_member` cruzado | idem | idem | 0; 40 `ok` |
| `set_role` cruzado | idem | idem | 0; 40 `ok` |
| `set_monthly` cruzado | idem | idem | 0; 40 `ok` |
| `transfer_ownership` cruzado | A espera o detentor; B espera A | idem | 0; 40 `ok` |
| exclusão × transferência cruzada | exclusão conclui; transferência `NOT_ACTIVE_MEMBER` | transferência conclui; exclusão `CONCURRENT_CHANGE`, retry conclui | 0; 20 `ok`, 20 `CONCURRENT_CHANGE`, todos convergidos |
| `approve_member`, mesmo ator | as duas esperam; uma `ok`, outra `MEMBERSHIP_ALREADY_DECIDED` | idem | 0 |
| `remove_member`, mesmo ator | uma `ok`, outra `NOT_ACTIVE_MEMBER` | idem | 0 |
| `set_role`, mesmo ator | as duas `ok`, serializadas | idem | 0 |
| `set_monthly`, mesmo ator (alvo é o ator) | as duas `ok` | idem | 0 |
| `set_ratings_visibility`, mesmo ator | as duas `ok` | idem | 0 |
| `transfer_ownership`, mesmo ator | uma `ok`, outra `OWNER_ONLY` | idem | 0 |
| `leave_group`, mesmo ator | uma `ok`, outra `NOT_MEMBER` | idem | 0 |

Provas ordenadas, em que A roda até o fim, fica aberta e B precisa ser
observada esperando por A: quinta × sexta membership (a segunda recebe
`GROUP_LIMIT`, cinco ativas, nas duas ordens); transferência × saída (ordem 1:
saída recebe `OWNER_MUST_TRANSFER`; ordem 2: transferência recebe
`NOT_ACTIVE_MEMBER`); exclusão × transferência e exclusão do dono × exclusão do
organizador escolhido, nas duas ordens, com `CONCURRENT_CHANGE` e retry que
converge onde a revalidação de `25` §3.3 manda.

HTTP real, pela Edge `groups`, com JWT do GoTrue: as sete rotas; replay e
`IDEMPOTENCY_CONFLICT`; `GROUP_SUSPENDED` com `suspended_at` de fixture;
`OWNER_ONLY`, `NOT_ACTIVE_MEMBER` (M2-D17), `VISIBILITY_CONFIRMATION_REQUIRED`,
`IS_OWNER` e `OWNER_MUST_TRANSFER`; o removido deixa de ler o grupo pelo
PostgREST e recebe `NOT_MEMBER` na chamada seguinte; saída de não-owner de
grupo suspenso; `identity/approve_member` e `groups/update_profile` respondem
`NOT_FOUND`. O job de retenção roda pelo worker Edge real.

Censo da M2-D18, com marcador único por execução: 73 tabelas do banco
`postgres`, `pg_stat_statements`, as quatro respostas e erros (sucesso, `IS_OWNER`
no banco, `VALIDATION` na Edge, `VALIDATION` na RPC), os logs de
`supabase_db`, `rest`, `edge_runtime`, `kong` e `auth` e as nove tabelas de log
do analytics local. Uma sentinela emitida no log do Postgres depois de tudo
precisa aparecer no `docker logs` do banco e no analytics antes de a ausência
do motivo valer. Resultado: zero ocorrências em todas as fontes.

### Contraprovas executadas

Cada mutação foi aplicada por `create or replace` a partir do
`pg_get_functiondef` vivo, a prova rodou isolada (`COLETE_MEMBERSHIP_PROOF` e
`COLETE_MEMBERSHIP_PART`) e o texto original foi restaurado; no fim, `db:reset`.
Nenhuma execução deixou resíduo.

| Mutação | Prova | Ordem 1 | Ordem 2 | 20 pares sem barreira |
| --- | --- | --- | --- | --- |
| trava do perfil alvo de `approve_member` em `FOR UPDATE` | `cross-approve` | `40P01` | `40P01` | **5** de 20 |
| idem, `remove_member` | `cross-remove` | `40P01` | `40P01` | **4** |
| idem, `set_role` | `cross-role` | `40P01` | `40P01` | **5** |
| idem, `set_monthly` | `cross-monthly` | `40P01` | `40P01` | **12** |
| travas de perfis de `transfer_ownership` em `FOR UPDATE` | `cross-transfer` | `40P01` | `40P01` | **15** |
| idem, só a transferência | `cross-deletion-transfer` | passa | reprova por resultado (`NOT_ACTIVE_MEMBER`), sem `40P01` | 0 |
| transferência e perfis de `delete_account` em `FOR UPDATE` | `cross-deletion-transfer` | `40P01` | `40P01` | **18** |
| trava do perfil do ator (alvo) de `set_monthly` em `FOR UPDATE` | `same-monthly` | `40P01` | `40P01` | **7** |
| trava do perfil do ator de `set_ratings_visibility` | `same-visibility` | `40P01` | `40P01` | **15** |
| travas de perfis de `transfer_ownership` | `same-transfer` | `40P01` | `40P01` | **9** |
| trava do perfil do ator de `leave_group` | `same-leave` | `40P01` | `40P01` | **15** |
| trava do perfil alvo em `FOR UPDATE`, `approve_member`, `remove_member`, `set_role` | `same-*` | passa | passa | 0 |
| sem a trava do perfil alvo, `approve_member`, `remove_member`, `set_role` | `same-*`, ordem 1 | `the competitor finished before its lock wait was observed` | — | — |
| sem a trava do perfil alvo de `approve_member` (lock-pai da cota) | `quota-pair` | reprova: **6** memberships ativas | — | — |
| idem | `quota-racers` | reprova: **6** memberships ativas | — | — |
| sem as três travas de `leave_group` | `owner-race` | `23514 GROUP_OWNER_MEMBERSHIP_REQUIRED` no commit | — | — |
| sem as travas e sem o trigger de `group_members` | `owner-race` | `invalid owner state` | — | — |
| sem o trigger, com as travas | `owner-race` | passa | passa | — |
| `remove_member` gravando o motivo numa coluna temporária | `reason-census` | `the reason was persisted: [["public.group_members",1]]` | — | — |

Duas leituras dessas linhas. Os números originais da exclusão × transferência
cruzada acima foram medidos somente com quem exclui no UUID menor. Nessa
topologia, a transferência sozinha em `FOR UPDATE` não fechou ciclo; com as duas
em `FOR UPDATE`, o ciclo voltou. Isso não se generaliza: com quem exclui no UUID
maior, só a transferência em `FOR UPDATE` já reproduz `40P01` na ordem 2.
A correção da primeira revisão abaixo registra as duas topologias. Nos pares do mesmo ator de `approve_member`, `remove_member` e
`set_role`, `FOR UPDATE` também não fecha ciclo: a linha disputada é o perfil
alvo, e nenhuma das duas transações segura `FOR KEY SHARE` nele, porque a
idempotência trava o perfil do ator, que essas funções não travam. A
contraprova que reprova esses três pares é a retirada da trava do alvo: A
termina sem esperar, e a barreira acusa.

### Correções da primeira revisão do PR #40

Rodada autora de 2026-09-28, sobre o head conferido `424bc91`, commit único sobre
`origin/main` (`6f18b1f`). A revisão lida literalmente foi o comentário
`5871804342`. Nenhum merge. M2-D19 e M2-D20 foram decisões fornecidas pelo
planejador nesta rodada, não escolhas da implementação. O comportamento de
replay negado e a leitura normativa da auditoria abaixo são históricos desta
primeira revisão, substituídos pela M2-D20 emendada e pela M2-D21 na seção
“Correções da conferência do PR #40”.

| Achado | Correção e prova que acusa o defeito |
| --- | --- |
| P2-1 — replay sem autoridade atual | As sete RPCs (`approve_member`, `remove_member`, `set_role`, `set_monthly`, `set_ratings_visibility`, `transfer_ownership`, `leave_group`) passam pelos mesmos locks e verificações de autoridade da chamada nova antes de retornar. `replay-authority` recusa conta suspensa, sessão revogada, perda de papel quando aplicável e membership removida, com o mesmo erro nas duas chamadas; preserva o registro `completed`. `replay-http`, uma execução de cada lado: antes o organizador removido recebe 200 com `current.enabled=false` do outro membro, enquanto a chamada nova recebe 403 `NOT_MEMBER`; depois ambas recebem 403 `NOT_MEMBER`, sem `data` nem `current`. O dono autorizado recebe o outcome gravado e `enabled=false` fresco. |
| P2-2 — transferência a si mesmo | Curto-circuito antes do `UPDATE`, com conclusão idempotente. `self-transfer`, commit real sob `service_role`, uma execução de cada lado: antes muda `xmin`, muda o timestamp da sonda e aparecem duas entradas dos gatilhos de linha e statement; depois `xmin`, timestamp, dono e membership ficam intactos, com zero entradas e registro `completed`. A prova positiva de replay autorizado também passa. |
| P3-1 — topologia inversa | `cross-deletion-transfer-inverse` acrescenta quem exclui no UUID maior, nas duas ordens e em 20 pares simultâneos. A ordem 1 segura o segundo perfil por bytes, conforme `25` §2, para A esperar depois de adquirir o primeiro; a ordem 2 segura o perfil do candidato. A implementação correta passa nas duas ordens, sem `40P01`. Contraprova, somente os locks de perfil da transferência em `FOR UPDATE`, uma execução da ordem 2: `40P01`. As frases que generalizavam a topologia original foram corrigidas aqui e no corpo do PR. |
| P3-2 — suspensão sem prova em duas RPCs | Duas asserções pgTAP e `suspended-role-remove`, pelo HTTP real. Uma contraprova por RPC, retirando somente sua checagem: `set_role` aceita 200 e promove; `remove_member` aceita 200 e remove. Depois ambas recebem 403 `GROUP_SUSPENDED`, com membership intacta. |
| P3-3 — expurgo sem lock de grupo | Corrigida a exceção em “Revalidação depois dos locks”: o expurgo trava somente memberships `removed` elegíveis por `FOR UPDATE SKIP LOCKED`, sem travar grupo e sem esperar. Conferência do corpo em `0016` e da prova `lock-modes`; não houve alteração no expurgo. |

**Limite da prova de timestamp.** `public.groups` não tem coluna `updated_at`
no schema da `0015`. `self-transfer` acrescenta somente no banco local uma coluna
homônima e um gatilho `BEFORE UPDATE` que a muda em qualquer atualização. Essa
sonda, os gatilhos de linha e statement, sua função e tabela de contagem são
removidos no `finally`. Não se afirma ter medido um `updated_at` produtivo e
nenhuma coluna nova entrou em migration. `xmin` é o da linha real, medido antes
e depois do commit da RPC.

**Auditoria de replay fora da `0016`.** “Sim” abaixo significa que o ramo de
replay chega à projeção antes de uma checagem de autoridade que a chamada nova
executa. As reproduções foram transações sob `service_role`, revertidas no fim;
nenhuma rotina anterior foi corrigida. Os arquivos e linhas são as definições
vigentes ou, quando indicado, sua origem no M1-B.

| RPC | Mesmo defeito? | Arquivo:linha e evidência |
| --- | --- | --- |
| `request_data_export` | **sim** | `0015_group_foundation.sql:831` (origem `0013_data_export_delivery.sql:818`), antes da denylist em `0015:843`. Reproduzido: pedir export, revogar a sessão, repetir o request; replay devolve sucesso com a projeção do export, chamada nova dá `28000 UNAUTHENTICATED`. |
| `delete_account` | **sim** | `0015_group_foundation.sql:527` (origem `0012_account_deletion.sql:528`), antes da denylist em `0015:564`. Reproduzido: excluir a conta, que revoga a sessão no mesmo commit lógico, e repetir o request; replay devolve sucesso com cinco campos da saga; chamada nova dá `P0001 DELETION_ALREADY_PENDING`, verificação que antecede a denylist. A projeção própria do shell de exclusão tem uma exceção normativa para sessão revogada (`22` §4); isso não significa que a RPC mutável tenha feito sua checagem. |
| `update_profile` | não | `0015_group_foundation.sql:742`, `require_actor_context` antes do replay em `:753`. Controle executado com sessão revogada: replay e chamada nova dão `28000 UNAUTHENTICATED`. O gate de políticas posterior ao replay é uma exceção própria do M1-A, não uma checagem de membership/papel; não foi alterado. |
| `worker_get_deletion_effect_target` | não | `0015_group_foundation.sql:1036`; sem replay por `request_id`, autoridade do lease. |
| `worker_confirm_deletion_effect` | não | `0015_group_foundation.sql:1118`; sem replay por `request_id`, autoridade do lease. |
| `worker_get_data_export_build_target` | não | `0015_group_foundation.sql:1181`; sem replay por `request_id`, autoridade do lease. |
| `worker_acquire_external_effect` | não | `0013_data_export_delivery.sql:267`, com extensão em `0014_worker_slot_and_gate.sql`; aquisição de lease, sem esse caminho de replay. |
| `worker_complete_external_effect` | não | `0011_worker_foundation.sql:266`; conclusão fenced, sem esse caminho de replay. |
| `worker_begin_job` | não | `0014_worker_slot_and_gate.sql:51`; deduplicação por slot, sem contexto de usuário ou projeção privada de membro. |
| `worker_execute_database_job` | não | origem `0013_data_export_delivery.sql:922`, redefinida pela própria `0016` para o expurgo; sem replay por `request_id` de usuário. |
| `worker_finish_job` | não | `0011_worker_foundation.sql:584`; sem esse caminho de replay. |
| `worker_publish_data_export` | não | `0013_data_export_delivery.sql:1037`; publicação fenced, sem esse caminho de replay. |
| `enqueue_data_export_purge` | não | `0013_data_export_delivery.sql:1061`; enqueue governado, sem esse caminho de replay. |
| `consume_data_export` | não | `0013_data_export_delivery.sql:1082`; denylist e CAS one-shot, sem esse caminho de replay. |
| `finalize_deletion` | não | `0013_data_export_delivery.sql:1115`; finalização do worker, sem esse caminho de replay. |
| `get_own_deletion_request` | não | `0013_data_export_delivery.sql:113`; projeção própria, sem replay mutável. |
| `get_own_data_exports` | não | `0013_data_export_delivery.sql:554`; projeção própria, sem replay mutável. |

Todas as mutações de contraprova foram restauradas antes do reset final.
A validação completa do AGENTS §5 passou, com membership três vezes, como
registrado em “Provas e números medidos”. A medição de resíduo após as provas
isoladas encontrou `auth.users`, perfis,
grupos, idempotência, tabelas e gatilhos de sonda com zero linhas/objetos.

### Guarda dos harnesses

A terceira conferência do #36 (comentário 5862758465) registrou dois P3 no
`scripts/harness-guard.mjs`, corrigidos aqui antes de o harness desta fatia
depender dele:

- `counted()` anexava o tratador de rejeição à própria promessa que devolvia ao
  harness. Uma query ou um `fetch` sem `await` que falhasse deixava de ser
  rejeição sem tratador e terminava com saída 0. Agora o guard devolve a
  promessa derivada. Contraprova, um `fetch` sem `await` para
  `127.0.0.1:9` injetado uma vez no harness de grupos: antes, `exit=0` e
  `Group foundation harness passed.`; depois, `exit=1`, com a primeira linha
  `not ok - db:test:groups: unhandled promise rejection: [TypeError: fetch failed]`.
- O guard descartava falhas da própria limpeza (`cleanupError ??= error` na
  varredura e `client.end().catch(() => {})`), e o harness de grupos trocava o
  erro da limpeza do banco pelo da varredura num `finally`. Agora toda falha da
  limpeza, da varredura e do encerramento das conexões do guard é guardada com
  o passo e relatada, depois da causa, com saída 1; `AggregateError` é relatado
  erro a erro; e a limpeza do harness de grupos sobe as duas falhas juntas.
  Contraprova, uma falha em `main` e outra na segunda chamada de
  `cleanupDatabase`: antes, a causa e depois só `96 marked Auth users … still
  own a profile`, sem o erro injetado da limpeza; depois, a causa, em seguida
  `the harness cleanup: Error: INJECTED (b): cleanupDatabase failure in the
  final cleanup` e as duas falhas de varredura.

Depois da mudança, uma execução de cada: `db:test:groups` 29 `ok` em 2,07 s,
`db:test:export` 16 em 1,84 s e `db:test:idempotency` 7 em 5,12 s, sem resíduo.
Os demais P3 da conferência (os `.catch` do harness do export, o censo de
`job_runs` na execução seguinte e as frases do `docs/23`) ficam para um PR de
faxina posterior.

### O que continua fora

- `create_group`, convites, HMAC, `code_digest`, reentrada `removed → pending`
  e o incremento de `removal_count` (`0017`, `25` §5.4);
- trilha e notificações das mutações de grupo (M2-D7) e a persistência do
  motivo de remoção (M2-D18), nas fatias B2;
- remoção de rachas futuros, refunds, invalidação de publicação e
  `PROOFS_PENDING`, que dependem do M3 e do M5;
- RPC Admin de suspensão e de transferência;
- qualquer UI.

### Correções da conferência do PR #40

O comportamento de autenticação desta seção é histórico do head `1d5b1fb`.
O complemento de segurança abaixo o substitui conforme o ajuste humano de
28/09 à M2-D20; as medições desta seção continuam atribuídas àquela rodada.

Rodada autora de 2026-09-28, sobre `3b31010`, confirmado como commit único sobre
`origin/main` (`6f18b1f`). Conferência lida literalmente no comentário
`5873466485`; decisões humanas M2-D20 emendada e M2-D21 fornecidas nesta rodada.
Nenhum merge.

Nas sete RPCs da `0016`, a resolução inicial identifica o ator, sem conceder
poder de domínio. A idempotência e os locks conservam sua ordem; a checagem de
conta, sessão, membership, papel e suspensão continua depois dos locks, antes de
qualquer projeção. Somente o sub-bloco dessa checagem trata as negações conhecidas:
replay devolve `outcome` gravado; chamada nova propaga o erro. Falhas de locks,
envelope, projeção ou efeito não são convertidas em sucesso. `current` ausente
foi escolhido para distinguir projeção não autorizada de projeção com valor
`null`. O registro `completed` não muda.

`commit-real` e `replay-authority` foram atualizados para comparar a resposta
inteira sem `current`; as chamadas novas mantêm as asserções negativas. A nova
prova `replay-self-revoked-http` usa as mesmas rotas produtivas, GoTrue e
transporte de `replay-http`, sem rota ou adaptador de teste.

Cada contraprova dirigida e sua prova corrigida rodaram uma vez; a série completa
obrigatória abaixo volta a cobrir essas garantias, sem repetir a mutação antiga.

| Prova HTTP real | Antes | Depois |
| --- | --- | --- |
| Organizador removido repete `set_monthly` | Só `set_monthly` extraída de `424bc91`: 200 com `current.enabled=false` alheio; a asserção reprova por valor. | 200 com `data.outcome` idêntico ao original e `request_id`, sem `current`; nenhum valor `false` atual nem o marcador de perfil `estado-atual-alvo-40c` aparece em qualquer campo. |
| N2: replay após `leave_group` e `transfer_ownership` | Código de `3b31010`: ambos 403, respectivamente `NOT_MEMBER` e `OWNER_ONLY`; a prova mede os dois antes de reprovar. | Ambos 200, com resposta inteira igual ao desfecho original sem `current`. |
| Ator continua autorizado | Na contraprova de `424bc91`, dono recebe desfecho original e `current.enabled=false` fresco. | Mesmo resultado autorizado, com outcome gravado e valor fresco posterior à primeira chamada. |
| Chamada nova sem autoridade | Na contraprova de `424bc91`, organizador removido recebe 403 `NOT_MEMBER`; em `3b31010`, saída/transferência novas recebem 403 `NOT_MEMBER`/`OWNER_ONLY`. | As três chamadas novas conservam exatamente esses erros. |

Limpeza depois das contraprovas e das provas dirigidas: censos passaram, com
`auth.users` zero após a limpeza. GoTrue acrescentou seis entradas de auditoria
em cada prova HTTP dirigida; `replay-authority` acrescentou zero. A definição
antiga de `set_monthly` foi restaurada logo após a contraprova; o reset seguinte
recriou todas as funções somente pelas migrations.

**Alcance e pendência.** `delete_account` passa a ter a exceção normativa da
M2-D21: somente desfecho e os cinco campos da própria saga após autorrevogação.
Na entrega da `0016`, o achado de `request_data_export` ficou como divergência
temporária, com prazo antes de fechar o M2 na migration da M2-D15; a `0020`
encerrou essa pendência, conforme a seção Faxina B abaixo. Nenhuma RPC fora
das sete da `0016` foi corrigida nesta rodada. As emendas de `13` §0, §5 e §5.3,
`25` (cabeçalho, §7, §8.1 e §8.2) e o manifesto refletem as decisões humanas.

**Validação medida desta rodada.** AGENTS §5 completo, todos os comandos com
saída 0; `db:test:groups` e três séries integrais de `db:test:membership` também
passaram. Banco recriado somente pelas migrations `0001`–`0016`.

- pgTAP: 15 arquivos, **1.100** asserções, **132** na `0016`.
- Harnesses: idempotência 7 `ok`, gateway 9, worker 8, exclusão 10, export 16,
  grupos 29. Membership: **60** `ok` por série, 7,795 s / 5,876 s / 6,913 s de parede.
- Nas três séries: tempestades sem `40P01`; 25 conexões observadas esperando,
  uma aprovação e 24 `GROUP_LIMIT`, cinco memberships ativas. As tempestades
  de transferência e saída usam pedidos novos: continuam com 20 `ok` e 20
  `OWNER_ONLY`/`NOT_MEMBER`, respectivamente; isso não é replay do mesmo pedido.
- Censo por série: 73 tabelas, quatro corpos, cinco logs de serviços e nove
  tabelas do Analytics sem motivo; sentinela 1/1 em Postgres e Analytics.
  GoTrue conservou somente a auditoria aceita, **+36** entradas por série.
- `auth.users`, perfis, grupos e idempotência: **zero** antes e depois das três
  séries, e no começo e no fim da validação completa. Sondas de atualização:
  zero objetos ao fim, conferido separadamente no banco.
- Web: Auth 8 passados e 2 pulados; privacidade 4 passados e 4 pulados; smoke 6.
  `verify:app`: 175 testes em 20 arquivos, lint, formato, tipos, build e PWA verdes.
- `scan:docs`, `scan:secrets`, `audit:high` e `git diff --check`: saída 0.
  Auditoria: 13 moderadas, nenhuma alta ou crítica. Scans repetidos depois
  deste registro final; nenhum `prettier` aplicado a `docs/`.

**Falha local registrada.** Antes das três séries verdes, a primeira tentativa
integral de membership saiu 1 em **95,736 s**, com 59 `ok`: a sentinela não
chegou ao Analytics nos 90 s contratados. Vector registrou 30 ocorrências de 401
na janela de cinco minutos inspecionada. A limpeza passou, com zero em
`auth.users`, perfis, grupos e idempotência. Reiniciar somente o Analytics da
única pilha restabeleceu a ingestão; uma sentinela independente chegou uma vez
às nove tabelas de logs antes da retomada. A credencial sintética estava no
registro OAuth após o reinício; a comparação inicial com `users.api_key` não
isolava a causa, pois esse não é o registro usado pela ingestão. O mecanismo
interno da falha após o reset não foi isolado. Nenhuma asserção ou prazo foi
alterado; não foram acrescentadas novas tentativas ao produto nem ao harness.
A falha anterior permanece no progresso e no log, sem ser contada como série
verde.

Não houve acesso a projeto Supabase remoto, deploy, segredo real ou serviço de
produção. O worktree contém somente os sete arquivos desta correção sobre o
head conferido; os demais corpos da `0016` são idênticos aos de `3b31010`.


### Complemento de segurança do PR #40 — autenticação antes do replay

Rodada autora de 2026-09-28, head inicial conferido
`1d5b1fb007ff7be993ce8096acde2f4d30127364`, um commit sobre `origin/main`
(`6f18b1f`). A decisão humana ajusta a M2-D20 emendada: perda de autenticação
nega o replay com o mesmo erro da chamada nova, sem desfecho. Perda de
membership, papel ou titularidade conserva o desfecho gravado sem `current`.
A exceção de `delete_account` (M2-D21) permanece. Nenhum merge.

Nas sete RPCs, `require_group_actor_after_locks` fica depois dos mesmos locks,
antes dos ramos de replay e fora do sub-bloco que trata autoridade no grupo.
Conta não ativa, sessão revogada e aceite pendente propagam o erro normal. O
tratamento de autoridade deixou de capturar `28000`, `22023` e os erros de
conta; a checagem de autenticação não pode cair no retorno de sucesso. A mudança
funcional limita-se às sete RPCs da `0016` e aos comentários que a explicam.
`13` §0, a M2-D20 emendada e suas referências em `25` foram alinhados; os dois
checksums foram recalculados. O usuário ampliou expressamente o escopo para os
testes necessários à nova autenticação, mantendo as provas de autoridade.

**Provas dirigidas.** Uma execução medida de cada lado em (e) e (f), sem rota,
adaptador, prazo ampliado ou tentativa automática. O JWT usado em (e) foi
emitido pelo GoTrue local; a revogação passou pela Edge `identity`, e as
chamadas seguintes passaram pelas sete rotas produtivas de `groups`.

| Prova | `1d5b1fb` | Corrigida |
| --- | --- | --- |
| (e) Replay com sessão revogada, sete RPCs | Sete HTTP 200 com `data.outcome`; as sete chamadas novas dão 401 `UNAUTHENTICATED`. A asserção que exige o erro reprova. | Sete replays e sete chamadas novas dão 401 `UNAUTHENTICATED`, com erro inteiro igual salvo `request_id`, sem `data`, desfecho ou projeção. O registro `completed` original fica intacto e nenhuma chamada nova negada deixa registro. |
| (f) Outro ator reutiliza o mesmo `request_id` | Segundo ator recebe 200 com o desfecho de sua chamada em outro grupo, diferente do primeiro. Terceiro ator sem autoridade recebe 403 `NOT_ORGANIZER`, sem `data`. | Mesmos resultados; exatamente dois registros `completed`, cada um com o ator e o desfecho corretos. Nenhum desfecho do primeiro ator é entregue aos demais. |

(f) já era garantida pelo envelope do M1: a chave primária da `0004`, linha 45,
é `(actor_key, operation, request_id)`; a aquisição lê pelo mesmo trio nas
linhas 392–394. A `0016` deriva `actor_key` do perfil resolvido pelo contexto da
Edge (linha 508 em `approve_member`), sem identidade de chamador vinda do body.
Não foi necessária mutação de contraprova em (f).

**(g) Chaves medidas no livro, com commit real sob `service_role`.**
`commit-real` lê o registro concluído de cada RPC, compara exatamente o
conjunto de chaves e confere os IDs contra os alvos da chamada. O validador da
`0016`, linhas 84–89, mantém a allowlist fechada; a recusa de `approve_member`
usa as mesmas chaves da aprovação. Nenhum campo adicional foi encontrado.

| RPC | Chaves do desfecho gravado |
| --- | --- |
| `approve_member` | `group_id`, `profile_id`, `logical_result` |
| `remove_member` | `group_id`, `profile_id`, `logical_result` |
| `set_role` | `group_id`, `profile_id`, `logical_result` |
| `set_monthly` | `group_id`, `profile_id`, `logical_result` |
| `set_ratings_visibility` | `group_id`, `logical_result` |
| `transfer_ownership` | `group_id`, `new_owner_id`, `logical_result` |
| `leave_group` | `group_id`, `logical_result` |

**Repetição de (a)–(d), uma vez por prova dirigida nesta rodada.**
`replay-http` confirmou: (a) organizador removido recebe HTTP 200 com o mesmo
desfecho, sem `current`, sem o valor atual `enabled=false` nem o marcador de
perfil em qualquer campo; (c) dono autorizado recebe desfecho original com
`enabled=false` fresco; (d) chamada nova do removido conserva 403 `NOT_MEMBER`.
`replay-self-revoked-http` confirmou (b): depois de `leave_group` e
`transfer_ownership`, ambos os replays dão 200 com somente o desfecho original;
as chamadas novas conservam 403 `NOT_MEMBER` e `OWNER_ONLY`, respectivamente.
As séries integrais posteriores também cobrem essas garantias.

`replay-authority` separa agora as asserções: nas sete RPCs, replay e chamada
nova negam conta `suspended` ou `banned` com `PROFILE_SUSPENDED`, conta
`deletion_pending` com `FORBIDDEN`, sessão revogada com `UNAUTHENTICATED` e
aceite obrigatório pendente com `VALIDATION`. As provas de membership, papel e
titularidade continuam exigindo igualdade da resposta inteira com somente o
desfecho; o livro concluído é preservado. A fixture de políticas é removida no
`finally` e na limpeza do harness. O pgTAP acrescenta sete negações de replay
sob o grant nominal de `service_role`, precedidas da prova de que as sete
operações já têm registro concluído.

**Falhas de desenvolvimento dos testes.** A primeira preparação de (e) usou um
nome de campo incorreto na fixture de visibilidade e parou em 422 antes de
medir o replay. O campo foi corrigido para `confirm_members_visibility`; a
execução seguinte é a contraprova registrada na tabela. A primeira regressão
pgTAP copiou chamadas incompletas, parando no fechamento de `repeat()`, e
acusou sete erros `42601`. Corrigida a cópia da chamada inteira, a suíte passou.
As limpezas passaram, sem resíduo em `auth.users`. Nenhum prazo ou asserção
existente foi enfraquecido; essas falhas não são contadas como série verde.

**Validação medida do complemento.** AGENTS §5 completo, com todos os comandos
encerrados com saída 0 após as correções de desenvolvimento descritas acima;
`db:test:groups` e três séries integrais de `db:test:membership` também verdes.
O reset recriou o banco somente pelas migrations `0001`–`0016`.

- pgTAP: 15 arquivos, **1.108** asserções, **140** da `0016`.
- Harnesses: idempotência 7 `ok`, gateway 9, worker 8, exclusão 10, export 16 e
  grupos 29. Membership: **68** `ok` em cada série, **7,958 s / 7,950 s / 7,911 s**
  de parede, medidos pelo processo que executou os comandos.
- Nas três séries: zero `40P01`; 25 conexões observadas esperando, uma
  aprovação e 24 `GROUP_LIMIT`, cinco memberships ativas. As duas topologias de
  exclusão × transferência e as tempestades dos mesmos atores permaneceram
  verdes. As 17 definições vivas coincidem com o texto canônico; os 22 locks
  mantêm 21 `FOR NO KEY UPDATE` e o expurgo em `FOR UPDATE SKIP LOCKED`.
- Censo por série: 73 tabelas, quatro corpos, cinco logs de serviços e nove
  tabelas do Analytics sem motivo; sentinela **1** nos logs do Postgres e **1**
  no Analytics. Somente a auditoria aceita do GoTrue ficou: **+48** entradas por
  série. Não houve falha de ingestão nesta validação.
- `auth.users`, perfis, grupos e idempotência: **zero** no início e no fim da
  validação, antes e depois das três séries e depois das provas dirigidas. O
  censo final encontrou também catálogo de políticas, tabela, funções e
  gatilhos de sonda com **zero** linhas ou objetos. Nenhum `updated_at` de sonda
  permanece em `groups`.
- Web: Auth 8 passados e 2 pulados; privacidade 4 passados e 4 pulados; smoke 6
  passados. `verify:app`: 175 testes em 20 arquivos, lint, formato, tipos,
  build, PWA e configuração de Auth verdes.
- `scan:docs`, `scan:secrets`, `audit:high` e `git diff --check`: saída 0.
  Auditoria: **13** moderadas, nenhuma alta ou crítica. O primeiro
  `git diff --check` do driver apontou uma linha extra no fim deste documento,
  removida antes da conferência final. Scans repetidos após fechar o registro;
  nenhum `prettier` aplicado a `docs/`.

A comparação textual contra `1d5b1fb` confirmou somente os sete corpos de RPC
alterados; os outros dez corpos da `0016` são idênticos. O diff do complemento
contém somente a `0016`, seus testes, `13`, `25`, `26` e os dois checksums no
manifesto. Nenhum segredo real, projeto Supabase remoto, deploy ou serviço de
produção foi acessado. O PR continua draft para revisão independente.

## Fatia 3 — `0017_group_invites.sql` (PILOTO, 30/09/2026)

A `0017` entrega convite inicial em `create_group`, preview, pedido pendente do
titular, resgate por código e link, compartilhamento, revogação, regeneração,
emissão, limitador privado e os dois expurgos. `token_digest` segue a decisão
técnica do planejador de 30/09: SHA-256 hexadecimal minúsculo dos 66 bytes
binários do token. O vetor sintético literal está no teste TypeScript e no
pgTAP. `code_digest` usa HMAC da subchave exclusiva de lookup; o banco nunca
recebe token, MAC nem código humano. A URL local de teste usa somente
`127.0.0.1`; a origem e a rota públicas continuam como PERGUNTA para a
revisão do PR.

**Provas funcionais medidas.** `db:reset` recriou `0001`–`0017` somente pelas
migrations. `db:test` passou em 16 arquivos com **1.152 asserções**, incluindo
três provas de privilégios/RLS do limitador. Vitest dos módulos de material e
gateway passou com **10 testes**; TypeScript passou. O harness passa pela Edge
real com JWT GoTrue, não por implementação duplicada: criação e replay,
normalização/fingerprint de nomes, preview sem consumo, resgate e reentrada,
pendência própria, quota antes do domínio, autoridade após rebaixamento/saída,
sessão revogada antes de replay, compartilhamento e material terminal.
`delete_account` em grupo cheio liberou uma vaga; uma entrada passou e a
seguinte recebeu `GROUP_FULL`. Com limite local 2, 25 admissões concorrentes
do mesmo perfil tiveram duas admitidas e 23 recusadas, todas debitadas.

| Corrida | Ordem/prova | Resultado observado |
| --- | --- | --- |
| Seis RPCs idempotentes, mesmo ator | A→B e B→A, barreira no segundo recurso | 12 pares sem `40P01`; 12 mutantes `FOR UPDATE` reproduziram `40P01` |
| Seis RPCs, sem barreira | 20 pares por operação antes e depois | 240 pares; zero `40P01` |
| Último uso do convite | 25 resgates, 24 esperas de `Lock` | Um uso 100, 24 `INVITE_USED` |
| Capacidade 99/100/101 | Três resgates, duas esperas | Dois pedidos, um `GROUP_FULL`; grupo em 100 |
| Contraprova de capacidade sem locks de leitura | Três resgates esperando a linha do convite | Três pedidos admitidos; 101 vagas ocupadas; função original restaurada |
| Quinta vaga própria | Duas criações, ambas as ordens | Uma criação e um `GROUP_LIMIT` por ordem |
| Criação × aprovação | Ambas as ordens | Quinta vaga preservada; sem deadlock |
| Share × regeneração/revogação | Ambas as ordens | Material corrente ou recusa terminal sob lock do convite |

O lock comum das RPCs novas é `FOR NO KEY UPDATE`. A linha do convite usa
`FOR UPDATE` em regeneração e expurgo físico: o primeiro altera material
indexado por `code_digest`; o segundo remove a chave referenciada. O expurgo
do limitador usa `FOR UPDATE SKIP LOCKED` nas linhas a apagar. A contraprova
dos seis pares idempotentes substituiu só o lock do perfil por `FOR UPDATE`,
observou `40P01` nas duas ordens e restaurou a definição original antes das
tempestades sem barreira.

**Cinco séries consecutivas finais do harness:** 17,43 s; 17,21 s; 17,25 s;
17,53 s; 17,31 s de parede. Todas passaram, com `auth.users`, perfis, grupos,
convites, limitador, idempotência e registros próprios dos jobs em zero no fim.
O `pg_dump --data-only` do censo único mediu, nas cinco séries, 1.106.236;
1.113.877; 1.123.339; 1.131.897; 1.139.270 bytes. O audit log local do
GoTrue permanece como precedente aceito no M2: a consulta posterior contou
346 eventos acumulados, sem usuários, perfis ou grupos. Em cada
série, 59 corpos HTTP, cinco logs de serviços, o dump e quatro injeções
independentes no detector em memória não encontraram token, MAC ou
código fora da resposta de share autorizada. O sentinela apareceu no log do
Postgres em todas as séries, provando que o log foi lido. A Edge não integra
Sentry no piloto; o transporte em memória mede só o detector, não um canal
produtivo. A primeira revisão pediu sentinela positiva em cada canal lido.

**Validação integral após reset.** O comando de reset passou com a `0017`
aplicada; em seguida passaram `db:test` (16 arquivos, 1.152 asserções),
`db:test:idempotency` (7 provas), `db:test:gateway` (9), `db:test:worker`
(8), `db:test:deletion` (10), `db:test:export` (16), `db:test:groups`
(29), `db:test:membership` (68) e `db:test:invites` (61). A primeira rodada
de `db:test:membership` acusou somente o comparador textual herdado da `0016`,
que ainda exigia o corpo antigo de seis funções estendidas pela `0017`.
Corrigido o harness para exigir as seis definições exatas da migration mais
recente, a série integral passou; as demais onze funções da `0016` continuam
comparadas com o texto original. O teste preserva a recusa de qualquer outra
redefinição posterior.

Build de Auth e testes web: 8 passados/2 pulados; privacidade: 4 passados/4
pulados. Build smoke e seis testes smoke passaram. `verify:app` passou com
**185 testes em 22 arquivos**, lint, formato, tipos, build, PWA e configuração
de Auth verdes. `scan:docs`, `scan:secrets` e `git diff --check` passaram;
`audit:high` saiu 0, com **19 vulnerabilidades moderadas** e nenhuma alta ou
crítica. Nenhum segredo real, projeto Supabase remoto, deploy ou serviço de
produção foi acessado.

### Correção da primeira revisão do PR #45 (30/09/2026)

Os números acima pertencem ao commit original; a contagem histórica correta
do harness era **61** linhas `ok -`. A correção acrescentou as provas D34/D35
com mutantes de regravação, erro e emissão sem linha; 25 competidores do
limitador aguardaram a barreira, e o mutante sem lock admitiu mais de 2 após
todos terem contado sob o segundo recurso (FK). Janela deslizante, consulta
manual 20/10 e expurgo pelo job com 59 min 59 s preservados e 61 min apagados
passaram. O mutante que removeu U+200B do normalizador SQL fez o pgTAP falhar;
a definição original foi restaurada. O censo teve sentinelas positivas no dump,
nos cinco logs e nas respostas e erros HTTP; 79 corpos foram lidos na série
integral. Sentry não integra a Edge no piloto, portanto o detector em memória
não foi contado como transporte produtivo.

Três execuções finais consecutivas de `db:test:invites` passaram, mais a série
da validação integral; esta mediu **63** linhas `ok -`. `auth.users` tinha 0
linhas antes e depois; grupos, convites e limitador terminaram em 0. Após
`db:reset`, os 20 comandos do AGENTS §5 saíram 0: pgTAP **16/1.179**;
idempotência 7, gateway 9, worker 8, exclusão 10, export 16, grupos 29,
membership 68; web Auth 8 e privacidade 4, smoke 6; `verify:app` **190/22**;
scan de documentos e segredos, auditoria e `git diff --check` verdes. A
auditoria encontrou 19 moderadas e nenhuma alta ou crítica.

### Conferência final do PR #45 sobre `main` com D63 (30/09/2026)

O rebase preservou em `14` a D63-I corrigida (Google depois do piloto) e a
D63-C (Sentry antes da abertura pública), acrescentando apenas a origem pública
do `share_url`. A prova de expurgo passou a fixar o relógio do job em
`2030-01-02T03:04:05Z`: a tentativa de **1 h − 1 s** foi preservada, a de
**1 h + 1 s** apagada (`changed=1`). Com elegibilidade mutante em
**1 h + 50 s**, ambas permaneceram (`changed=0`) e a asserção de apagamento
reprovou. A definição original da função foi restaurada mesmo após a falha.
O HTTP agora prova `VALIDATION` (422) sem débito também para corpo que não é
JSON válido; o censo integral leu **80** corpos. O harness conservou **63**
linhas `ok -`.

Após a contraprova, os 20 comandos do AGENTS §5 passaram novamente, começando
por `db:reset`. `auth.users`, grupos, convites e limitador estavam em 0 ao fim.

## Fatia 3-B — `0018_rename_group.sql` (PILOTO, 01/10/2026)

A `0018` entrega apenas `rename_group` pela rota produtiva `groups/rename_group`.
A RPC permite ao dono e ao organizador ativo alterar `groups.name`. Jogador
ativo recebe `NOT_ORGANIZER`; pendente, removido e perfil de outro grupo recebem
`NOT_MEMBER`. Grupo suspenso recebe `GROUP_SUSPENDED`, arquivado recebe
`GROUP_ARCHIVED`. A criação e a renomeação chamam a mesma função SQL
`private.normalize_group_name`; o gateway compartilha a normalização de entrada
em `_shared/group-name.ts`. Foto, arquivamento e UI permanecem fora da fatia.

A operação integra a lista fechada e o desfecho exato do livro de idempotência:
`{group_id, logical_result: "group_renamed"}`. No replay, a sessão é conferida
após as travas e antes de expor o desfecho. Ator ainda autorizado recebe também
`current` com o nome fresco; ao perder autoridade, recebe só `outcome`; sessão
revogada recebe erro de autenticação. A ordem das travas é perfil, grupo e
membership, em `FOR NO KEY UPDATE`, conforme M2-D13.

**Provas medidas.** `db:reset` recriou `0001`–`0018` apenas por migrations.
`db:test` passou em **17 arquivos e 1.194 asserções**. O harness novo
`db:test:rename`, registrado no pacote, neste AGENTS §5 e na CI, passou com
**11 linhas `ok -`**: HTTP real pela Edge com JWT GoTrue provou os dois papéis
permitidos e os quatro casos sem autoridade; alteração exclusiva do nome;
replay com `current` fresco enquanto autorizado, sem `current` após perda de
papel ou membership, e erro de autenticação após revogação; suspensão e
arquivamento recusados pelos códigos do contrato. Um mutante da função SQL
compartilhada aceitou U+200B tanto na criação quanto na renomeação; restaurada
a função, ambas recusaram o mesmo nome inválido. Duas corridas de renomeação,
uma em cada ordem, usaram a barreira no segundo recurso: a última transação a
commitar venceu, sem `40P01`. O mutante `FOR UPDATE` no perfil reproduziu
`40P01` nas duas ordens; a função original foi restaurada. `auth.users` tinha
**0 antes e 0 depois**; grupos e registros de idempotência terminaram em 0.

Após o reset, passaram `db:test:idempotency` (7 provas), `db:test:gateway` (9),
`db:test:worker` (8), `db:test:deletion` (10), `db:test:export` (16),
`db:test:invites` (63), `db:test:groups` (29), `db:test:membership` (68) e
`db:test:rename` (11). Auth web passou com 8 testes e privacidade com 4;
smoke web passou com 6. `verify:app` passou com **194 testes em 22 arquivos**,
além de lint, formato, tipos, build, PWA e configuração Auth. `scan:docs`,
`scan:secrets`, `audit:high` e `git diff --check` passaram. A auditoria
registrou **19 vulnerabilidades moderadas**, nenhuma alta ou crítica. Nenhum
segredo real, projeto Supabase remoto, deploy ou serviço de produção foi
acessado.

## UI-A — entrada e convites de grupos (01/10/2026)

As telas 10, 11, 12, 16 e 24 usam apenas contratos publicados até a `0018`.
A navegação autenticada expõe Grupos e Perfil; Rachas permanece para o M3. A
lista distingue vazio, grupos ativos e pedidos próprios pendentes. A criação
abre o convite inicial. O detalhe mostra o papel próprio e a saída; o dono
solo vê o motivo de transferência antes do controle focável com `aria-disabled`; o acionamento não chama a Edge. A entrada por código ou link confirma o
nome por preview antes do resgate e mostra `pending` sem consumir novamente
quando o pedido já existe. A tela de convites copia o código e o link,
regenera, revoga e emite outra linha depois do término. Não há lista de membros na tela 11 (M2-D44, fatia própria) nem controles de
foto, arquivamento, rotação ou limitador por IP.

O fragmento do link é removido por `history.replaceState` antes da aplicação e
da observabilidade, inclusive para a pessoa já autenticada. Se a pessoa ainda precisa entrar, o token permanece apenas
na memória da página até a autenticação e então é consumido. Preview e resgate
não colocam o material nas variáveis do cache de mutações. A tela 24 lê o
material sensível diretamente num componente de vida curta, sem closure de
consulta que o retenha; a listagem usa `gcTime: 0`. No logout, consultas em
andamento são canceladas e `QueryCache` e `MutationCache` são limpos por
inteiro. O documento web é encerrado na mesma aba para liberar também rotas
privadas e strings externas que o browser ainda mantinha depois da limpeza.
Um aviso efêmero por `BroadcastChannel`, sem identificador ou credencial,
faz as outras abas encerrarem o documento e limparem seus caches também. O censo E2E examina
URL, referrer, histórico, headers, corpos de requisições, logs do navegador,
Cache API e storages persistentes. As contraprovas injetam sentinelas em URL,
estado do histórico, `localStorage`, `sessionStorage` e Cache API e exigem
reprovação do censo. Os corpos com token são aceitos somente nas duas rotas
contratadas de preview e resgate. Código e link foram copiados pelo navegador
e comparados em memória, sem imprimir o material no relatório.

O E2E semeia grupos e pessoas pela UI, Auth local e Edge real. Os 99 resgates
que lotam o grupo passam pela Edge com o limitador real configurado localmente
para 150 tentativas por perfil. A prova distingue `GROUP_FULL` com um uso
restante, o 100º uso após aprovação e remoção via Edge, e `INVITE_USED` após
outra vaga liberada. Outra prova configura o mesmo limitador em 2 tentativas e
verifica a terceira com `RATE_LIMITED` e horário absoluto. As únicas escritas diretas de fixture de domínio são `suspended_at` e
`expires_at` de convite, admitidas pela M2-D11 com decisão técnica de 01/10;
provam `GROUP_SUSPENDED` sem consumo e a mensagem `INVITE_EXPIRED`. A sexta criação recebe
`GROUP_LIMIT` sem criar grupo. A retentativa do resgate depois de
`RATE_LIMITED` e `RATE_LIMIT_UNAVAILABLE` usa o mesmo `request_id` observado
nos dois corpos HTTP. O horário de liberação é comparado com o `available_at`
servido, não apenas com um formato de data. Cada cenário apaga seus sujeitos sintéticos e
confere `auth.users = 0` depois; a primeira prova confere também o zero antes.

A saída do dono mantém foco no botão com `aria-disabled`, descreve o motivo
antes da ação e não envia requisição. A Edge real ainda retorna
`OWNER_MUST_TRANSFER` como contraprova. O jogador sai, recebe mensagem que
persiste na lista e não volta a ver o grupo ao navegar de volta. A tela 11
não mostra nomes e papéis de terceiros: a lista de membros foi
atribuída à M2-D44, em fatia própria, sem controle inerte nesta interface. A M2-D43 ficou no plano normativo; `15` e `16` foram alinhados. A tabela da
passada manual única pertence ao gate do piloto e não foi criada aqui.

Na contraprova de memória, o código anterior deixava no snapshot CDP tanto
o nome-sentinela como o token de A após B entrar no mesmo documento. O teste
foi corrigido para não chamar `page.goto` durante a entrada de B, pois isso
descartava o heap e mascarava a falha. Com limpeza integral e encerramento
do documento pela aplicação no logout, B entra na mesma aba e o snapshot
não contém nenhum dos dois marcadores. Sem `replaceState`, o E2E do link já
logado encontra o fragmento; descartando a intenção depois de `RATE_LIMITED`,
os dois `request_id` diferem e o E2E reprova.

**Validação medida.** `db:reset` recriou `0001`–`0018` apenas por migrations.
`db:test` passou em **17 arquivos e 1.194 asserções**. Os harnesses existentes
passaram: idempotência 7, gateway 9, worker 8, exclusão 10, export 16,
convites 63, fundação de grupos 29, membership 68 e renomeação 11.
`verify:app` passou com **194 testes em 22 arquivos**, lint, formato, tipos,
build, PWA, Auth, docs e segredos. Em cada uma de três séries consecutivas,
Auth web passou 8 testes, privacidade 4, UI-A 20 (dez cenários em mobile e
desktop) e smoke 6. Axe, foco de teclado, nomes acessíveis, reflow em 320 px e
os dois temas foram verificados em cada tela. `scan:docs`, `scan:secrets`,
`git diff --check` passou. A auditoria `audit:high` passou antes da nova
advisory do registry, mas a repetição final falhou duas vezes: 17
vulnerabilidades moderadas e quatro altas, todas pela dependência transitiva
`node-forge@1.4.0` de `expo@57`/`@expo/cli` (GHSA-86w9-cpqp-85rv).
Em 01/10, `1.4.0` era a versão publicada mais recente e a advisory não
indicava versão corrigida. O AGENTS §8 impede ampliar esta fatia UI-A para
alterar a cadeia Expo sem decisão de escopo. A validação e o commit final
ficam pendentes desse desbloqueio. As capturas com usuários sintéticos e
material sensível mascarado estão fora do repositório em
`~/colete-noite/ui-a-telas/`.

## Fatia 0019 — leitura dos membros (M2-D44)

A leitura `get_group_members` devolve somente `profile_id`, `display_name`,
`role` e `status`. Membros ativos veem os ativos do mesmo grupo; dono e
organizador ativo veem também os pendentes. Removidos e membros de outro
grupo ficam fora da projeção. A decisão humana de 02/10 define apelido
não vazio após trim, com nome como alternativa; quando há apelido, o nome
completo não sai. As decisões técnicas do planejador preservam a visibilidade
de memberships ativos de contas suspensas ou banidas, sem revelar o estado
da conta, e fixam a ordem por papel, nome sem distinção de caixa e UUID.
Pendentes vêm depois dos ativos, por data do pedido e UUID. Exclusão,
suspensão e arquivamento seguem o contrato registrado em `docs/13` §5.

A migration `0019` mantém intactos os privilégios e a policy de leitura do
próprio perfil. A função usa contexto autenticado, locks de perfil e grupo
e projeção estreita; não armazena dado novo. A tela 11 mostra nome e papel
dos ativos e somente nomes na seção de pedidos, sem ações da UI-B. Os tipos
foram regenerados do banco local, incluindo entradas anteriores que faltavam
no arquivo gerado. O harness `db:test:members` entrou no package, AGENTS §5
e CI no mesmo commit da implementação.

As provas usam HTTP real e papel-sonda sem BYPASSRLS para dono, organizador,
jogador, pendente, removido, outro grupo e anônimo. O censo por valor busca
marcadores sintéticos de contato, campos de perfil e nome completo quando
há apelido. Contraprovas executáveis retiram a autorização, incluem pendentes
ou removidos indevidamente, cruzam grupos, invertem a ordem e devolvem nome
completo ou um quinto campo. Cada implementação defeituosa reprova. As
barreiras dos locks são observadas com PIDs distintos, commit efetivo e
contraprova retirando cada lock. Os catálogos pgTAP conferem a policy original,
os quatro campos e os privilégios. Contas em exclusão ou já desidentificadas
não aparecem; contas suspensas ou banidas não expõem estado de conta.

A tela passou axe, teclado, temas e reflow em 320 px. O snapshot CDP encontra
os nomes sintéticos do dono, ativo e pendente de A antes do logout e não os
encontra depois da entrada de B, junto com os marcadores de grupo e convite.
O observer continua tratado por `handledObserver`. Nenhuma asserção foi
reduzida; não foram acrescentados retries, sleeps ou timeouts maiores.
Uma execução exploratória corrigiu a fixture que consultava dois nomes e
esperava três. A terceira passada UI-A foi invalidada pelo fechamento do
notebook: `pmset` registrou suspensão de 280 segundos, coincidente com duas
requisições locais de aproximadamente 279 segundos que retornaram HTTP 200.
A passada foi repetida integralmente e aprovada.

**Validação medida em 02/10/2026.** `db:reset` recriou `0001`–`0019` somente
por migrations. `db:test` passou em 18 arquivos e 1.210 asserções, incluindo
16 novas asserções de catálogo. Passaram os harnesses de idempotência,
gateway, worker, exclusão, export, convites, grupos, membership, renomeação
e membros. Auth, privacidade, grupos e smoke tiveram três passadas completas:
por passada, 8, 4, 22 e 6 testes aprovados, respectivamente; total de 120
execuções aprovadas e 18 skips preexistentes. `verify:app` passou com 194
testes unitários em 22 arquivos, lint, formato, tipos, builds e verificações
PWA/Auth. `scan:docs`, `scan:secrets`, `test:audit`, `audit:high` e
`git diff --check` passaram. A auditoria conserva a exceção transitória
anterior, sem nova exceção nesta fatia.

O censo final confirmou zero em `auth.users`, perfis, grupos, memberships,
convites, limitadores de convite, idempotência, efeitos, exports e pedidos
de exclusão, além de zero papéis-sonda residuais. O zero de `auth.users` foi
medido também antes das provas. Nenhum Supabase remoto, deploy ou serviço
produtivo foi acessado. Containers de outros projetos não foram alterados.
As capturas inspecionadas estão em `~/colete-noite/ui-a-telas/`:
`11-com-lista.png` e `11-com-pendentes.png`. Não restam PERGUNTAS da fatia.

### Correção da revisão independente do PR #52 — 03/10/2026

A revisão independente encontrou lacunas nas provas, sem defeito produtivo.
O harness agora compara os corpos 403 de pendente, removido, outro grupo e
grupo inexistente, retirando apenas `request_id`; cobre arquivado para dono,
organizador e jogador ativos e nega divulgação a pendente, removido e outsider.
Cada alternativa de apelido nulo, vazio e só com espaços é lida por HTTP,
comparada ao nome esperado e exigida não vazia. Dois perfis de fixture com
UUIDs fixos tornam `CaseTie`/`casetie` um empate em que a ordem sem `lower()`
é sempre diferente. O papel `owner` é afirmado semanticamente, independentemente
do papel `organizer` da membership. A barreira nova observa a leitura esperando
no perfil, commita revogação de sessão ou estado `deletion_pending` no detentor
e exige rejeição pela segunda checagem do ator após a trava.

Os mutantes literais M17, M16, M19, M14 e M18 da revisão reprovam nas
asserções novas. M10, que retira `lower()`, reprovou **7 de 7 execuções** na
mesma linha; a prova anterior dependia de UUIDs aleatórios e não sustentava
essa garantia. Todas as 12 execuções terminaram com `auth.users = 0` e
restauração conferida por MD5 da definição original. Controle anterior sem
mutante passou. Comandos, linhas e logs estão fora do repositório em
`~/colete-noite/corr52-contraprovas.md` e `~/colete-noite/corr52/`.

A decisão técnica A de 03/10 ficou em `13`: o ramo 410 protege o contrato
pós-piloto, pois arquivar no fluxo atual torna as memberships removidas.
A decisão humana B ficou em `25` §8.1: a leitura permanece disponível com
membership ativa e aceite pendente ou conta suspensa. O §8.2 registra a
reavaliação pós-piloto de contas suspensas/banidas e as observações 8 e 10
sobre contenção e cobertura de cache no E2E, sem ação nesta correção.
O mapa do §2 ganhou a linha da `0019`. Foram retirados os rótulos copiados
da `0018` do harness. Migration, Edge, API e tela não mudaram; nenhum teste,
retry ou timeout foi enfraquecido. O rebase sobre o merge do PR #53 preservou
o patch original, confirmado por `range-diff`, e a correção fica em commit
separado para conferência.

**Validação da correção.** O reset posterior aos mutantes recriou `0001`–`0019`
somente por migrations; pgTAP passou 1.210 asserções em 18 arquivos e os 11
harnesses de banco passaram. Auth, privacidade, grupos e smoke passaram três
vezes, respectivamente 8, 4, 22 e 6 testes por passada: 120 aprovações e 18
skips preexistentes. `verify:app` passou, incluindo 194 unitários em 22 arquivos;
scans de docs/segredos, os 12 casos de `test:audit`, `audit:high` e
`git diff --check` passaram. A auditoria usa as duas exceções datadas herdadas
do PR #53, sem alteração nesta fatia. Uma chamada inicial de browser não
executou testes porque uma expansão do zsh gerou `test:b`; a chamada foi
corrigida, sem mudar suíte ou aplicação. `auth.users` foi zero antes e depois;
o censo final confirmou também zero em perfis, grupos, memberships, convites,
idempotência, limitadores, efeitos, exports, pedidos de exclusão e papéis-sonda.
O hash da função viva continuou igual ao original da revisão independente.

## UI-B — gestão de membros e configurações do grupo (03/10/2026)

As telas 17 e 25 entram pelas ações da tela 11 para dono e organizador ativo.
Jogador não recebe as entradas; a rota direta não renderiza nome do grupo,
lista nem controle administrativo. `get_group_members` é a fonte dos quatro
campos permitidos, incluindo `display_name`; a UI nunca lê perfis de terceiros.
A leitura final revalida o papel próprio e as consultas ficam na raiz privada,
com `gcTime: 0`. Nenhuma migration, RPC, policy, grant, Edge Function ou
biblioteca foi criada ou alterada.

A tela 17 prioriza pendentes e decide aprovar/recusar por `approve_member`.
Somente o dono promove/rebaixa por `set_role`; dono não recebe expulsão nem
controle de papel sobre si. Expulsão por `remove_member` exige confirmação e
motivo de 1 a 500 caracteres, com aviso de que o motivo ainda não é guardado.
O aviso descreve somente saída do grupo e necessidade de novo pedido de entrada.
Depois de cada ação, a lista é relida; não há atualização otimista.
A tela 11 tem um único heading de nível 3 para pendentes, em tamanho de seção.

A tela 25 renomeia para dono/organizador com o schema de nome compartilhado
com a criação: NFC, controles proibidos, espaços Unicode e 2–40 pontos de
código, sempre com validação definitiva no servidor. O nome confirmado vem da
projeção. Titularidade escolhe outro membro ativo e exige duas confirmações;
transferência relê o papel do antigo dono e remove os controles exclusivos de
dono. Cancelar não muta e devolve foco ao controle de origem; quando o controle
some após sucesso, o foco fica em Atualizar dados. Campos inválidos recebem
foco, anúncio e revalidação após o primeiro erro; botões permanecem habilitados.

As cinco mutações foram acrescentadas à API cliente, todas no gateway `groups`.
`profile_id` é permitido somente como alvo de `approve_member`, `remove_member`
e `set_role`; a recusa recursiva de campos de ator/HMAC continua. Intenções e
motivo ficam na memória do componente, fora do cache de mutações; retry de
rede, 429 ou 503 conserva a intenção. Nenhum retry, timeout ou sleep de
sincronização foi acrescentado. Leitura pós-ação também evita publicar resultado
de componente encerrado durante troca de sessão.

### Matriz de controles provada

| Controle | Dono | Organizador ativo | Jogador |
| --- | --- | --- | --- |
| Entradas das telas 17 e 25 na tela 11 | sim | sim | ausentes |
| Aprovar e recusar pedidos | sim | sim | ausentes |
| Promover e rebaixar | sim, exceto sobre o dono | ausentes | ausentes |
| Expulsar com motivo e confirmação | sim, exceto dono | sim, exceto dono | ausente |
| Renomear | sim | sim | ausente |
| Transferir com dupla confirmação | sim, para outro ativo | ausente | ausente |
| Rota administrativa direta | dados e controles autorizados | somente controles devidos | nenhum dado ou controle administrativo |

### Provas e contraprovas

`e2e/m2-ui-b.spec.ts` tem dez cenários em dois viewports, integrado a
`test:groups:web`, AGENTS §5 e job Database security. Auth, Edge e Postgres são
locais reais. Os sete caminhos de sucesso são conferidos no banco. Perda de
papel, remoção e mudança de alvo por outra sessão devolvem erro e retiram dados
antigos. `MEMBERSHIP_ALREADY_DECIDED`, `GROUP_LIMIT`, `GROUP_FULL`, `NOT_FOUND`,
`IS_OWNER`, `NOT_ACTIVE_MEMBER`, `OWNER_ONLY`, `NOT_ORGANIZER`,
`GROUP_SUSPENDED` e `GROUP_ARCHIVED` têm mensagens estáveis e provas HTTP reais.
O teste de envelopes sintéticos cobre separadamente a apresentação de cada
mensagem; não substitui a prova do contrato no banco.

Para `NOT_FOUND` e `IS_OWNER`, o transporte do teste substitui somente o alvo
externo antes da Edge real, porque a interface não oferece ação sobre o dono.
`GROUP_LIMIT` usa cinco grupos criados pela Edge pelo alvo pendente;
`GROUP_FULL` baixa temporariamente a configuração canônica de capacidade para
4 sobre cinco vínculos, restaurando 100 em `finally`. Não há bypass do limite.
`GROUP_SUSPENDED` usa somente a fixture de `suspended_at` permitida pela M2-D11.
A pergunta exploratória de `archived_at` foi resolvida sem fixture nova:
o organizador mantém a tela aberta, sai pela Edge, o dono remove o outro ativo
e pede exclusão; o arquivamento solo com pendentes é medido no banco e a próxima
renomeação da sessão removida recebe `GROUP_ARCHIVED`. Cleanup conserva os IDs
de perfil conhecidos para limpar também a saga depois da desidentificação.

As respostas 429 e 503 são sintéticas, antes do efeito de aprovação;
a segunda tentativa atravessa a Edge real, conserva `request_id` e conclui
um único registro de idempotência no banco. Logout/login usa a mesma aba,
sem navegação de teste para descartar o heap: a aplicação encerra o documento;
o nome-sentinela presente antes não aparece depois no snapshot CDP, HTML,
histórico, storages ou Cache API. Axe nos dois temas, teclado, foco, alvos
mínimos, 320 px e texto ampliado a 200% são exercitados nas telas e nas
confirmações. A passada manual com leitor de tela continua no gate do piloto,
conforme M2-D43; não foi substituída por axe.

Sete mutantes isolados reprovaram: entrada para jogador; rota administrativa
para jogador; controles de papel para organizador; controles sobre o dono;
transferência para organizador; seleção de pendente para transferência; e
intenção descartada no retry. O último reprova tanto 429 como 503: oito
reprovações no total. Cada fonte foi restaurada exatamente. Comandos, alteração,
linha de asserção e restauração estão em `~/colete-noite/ui-b-contraprovas.md`.
A primeira execução ampliada teve 15 de 16 aprovações: o teste de mensagens
clicava antes do fim da releitura anterior. A sincronização passou a esperar o
fim do carregamento visível, sem relaxar asserção nem aumentar prazo.

### Validação medida

Após as contraprovas, `db:reset` recriou `0001`–`0019` somente por migrations
em 26,98 s. pgTAP aprovou **1.210 asserções em 18 arquivos**. Os onze
harnesses existentes passaram: idempotência 7 provas, gateway 9, worker 8,
exclusão 10, export 16, convites 63, fundação de grupos 29, membership 68,
renomeação 11 e leitura de membros 6 linhas `ok -` (o harness executa sua
matriz e mutantes internamente). Nenhum objeto de banco produtivo mudou.

Três séries completas da versão final aprovaram **8 Auth, 4 privacidade,
42 grupos (22 UI-A + 20 UI-B) e 6 smoke por série**: **180 execuções
aprovadas**, além de 18 skips preexistentes de Auth/privacidade. Nenhum skip
foi introduzido na UI-B. Tempos de parede de `test:groups:web`: 154,85 s,
156,79 s e 147,14 s. Uma série anterior passou 40 testes de grupos antes da
inclusão da prova real de arquivamento e não foi contada nessas três séries.
Não houve suspensão do Mac durante as passadas; o último Wake em `pmset`
precede o início do trabalho.

`verify:app` saiu 0 em 22,53 s: lint, formato, tipos, **196 unitários em
22 arquivos**, build, PWA, configuração Auth, documentos e segredos.
`scan:docs`, `scan:secrets`, `test:audit`, `audit:high` e `git diff --check`
passaram. Auditoria não encontrou alerta alto/crítico fora das duas exceções
datadas herdadas; nenhuma exceção ou dependência foi acrescentada.

`auth.users = 0` antes e depois da validação. O censo final mediu zero em
Auth, perfis, grupos, memberships, convites, limitador, idempotência, efeitos,
exports, pedidos de exclusão, jobs, retenção e sessões revogadas, além de
zero papéis-sonda. Logs e tempos estão em `~/colete-noite/ui-b-validacao/`.
As nove capturas requeridas, inspecionadas e com **840 px de largura**, estão
em `~/colete-noite/ui-b-telas/`: `11-titulo.png`, `17-com-pendentes.png`,
`17-sem-pendentes.png`, `17-expulsao.png`, `17-organizador.png`, `25-dono.png`,
`25-organizador.png`, `25-transferencia-1.png` e `25-transferencia-2.png`.
Não há e-mail ou segredo visível. Nenhum Supabase remoto, deploy ou serviço
de produção foi acessado; containers alheios foram preservados.

### Fora da fatia e revisão

Visibilidade das notas entra no M6 por decisão humana de César em 03/10/2026;
`set_ratings_visibility` permanece intacta. Mensalista (M2-D6), foto,
arquivamento por RPC (M2-D40) e convidados avulsos continuam fora. Não restam
PERGUNTAS de contrato/produto da UI-B. O M2 inteiro ainda depende de suas
pendências e revisão pós-marco; esta entrega não o declara fechado.
A UI-B é de risco alto por tocar capacidade, sessão e nomes de membros.
O PR do autor permanece em draft, sem merge, para revisão independente
conforme AGENTS §4.11/§4.12.


## UI-B — correção da revisão independente do PR #54, 04/10/2026

A revisão do head `6a46c2e` encontrou quatro P2 e sete P3, sem P1. Os onze
itens foram tratados nesta rodada, sem alterar `supabase/`, dependências,
workflow ou configuração Playwright. A decisão técnica Q1 do planejador
foi registrada em `13` §5 e `25` §8.1, com os checksums atualizados:
transferir troca somente `groups.owner_id` e conserva o papel armazenado.
A leitura cliente expõe esse papel já retornado na própria membership; o
aviso diz organizador ou jogador conforme a leitura, com prova de ambos.

A decisão de pendente anuncia nome e ação numa região persistente e leva
o foco ao resultado; duas decisões seguidas não repetem o mesmo texto.
Os botões de linha incluem a pessoa no nome acessível. Recusar é secundário.
A confirmação usa a fonte do sistema, fica logo depois do controle de origem
e recebe foco/rolagem ao abrir; cancelar devolve foco e mantém a origem visível.
O campo de nome começa preenchido pela projeção confirmada. Os textos não
expõem “pelo servidor”, a transferência informa o destinatário e
`PROOFS_PENDING` orienta resolver os comprovantes antes da remoção.

### Provas acrescentadas à suíte regular

A UI-B passou de dez para dezesseis cenários, sem novo harness. A matriz
confere DOM, requisições e respostas nas rotas administrativas de jogador,
pendente, removido e não-membro. A intenção nova é provada depois de falha
para outro alvo, outro motivo e outro nome. Duas ações de clique na mesma
tarefa do navegador enviam uma requisição em aprovação, papel, expulsão
e transferência; quatro registros de idempotência correspondem às quatro
mutações. `route.abort` esgota os retries preexistentes e prova ID estável
nas tentativas automáticas e na tentativa manual seguinte. Nenhum retry,
timeout, sleep de sincronização, skip ou dependência foi acrescentado.

A lista longa nasce por Auth e Edge reais: **20 ativos e dois pendentes**.
São **42 nomes acessíveis distintos** na tela 17 e **19 escolhas distintas**
na tela 25. Os testes conferem a fonte computada, o estilo secundário de
Recusar, nome atual no campo, distância de até 24 px da origem à confirmação
de expulsão, confirmação dentro da linha, headings/botões visíveis na área
do navegador, foco inicial e retorno à origem ao cancelar. Os dois viewports
passam; a passada manual com leitor de tela permanece no gate M2-D43.

### Contraprovas desta rodada

Sete mutantes reprovaram por asserção e foram restaurados byte a byte,
com SHA-256 conferido antes do próximo. M3, M5a e M5b foram reaproveitados
do revisor; em M5a só a indentação da substituição foi adaptada à confirmação
movida para a linha. Comandos, alterações, linhas e hashes estão em
`~/colete-noite/corr54-contraprovas.md` e `corr54-mut/`.

| Item | Regra quebrada / mutante | Teste em `e2e/m2-ui-b.spec.ts` | Linha da reprovação |
| --- | --- | --- | --- |
| 1 | sem foco no resultado | fluxo completo de decisões | 349 |
| 2 | botões sem a pessoa no rótulo | lista de vinte ativos | 1232 |
| 4 | motivo novo conserva ID, M5a | CP5 intenção nova | 1144 |
| 4 | sem guarda busy, M5b | CP5 duplo clique | 1059 |
| 8 | expulsão no fim do cartão | lista de vinte ativos | 1255 |
| 8 | transferência no fim do cartão | lista de vinte ativos | 1295 |
| 11 | jogador busca membros, M3 | matriz de rede CP3 | 1008 |

### Validação medida nesta correção

`db:reset` recriou `0001`–`0019` somente pelas migrations em **25.40 s**. pgTAP passou **1.210 asserções em 18 arquivos**. Todos os dez harnesses de banco passaram, incluindo leitura de membros. `verify:app` passou em **12.26 s**, com **196 unitários**. Scanners, auditoria alta, testes de auditoria e `git diff --check` passaram; nenhuma exceção de auditoria foi acrescentada.

Três séries da versão final passaram **8 Auth + 4 privacidade + 54 grupos (22 UI-A + 32 UI-B) + 6 smoke** por série: **216 execuções aprovadas**, com 18 skips preexistentes de Auth/privacidade. Tempos de grupos: **156.32 s, 157.97 s, 158.06 s**. A primeira seleção do novo teste de rede abortava só uma tentativa e foi corrigida para esgotar os retries existentes. Uma primeira série foi descartada porque seu build antecedeu o ajuste final da mensagem de transferência; os testes detectaram a mensagem antiga. Uma tentativa da segunda série foi invalidada por suspensão do Mac, registrada em `suspension.log`; dois testes de Auth expiraram. Ela foi repetida com proteção temporária contra repouso ocioso, sem mudança de timeout. As três séries contadas foram repetidas após o ajuste CP3 e usam builds correspondentes à versão final. Logs e tempos finais estão em `~/colete-noite/corr54-validacao/round2/`; as execuções anteriores foram preservadas.

`auth.users = 0` antes e depois; o censo final e a limpeza da pilha foram
registrados em `corr54-validacao/round2/`. Os **4.616 registros de auditoria do Auth** desta repetição (e 6.153 na rodada anterior)
gerados pelas fixtures locais foram removidos no cleanup final, depois de
confirmar que não havia usuário Auth; auditoria, identities, sessions e
refresh_tokens também ficaram em zero. Nenhum dado/objeto residual dos testes,
Supabase remoto, deploy ou serviço de produção. Uma pilha Colete por vez;
contêineres `siac-*` e de outros projetos preservados.

Capturas afetadas refeitas e inspecionadas em `~/colete-noite/ui-b-telas/`:
`17-com-pendentes.png`, `17-sem-pendentes.png`, `17-expulsao.png`,
`17-expulsao-20-membros.png`, `25-dono.png`, `25-transferencia-1.png` e
`25-transferencia-2.png`; largura de 840 px, usuários sintéticos, sem
e-mail ou credencial visível. O PR continua draft e não foi mergeado.
As correções aguardam conferência independente conforme a cerimônia D63.
Não há nova pergunta de contrato; Q1 foi decidida pelo planejador.


### Ajuste da prova de rede após a CI

O run `37257169861` passou quatro jobs e falhou em Database security,
na matriz CP3 wide. O trace isolou uma resposta de `get_own_deletion_request`
iniciada na página de login antes do `goto`: a navegação cancelou o corpo
depois dos headers, e `response.text()` ficou pendente até o timeout.
A coleta agora associa cada resposta à requisição iniciada no intervalo
observado da rota testada. As asserções de requisições administrativas,
dados de outros membros e DOM foram preservadas, sem novo timeout, retry
ou sleep. Os sete mutantes reprovaram novamente e as fontes foram
restauradas por SHA-256; logs em `corr54-mut/round2/`.

AGENTS §5 e browsers 3× foram repetidos integralmente após o ajuste CP3: 216 aprovações, 18 skips preexistentes; nenhum parâmetro de execução foi ampliado. Os sete mutantes finais e as linhas atualizadas estão em `corr54-mut/round2/`.


## Faxina A — inventário e ajustes, 05/10/2026

Esta fatia altera testes, harnesses, os pequenos ajustes de tela autorizados e
registros documentais. Não altera migrations, Edge Functions ou dependências.
Os censos anteriores deste documento são medições históricas de cada execução,
não o censo da árvore atual. O censo desta fatia será registrado depois da
validação, sem copiar os números anteriores.

Origem: revisões e conferências salvas em `~/colete-noite/` (`rev40`, `rev46`,
`rev52`, `conf52`, `rev53`, `rev54`, `conf54` e `conf50b`). O inventário detalhado,
comandos e contraprovas estão em `progresso-faxina-a.md` e
`faxina-a-contraprovas.md` nesse diretório.

PERGUNTA: item 5 do roteiro — qual é a contraprova específica de `40P01` que
“deixou de reproduzir”? As fontes indicadas não identificam esse caso. A
contraprova embutida de rename reproduziu o deadlock nas duas ordens nesta
execução; não removemos uma prova sem identificar sua origem.

PERGUNTA: item 12 do roteiro — qual trecho do “censo antigo” deve ser corrigido?
As revisões indicadas identificam a nomenclatura “Fatia 4”, corrigida para
“Fatia 3-B”, mas não apontam um censo específico. As medições históricas foram
preservadas; a validação desta fatia terá seu próprio censo.


### Validação medida da Faxina A

Os **35 comandos npm** da validação saíram com código 0, incluindo a seção 5
completa e as três séries de browsers. `db:reset` aplicou `0001`–`0019` em
**25,79 s**; pgTAP passou **1.210 asserções em 18 arquivos**. Todos os harnesses
passaram. O worker final rodou duas vezes adicionais após a prova de resíduo:
um job da execução anterior reprova os censos e o processo encerra com código 1;
a fixture foi removida e as duas execuções corretas encerraram com código 0.
A conexão administrativa fecha mesmo quando o censo falha, e falhas de prova
mais limpeza são conservadas juntas em `AggregateError`.

Cada série passou **8 Auth + 4 privacidade + 58 grupos (24 UI-A + 34 UI-B) +
6 smoke**: **228 aprovações**, com **18 skips preexistentes** de Auth/privacidade.
Tempos de Grupos: **173.37, 170.80, 170.58** segundos. `verify:app`, os scanners,
12 testes de audit, auditoria alta e `git diff --check` passaram. Não foram
alterados retries, timeouts, skips, migrations, Edge Functions ou dependências.

O censo final usou conexão nova: a conexão do wrapper, aberta antes do reset,
foi encerrada pelo reset e retornou `57P01` ao tentar a leitura final. Essa
falha de instrumentação não foi omitida do progresso nem confundida com uma
falha de teste. O setup da prova negativa do worker inicialmente tentou um
resumo vazio, recusado por `VALIDATION`; a fixture foi corrigida para o mesmo
registro `running` já usado pelo harness, sem mudar validador ou regra de banco.

`auth.users = 0` antes e depois. Foram medidas **54 tabelas BASE TABLE** em
`public`, `private`, `auth` e `storage`, além de **zero papéis-sonda**. O censo
mediu zero em tabelas de domínio/operacionais e Storage objects. Depois de
confirmar ausência de usuários Auth, foram removidos somente os **4.736
registros de auditoria Auth** e **6 fluxos Auth** sintéticos criados desde o
início desta validação, conforme o precedente da correção UI-B. O censo antes
dessa limpeza foi preservado; o censo final confirma zero nas duas tabelas.
As tabelas de configuração/controle de migrations conservam suas linhas:
Auth schema migrations 82, MIME 4, limites 17, buckets 2 e Storage migrations 73
(cinco tabelas não vazias depois do cleanup; nenhuma linha foi criada por teste).

Evidências: `~/colete-noite/faxina-a-validacao/results.json`, `census.json`,
`census-before-provider-cleanup.json`, `auth-antes.txt`, `auth-depois.txt` e
`faxina-a-contraprovas.md`. Nenhum serviço de produção, Supabase remoto ou deploy
foi acessado. A pilha local será parada e o worktree removido depois da CI verde;
o PR permanece draft, sem merge, para revisão independente de risco alto.


## Faxina B — 0020, decisões do planejador de 05/10/2026

Base `1710285` (PR #56 mergeado). A `0020_m2_cleanup_b.sql` aplica M2-D15 e
M2-D21 sem alterar assinaturas, erros/efeitos da chamada nova, ordem de locks
ou privilégios. Nenhuma migration entregue anteriormente foi editada.
Linhas abaixo do `pg_get_functiondef` vivo antes/depois da `0020`; NKU =
`FOR NO KEY UPDATE`. A lista de Faxina B foi esvaziada em `25` §8.2.

| Função | Linha | Tabela | O que faz com a linha | Antes | Depois | Justificativa | FK de entrada | Prova |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `private.reconcile_deletion_request` | 13 | `deletion_requests` | status, retry e código de erro | FOR UPDATE | NKU | id/profile_id intactos; não apaga | sem FK de entrada | espera observada; estado novo após commit |
| `public.consume_data_export` | 21 | `data_exports` | ready → downloaded e downloaded_at | FOR UPDATE | NKU | id/privacy_request_id/storage_path intactos | sem FK de entrada | espera observada; estado novo após commit |
| `public.enqueue_data_export_purge` | 9 | `data_exports` | ready → cleanup_pending | FOR UPDATE | NKU | nenhuma coluna única muda | sem FK de entrada | espera observada; estado novo após commit |
| `public.finalize_deletion` | 19 | `deletion_requests` | zera auth_user_id, conclui e limpa erro | FOR UPDATE | NKU | auth_user_id da saga não é chave; id/profile_id intactos | sem FK de entrada | espera observada; estado novo após commit |
| `public.worker_acquire_external_effect` | 67 | `external_effects` | lease, attempts, status e token de fencing | FOR UPDATE SKIP LOCKED | NKU SKIP LOCKED | lease_token não é único; id/dedupe_key intactos | sem FK de entrada | pula linha retida; estado novo após commit |
| `public.worker_complete_external_effect` | 26 | `external_effects` | fecha/reagenda lease e status | FOR UPDATE | NKU | id/dedupe_key intactos | sem FK de entrada | espera observada; estado novo após commit |
| `public.worker_finish_job` | 24 | `job_runs` | status, summary e conclusão | FOR UPDATE | NKU | id/run_key intactos | sem FK de entrada | espera observada; estado novo após commit |
| `public.worker_publish_data_export` | 9 | `external_effects` | lê efeito fenced | FOR UPDATE | NKU | nenhuma coluna do efeito muda | sem FK de entrada | espera observada; estado novo após commit |

A sonda explícita aprovada na decisão A isola a trava inventariada; as duas
chamadas da sonda e o observador usam três backends/application_name distintos.
O primeiro retém a linha, muda estado não chave e só commita depois de o
observador confirmar a espera do segundo em `pg_locks`/`pg_stat_activity`, com
`pg_blocking_pids` apontando para o primeiro. A segunda leitura trava e enxerga
esse estado; na variante SKIP LOCKED retorna zero linhas enquanto retida e lê
após commit. Não há sleep, segundo recurso inventado ou afirmação de deadlock.
O catálogo liga cada sonda à linha real da função; os corpos completos são
comparados byte a byte. Os harnesses existentes continuam exercitando as RPCs
inteiras sob `service_role`, commits reais e as provas herdadas de mesmo ator
por upgrade e do par cruzado de FK. A sonda não se apresenta como chamada
inteira da saga nem como prova de um ciclo inexistente.

Nenhuma FK aponta para as quatro tabelas, confirmado pelo catálogo. Portanto
as oito partes de compatibilidade KEY SHARE e suas contraprovas no modo antigo
estão dispensadas pela decisão A. A exclusão mútua também existe no modo
antigo; não se afirma que revertê-lo a reprove. Oito contraprovas adicionais de
catálogo reverteram cada definição pré-0020 individualmente, reprovaram o corpo
exato e restauraram `pg_get_functiondef` idêntico.

Dois `FOR UPDATE` permanecem no mesmo corpo/ordem: `finalize_deletion` L17 em
`profiles` zera `auth_user_id` único; `worker_publish_data_export` L14 em
`data_exports` grava `storage_path` único. O catálogo afirma os índices únicos
e os corpos contendo esses UPDATEs, além das provas funcionais das sagas.

O replay do export adquire a mesma trava de perfil NKU e aplica exatamente a
guarda da chamada nova antes de devolver qualquer desfecho/projeção. Não há
checagem adicional de conta ativa ou aceite no canal de privacidade.

| Caso HTTP | Replay medido | Comparação com chamada nova |
| --- | --- | --- |
| autoridade íntegra | 200, outcome original + current fresco | guarda aceita; export existente dá EXPORT_ALREADY_PENDING |
| sessão revogada | 401 UNAUTHENTICATED, sem data/outcome/current | mesmo erro |
| conta em exclusão | 403 FORBIDDEN, sem data/outcome/current | mesmo erro |
| conta suspensa | 200, outcome original + current fresco | guarda aceita |
| conta banida | 200, outcome original + current fresco | guarda aceita |
| aceite obrigatório pendente | 200, outcome original + current fresco | guarda aceita; dois documentos obrigatórios sem aceite |
| conta excluída/desidentificada | 404 NOT_FOUND, sem data/outcome/current | mesmo erro |

A projeção original queued é comparada com o estado building posterior, não
apenas com a presença de current. O censo afirma um único export, sem repetir
efeito. Contraprova B: definição pré-0020 devolve 200 no replay revogado e
reprova a expectativa 401; restaurada exatamente.

| Item | Entrega e prova |
| --- | --- |
| A | oito modos NKU, oito sondas explícitas; 49 asserções novas de catálogo abrangem A/B; allowlist exata de 39 rotinas e atributos preservados; oito mutantes reprovam |
| B | sete casos HTTP, guarda idêntica à chamada nova, outcome original/current fresco; mutante sem revalidação reprova |
| C | nenhuma produção alterada; sete RPCs conservam prova 409/422 antes do 401; nove combinações indefinidas medidas em set_monthly e movidas para pós-piloto, não normativas |
| D1 | guarda compartilhada para Auth, logout manual e broadcast; unitário e heap nos dois viewports; contagem de documentos no logout manual, refresh inválido e por aba no logout cruzado; zero recargas adicionais sem sessão e com refresh válido |
| D2 | AggregateError preserva causa primeira, ordem e SQLSTATE nos quatro catches; dupla falha reprova quando se retorna apenas o rollback |
| D3 | descrição correta dos sete harnesses; scan:docs compara os sete call sites reais; descrição com três reprova |

A comparação canônica do harness de grupos exige a `0015` exata para 14
funções e a `0020` exata para request_data_export; só essa redefinição posterior
é autorizada. A primeira execução da retomada detectou essa baseline antiga,
que foi corrigida mantendo a comparação integral e repetindo a suíte de banco.

Medições finais da retomada: AGENTS §5 completo, todos os comandos com saída
0. Reset pelas vinte migrations; pgTAP 1.259 asserções em 19 arquivos (49
novas), confirmado novamente no fim. Dez harnesses obrigatórios passaram;
grupo repetido após preservar as duas contraprovas do comparador, 2,768 s.
verify:app passou, incluindo 197 unitários em 23 arquivos, lint, formato,
tipos, build, PWA, configuração Auth e scanners. scan:docs, scan:secrets,
test:audit, audit:high e diff --check passaram. Auditoria respeitou as duas
exceções ativas; nenhum alerta alto/crítico fora delas. Tipos gerados do banco
sem diff. Nenhum prettier executado em docs/.

Browsers 3×: 228 aprovações e 18 skips preexistentes (nenhum novo): por série,
8 Auth + 4 privacidade + 58 grupos + 6 smoke. Grupos em 177,237 /173,237
/176,830 s; heap e navegação única verdes nos dois viewports. Nenhum retry,
timeout maior, sleep de sincronização ou asserção removida/enfraquecida.

Censo: auth.users=0 antes/depois, 54 tabelas, zero papéis-sonda; só cinco
tabelas de configuração têm linhas (Auth migrations82, MIME4, limites17,
buckets2, Storage migrations73). Os 4.838 audit_log_entries e seis flow_state
foram exclusivamente sintéticos da validação após reset, removidos depois de
confirmar Auth vazio. Censos antes/depois preservados; dados de domínio,
operacionais e objetos Storage zerados. Toolchain local Node24.15/npm11.14;
CI conserva versões fixadas, sem atualização de dependência. Logs, comandos, linhas e
restaurações das contraprovas estão em
`~/colete-noite/faxina-b-contraprovas.md`.

Nenhuma PERGUNTA nova. As decisões A/B encerraram as duas dúvidas; a decisão C
manteve explicitamente as precedências indefinidas como pendência pós-piloto,
sem inferir contrato. Nenhuma dependência criada/atualizada, acesso Supabase
remoto, deploy ou serviço de produção. Contêineres alheios intactos.


### Correção dos três P3 da revisão do PR #57

A correção sobre `cd8debf` não altera comportamento. O cabeçalho da `0020`
explicita M2-D15 e a revalidação de autenticação antes do replay (M2-D21).
COMMENT ON FUNCTION de worker_acquire_external_effect agora descreve
FOR NO KEY UPDATE SKIP LOCKED. Comparação pelo catálogo com `cd8debf`, em
transação desfeita: nove corpos, ACLs, SECURITY DEFINER e search_path
idênticos; nenhum dos oito comentários cita o modo antigo.

Os testes contam somente requisições de navegação do frame principal, por
aba. Refresh inválido exige exatamente uma carga de `/entrar`; o logout em
duas abas exige exatamente uma em cada aba. Os casos sem sessão na tela de
login e sessão expirada com refresh válido exigem zero cargas adicionais.
A contagem permanece até networkidle, com a tela esperada visível. O teste
anterior de logout manual e heap continua intacto. A prova é uma janela de
observação até estabilização, sem afirmar ausência de eventos futuros.

Contraprova: mutante temporário marca sessionStorage no logout e executa
uma segunda carga real na inicialização do documento seguinte. Refresh
inválido reprova em `e2e/m2-ui-a.spec.ts:1409` com duas cargas; duas abas
reprova em `e2e/m1-b-privacy.spec.ts:1026` com duas cargas em cada aba.
Arquivo restaurado byte a byte, build normal refeito. Sem retry, aumento de
timeout, sleep de sincronização ou enfraquecimento de asserção.

Browsers completos 3× novamente: 240 aprovações, 18 skips preexistentes;
por série, 8 Auth + 4 privacidade + 62 grupos + 6 smoke. Grupos medidos em
172,993 /185,156 /174,677 s. Reset pelas vinte migrations, pgTAP 1.259
asserções em 19 arquivos e os dez harnesses passaram novamente.
O manifesto foi recalculado e permanece idêntico: nenhum arquivo normativo
mudou; este registro operacional não faz parte da baseline.

AGENTS §5 completo: todos os comandos exit 0, incluindo verify:app,
scan:docs, scan:secrets, test:audit, audit:high e diff --check. auth.users
zero antes e depois; censo final de 54 tabelas e zero papéis-sonda, com linhas
somente nas cinco tabelas de configuração já listadas. Removidos 4.882
logs de auditoria e seis fluxos Auth exclusivamente sintéticos desta rodada.
Tipos regenerados sem diff. Evidências e restauração em
`~/colete-noite/correcao57-contraprovas.md` e logs `correcao57-*`.

## Fatia CORS — autoria de 06/10/2026

Base `461fe29`, após o PR #58. Fatia autorizada pelo planejador em
06/10/2026, registrada em `13` §0, `14` §5.4 e `25` §8.1. Sem migration,
dependência nova, deploy ou retomada de staging: o WIP `cfbb479` continua
pausado até o merge independente desta fatia. Risco alto por transportar
login/sessão, dados pessoais e operações de capacidade/membership de grupos;
o PR de autoria permanece draft, sem merge,
para a cerimônia de revisão independente da D63.

### Por que o navegador local passava

O app local usa `http://127.0.0.1:4173` e a API usa a porta `54321`:
**são origens distintas**. A rota `functions-v1` do `kong.yml` gerado pela
CLI tem o plugin `cors`. Antes de implementar, uma requisição OPTIONS real
nesse caminho respondeu **200**, `Access-Control-Allow-Origin: *`, os
cabeçalhos solicitados e os métodos
`GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS,TRACE,CONNECT`. Portanto o proxy
local mascarava a ausência de CORS nos handlers.

A medição separada publicou em loopback o runtime
`public.ecr.aws/supabase/edge-runtime:v1.76.2`, com o dispatcher original da
CLI e as fontes reais, sem Kong no caminho de entrada. Antes da mudança,
OPTIONS respondeu **422 VALIDATION** e POST sem sessão **401
UNAUTHENTICATED**, ambos sem CORS. Erros anteriores de setup da medição
(entrypoint/mounts/cwd e 503 de boot) não foram contados como resultados do
handler. Não foi acessado runtime hospedado.

### O que foi entregue e provado

`browser-cors.ts` concentra a política de transporte em identity, groups e
data-exports. Lista explícita `APP_ALLOWED_ORIGINS`, validação inteira fechada,
HTTPS fora do local, loopback HTTP somente em modo local; sem wildcard,
reflexão livre ou Allow-Credentials. OPTIONS precede o handler e tem corpo
vazio. Toda resposta real de origem aprovada recebe CORS, inclusive erros;
status, envelope e headers existentes permanecem. Exceção inesperada recebe
INTERNAL sanitizado, sem mensagem do provedor. Nenhum grant, guarda de sessão,
contexto do ator, regra de idempotência ou autorização foi alterado. Worker
intocado: OPTIONS continua **405 METHOD_NOT_ALLOWED**, sem CORS.

Inventário do cliente instalado: `src/lib/api.ts` envia authorization,
apikey e content-type às Edge; x-client-info é o header do cliente Supabase.
REST/retries e tracing opcional da biblioteca não são utilizados nas chamadas
Edge deste app. O cliente lê Content-Type, já safelisted, e retry_after no
JSON; não há Expose-Headers extra. Métodos liberados: POST para identity/groups
e GET para data-exports. Max-Age inicial 600 segundos; Vary conserva valores
existentes e inclui Origin também nas respostas negadas.

| Prova | Resultado medido antes da suíte completa |
| --- | --- |
| unitários de parsing, preflight, preservação e erro inesperado | 37 casos novos; suíte completa com 234 unitários em 24 arquivos |
| preflight HTTP no runtime direto | 27 casos: três Functions × origem permitida/negada/ausente, subdomínio, porta, HTTP, sufixo malicioso, método/header inesperados |
| censo de preflight | idempotency_records, invite_rate_limits, external_effects, job_runs, profiles, groups, group_members e group_invites inalterados |
| respostas HTTP reais | 200/401/403/404/409/410/422/429/500/503, mais CODE_INVALID 400, com CORS exato para origem aprovada; origem negada/ausente sem CORS |
| configuração fora do modo local | ausente, vazia, wildcard, path e lista mista inválida: zero origens permitidas em OPTIONS e POST |
| stream real de export | 200 com bytes idênticos do ZIP sintético, private/no-store e Content-Disposition preservados; segundo download 410; objeto e registros removidos |
| worker | OPTIONS 405 e POST sem credencial 401, nenhum header CORS |
| E2E direto | app exportado em 4173 cria grupo por fetch nativo na porta direta de Edge; erros 401 de identity e data-exports são legíveis; ambos os viewports passaram |

O harness conta **56 checagens HTTP**, além das sondas do worker e dos
asserts de censo/limpeza. Configurações diferentes criam runtimes temporários
novos, removidos ao final, sem cache de isolate da configuração anterior.
As fixtures exigem `auth.users=0` antes e depois.

O E2E mantém Auth/Data API nos endereços locais reais. Um adaptador **somente
no teste** seleciona a porta publicada diretamente para `/functions/v1/*`,
removendo esse prefixo de roteamento; o fetch nativo, corpo, credencial,
preflight do navegador e handlers produtivos ficam intactos. Nenhuma chamada
Functions passa por Kong, reverse proxy, route fulfillment ou resposta fake.
Não foi adicionada configuração alternativa ao app.

### Contraprovas

Cada mutante executou `npm run db:test:cors` contra o runtime real e reprovou
por AssertionError, sem falha de setup. Fonte restaurada byte a byte entre
execuções: SHA-256
`8610d714edddaac2eecd61b8ad0c1ec414bb3088683b0da1882011865abf7ee1`.

| Mutante | Asserção que reprovou |
| --- | --- |
| refletir qualquer Origin | origem negada deve ter zero cabeçalhos CORS |
| Allow-Origin wildcard | origem permitida precisa do valor exato, sem wildcard |
| erro sem CORS | resposta real 401 também precisa de CORS |
| preflight depois da autenticação | mutante invoca o handler real como POST antes do preflight; 401 reprova a expectativa de 204 |

Substituições, tempos, hashes e logs em
`~/colete-noite/cors-contraprovas.md` e `cors-validacao/mutants.json`.
Sem retry novo, timeout ampliado, sleep de sincronização, skip novo ou asserção
enfraquecida. A primeira execução de unitários detectou defaults de fixtures
que escondiam undefined, corrigidos mantendo as expectativas negativas. O
harness corrigiu expectativas para worker 405, CODE_INVALID 400 e payload
patch de update_profile, conforme o contrato existente. O carregador do
Playwright exigiu process.cwd no helper compartilhado, sem import.meta;
nenhuma mudança de módulo ou dependência no app foi necessária. Um erro de
variável no launcher de logs interrompeu-o após db:stop, antes dos testes;
foi registrado e corrigido. Saída de credenciais sintéticas da CLI redigida
nos logs de inicialização.

### Validação completa e bloqueio de fechamento

A sequência obrigatória passou em db:reset (20 migrations), pgTAP (1.259
asserções em 19 arquivos), todos os harnesses de banco, verify:app (234
unitários), scan:docs, scan:secrets e test:audit (12 casos). Três séries de
Auth/privacidade/grupos/CORS/smoke somaram 246 testes aprovados e 18 skips
preexistentes, sem novo skip ou retry. Após ajustar o usuário do container
temporário para preservar permissões no Linux da CI, o HTTP direto passou
novamente com 56 checagens e dois ciclos adicionais de navegador somaram
quatro aprovações; o terceiro ciclo com esse helper já estava na série
completa. Os quatro mutantes foram repetidos e rejeitados, com restauração
integral da fonte. git diff --check passou.

Censo final: 54 tabelas, auth.users=0, nenhum papel-sonda residual, nenhum
registro de domínio/operação nem objeto Storage residual. As cinco tabelas
não vazias são seeds/histórico de migrations: auth.schema_migrations (82),
private.allowed_proof_mime_types (4), private.app_limits (17), storage.buckets
(2) e storage.migrations (73). A limpeza exclusiva de fixtures do provedor
removeu 4.814 audit_log_entries e seis flow_state sintéticos.

**Fechamento bloqueado:** audit:high saiu 1 por dois avisos novos não cobertos
pelas exceções vigentes: GHSA-wq5f-xc86-pv6w (sharp 0.35.4, high; correção
0.35.5) e GHSA-pqg4-j6r4-53mv (shell-quote 1.10.0, critical; correção 1.11.0).
Nenhuma dependência ou exceção foi alterada nesta fatia. AGENTS §8 exige decisão
humana para ampliar o escopo; o trabalho é preservado como WIP em draft e não
pode ser declarado validado integralmente. Staging permanece pausado. Evidências
locais em ~/colete-noite/cors-validacao e progresso-cors.md.

### Retomada após o PR #61 — 09/10/2026

Rebase sobre origin/main `909b44b`, preservando integralmente o comportamento
CORS. O único conflito foi no manifesto, resolvido recalculando checksums do
conteúdo combinado. O bloqueio de 06/10 está encerrado: as correções de
dependências vieram de main, sem alteração de dependência nesta fatia.
A correção do planejador de 09/10 confirma auditoria **exigida**: este PR
altera package.json somente em scripts e registra os harnesses no workflow
e em AGENTS §5. Dependências, overrides e versões são idênticos aos da base;
package-lock.json foi comparado com origin/main por cmp, exit 0.

Todos os comandos de AGENTS §5 passaram depois do rebase, incluindo
audit:high (exit 0; duas exceções vigentes), test:audit e diff --check.
Banco recriado por 20 migrations: 1.259 asserções pgTAP em 19 arquivos.
verify:app: 234 unitários em 24 arquivos. Browsers 1×: Auth 8 pass/2 skips
preexistentes, privacidade 4 pass/4 skips preexistentes, grupos 62 pass,
CORS 2 pass e smoke 6 pass; total 82 aprovações e seis skips existentes.
Nenhuma falha de navegador, novo skip, retry ou timeout ampliado.

CORS direto no runtime Edge, sem Kong: 56 verificações HTTP passaram.
Os quatro mutantes (reflexão livre, wildcard, erro sem CORS e autenticação
antes do preflight) reprovaram por AssertionError no HTTP real; fonte
restaurada byte a byte após cada execução. Auth zero nas fronteiras das
fixtures CORS. O censo final examinou 54 tabelas e confirmou auth.users=0,
zero papéis-sonda e nenhum registro de domínio/operação ou objeto Storage
residual. Somente as cinco tabelas de seeds/histórico acima ficaram não
vazias; limpeza do provedor removeu 1.774 audit_log_entries e dois flow_state
sintéticos desta rodada. Uma consulta avulsa durante harness ativo viu
fixtures temporárias e não foi usada como evidência de fronteira.

Logs medidos: ~/colete-noite/cors-validacao-2026-10-09; contraprovas e
progresso preservados em ~/colete-noite. PR continua draft para revisão
independente; nenhum merge, deploy, projeto remoto ou staging retomado.

### Correção da revisão independente do PR #59 — 09/10/2026

Correção separada do commit `3d7c9e9`, limitada a testes e documentos.
A produção CORS aprovada pelo revisor permanece byte a byte idêntica
(SHA-256 `8610d714edddaac2eecd61b8ad0c1ec414bb3088683b0da1882011865abf7ee1`).
A decisão do planejador de 09/10, registrada em `13` e `25` §8.1,
explicita trim por item e falha fechada da lista inteira para item vazio,
espaço interno ou item inválido. Os três casos têm prova unitária e HTTP.

Achado P2: unitário e db:test:cors agora reprovam as sete regressões
R01/R02/R05/R06/R14/R18/R25: comparação sem maiúsculas, ponto final, primeiro
Origin repetido/lista, null, handler executado com Authorization no
preflight, método post minúsculo e origem negada lendo um 200. Origin
repetido em duas linhas usa HTTP/1.1 cru por TCP, reaproveitando a sonda
do revisor; a comparação unitária também usa Headers.append.

Achados P3: os 48 preflights de censo levam Bearer válido e corpo; as 11
contagens (idempotência, limitador, efeitos, jobs, perfis, grupos, members,
invites, privacy_requests, auth.sessions e audit_log_entries) ficam iguais.
O E2E negativo serve o app numa origem não listada, exige TypeError no
fetch nativo, mostra a mensagem de rede real da página e prova zero grupos
criados. O mutante A-reflection reprova por asserção explícita na linha 129
nos dois projetos, com traces copiados antes da próxima suíte.

AGENTS §5 completo passou, incluindo audit:high e os 94 testes de auditoria.
Browser 1×: Auth 8 pass/2 skips existentes, privacidade 4 pass/4 skips
existentes, grupos 62 pass, CORS 4 pass e smoke 6 pass (84 aprovações,
seis skips preexistentes). pgTAP: 1.259 asserções em 19 arquivos. Unitário
CORS: 53 casos; suíte completa: 250 casos em 24 arquivos. HTTP direto:
89 verificações aprovadas, sem Kong. Não houve falha na suíte normal de
navegador; as falhas esperadas são somente as contraprovas.

Os 25 mutantes do revisor e quatro do autor reprovam nas suítes da CI,
sem depender da sonda externa. As sete regressões P2 reprovam nas duas
suítes. O spy de preflight é assíncrono para que R14 reprove pela asserção
de handler não chamado, e não por TypeError incidental de catch; o HTTP
reprova pelo censo alterado. R23 reprova porque a exceção escapa do teste
que exige 500 sanitizado. Após esse ajuste, as contraprovas foram repetidas
e verify:app, HTTP direto e auditoria passaram novamente. Nenhum retry,
timeout ampliado, sleep de sincronização, novo skip ou asserção enfraquecida.

Censo final sem testes concorrentes: 54 tabelas, auth.users=0, zero
papéis-sonda e resíduos de domínio/operação/Storage; somente as cinco
tabelas de seeds/histórico acima ficaram não vazias. Fixtures CORS
confirmam auth.users=0 antes e depois. O último censo removeu 94 registros
sintéticos de audit_log_entries e zero flow_state do controle final.

Evidências e tabela mutante → teste → linha: ~/colete-noite/corr59-contraprovas.md
e corr59/mutants/results.json; logs em corr59; progresso em
~/colete-noite/progresso-corr59.md. Commit de correção próprio; PR permanece
draft, sem merge, deploy, projeto remoto ou retomada de staging.


## Preparação de staging — diagnóstico local de 11/10/2026

A primeira validação de grupos registrou dois HTTP 500 na semeadura
identity/complete_profile (10/10, 00:07:41Z) e timeout de login no setup de
vinte membros (00:12:43Z). VERIFICADO: o runtime Edge registrou
WorkerAlreadyRetired: request cannot be handled because the worker has already
retired, junto a wall clock duration warning e early termination. Postgres
não registrou erro de complete_profile nessa janela; o 500 tinha o envelope
genérico do runtime, não o envelope INTERNAL do gateway. INFERÊNCIA: corrida
com aposentadoria do worker local per_worker, sem evidência de dado inválido
ou defeito SQL do app.

VERIFICADO: os sete logins concluídos responderam 200 em 79.75–102.70 ms no
GoTrue. O oitavo não teve resposta no trace nem conclusão registrada na janela
consultada; o cliente foi cancelado ao exceder o limite de 30000 ms. Não foi
observada recusa. INFERÊNCIA: bloqueio/atraso de transporte ou máquina local;
não há evidência para atribuir 30 segundos de processamento ao GoTrue ou falta
de RAM. Memória e docker stats foram medidos no diagnóstico e durante os testes,
não na falha histórica; inspect indicou OOMKilled=false nos três contêineres.

Decisão de execução autorizada por César: testes intactos, cada caso no projeto
que falhou passou cinco vezes isolado (10/10), depois grupos inteiro passou
62/62 em 320s, zero CSP/Function em todos os contextos. Nenhum 500 ou timeout
se repetiu. A configuração jitless é exclusiva do grafo frontend; semeadura
Node e Edge identity não importam src/lib/zod.ts. Nenhuma mudança de Edge,
migration, dependência, retry, timeout, asserção ou container feita no diagnóstico.

AGENTS §5 aprovado: db recriado pelas migrations, 1259 pgTAP/19 arquivos,
harnesses completos; 253 unitários/26 arquivos e checker 33/33; navegadores
Auth 8, privacy 4, grupos 62, CORS direto 4 e smoke 6 = 84 aprovados, zero
violação CSP no console/eventos e zero Function. Seis skips anteriores de
Auth/privacy, nenhum novo. Os grupos foram repetidos somente pelo diagnóstico
expressamente autorizado. Censo de 54 tabelas: auth.users=0 antes/depois,
zero papéis-sonda/resíduos; controle final removeu 5045 audit_log_entries
sintéticos e 2 flow_state. audit:high exit 0, sem novas exceções/dependências.

Evidência: ~/colete-noite/staging/diagnostico-semeadura.md, diagnostico/,
full/ e finish/. Dois commits finais separados para Zod jitless e preparação;
PR draft para revisão independente, sem merge ou acesso a hospedagem real.

## Correção da revisão do PR #63 — 12/10/2026

Checker sem OpenAPI; PostgREST conferido pelo César em Project Settings → General
→ Service versions → PostgREST version. Sondas usam nomes atuais das migrations:
quatro tabelas públicas e nove RPCs, incluindo get_own_data_exports, pois a 0013
moveu exports para private. Todas as 13 requisições REST locais devolveram
401/42501; PGRST205 continua reprovado. Testes staging finais: 98/98.
Dez sobreviventes da revisão e sete contraprovas adicionais reprovam (exit 1),
com baseline verde e sem mutação no worktree. Uma rodada com porta ocupada foi
desconsiderada; evidência final em ~/colete-noite/corr63-contraprovas.md.

AGENTS §5 completo: 1259 pgTAP/19 arquivos; todos os harnesses de banco;
253 unitários/26 arquivos. Navegadores uma vez cada: Auth 8, privacy 4, grupos 62,
CORS direto 4, smoke 6, total 84; seis skips preexistentes. Zero violações CSP
(console/eventos) e zero chamadas Function. Nenhum retry, timeout ampliado,
asserção de schema alterada ou novo skip. Censo de 54 tabelas: auth.users=0
antes/depois/final; zero papéis-sonda e resíduos de domínio/operação/Storage.
Limpeza dos controles sintéticos: 1780 audit_log_entries e 2 flow_state.
audit:high exit 0, sem alerta fora das duas exceções já existentes. Manifesto,
scans e diff aprovados; package.json só scripts e lockfile cmp idêntico a main.
Nenhuma migration, Edge Function, dependência ou comportamento do app mudou.
Decisões 10/10 e 12/10 em docs/16,25,27,28; Vercel Git main automático, preview
desligado, backend manual. Assets ausentes 404/no-store, CSP integral e URLs
exatas exigidas. Nenhum Supabase/Vercel real ou segredo real acessado.

## Racha completo — `0022_match_players.sql` (modo apresentação, 15/10/2026)

Autor Claude Code; revisão Codex (risco alto: vaga e dinheiro). Empilhada
sobre Rachas v1 (`06c6798`, já com a correção da revisão do #70: `matches`
em `private`, leitura só por `get_match`/`list_my_matches` via Edge).

### O que foi entregue

- `private.match_players`, sem RLS e sem grant (`14` §5.2, decisão de César
  de 15/10), com `private.match_queue_seq`; estados `starter`, `waitlist`,
  `left`, `removed`; `paid` com autor e horário da marcação.
- `join_match`, `leave_match`, `set_match_payment` no gateway `groups`, no
  padrão idempotente atual; leituras `get_match_roster` e
  `get_matches_occupancy` com actor context (sessão revogada recusada).
- Locks perfil → grupo → membership → racha → inscrição, FOR NO KEY UPDATE.
  Desistência de confirmado promove o primeiro da espera na mesma transação;
  pago não desiste (`PAYMENT_ALREADY_REAL`); após `starts_at`,
  `MATCH_STARTED`. Trigger em `group_members` libera a vaga de racha futuro
  quando a membership deixa de ser `active` (saída, remoção, exclusão).
- Descrição do racha (decisão humana de 16/10/2026):
  `private.matches.description`, texto até 500 pontos de código, regra única
  no formulário, na Edge e em `private.normalize_match_description`; décima
  chave do config de `create_match` (`""` vira `null`, só espaços é
  recusado); `get_match` a projeta, `list_my_matches` não. Campo com contador
  no modal; detalhe com texto puro. Vetores de config do pgTAP da `0021` e
  dos harnesses ganharam `description`.
- Telas: placar com ocupação real, "Vou jogar"/"Desistir" com confirmação,
  duas FlatList (confirmados e espera) com nome, apelido e posição,
  pagamentos e resumo para a organização, ocupação na lista de rachas.

### Provas e números medidos (pilha local, trava da sessão)

Medidos em 15/10/2026 sobre `origin/main` `daad76a`, com a descrição.

| Comando | Resultado |
|---|---|
| db:test | 21 arquivos, 1455 asserções, PASS (0022: 123) |
| db:test:matches | 14 provas ok, inclusive a descrição normalizada na linha, fora do livro e projetada por `get_match` |
| db:test:match-players | 15 provas ok |
| demais harnesses de §5 | exit 0, inclusive deletion e export |
| test:auth:web | 10 passed, 2 skipped |
| test:privacy:web | 5 passed, 5 skipped |
| test:cors:web | 4 passed |
| test:groups:web | 64 passed (ver nota) |
| test:matches:web | 10 passed (6 de Rachas v1, 4 de Racha completo) |
| test:smoke:web | 6 passed |
| verify:app | exit 0; vitest 36 arquivos, 385 testes |
| test:staging / test:audit | 102/102 / 94/94 |
| audit:high | exit 0, duas exceções ativas |

Nota: na primeira rodada da suíte, `test:groups:web` teve 62 passed e 2
failed: `deadlock detected` no `cleanActors` de fixture do UI-B (`m2-ui-b`
1421), que deixou 5 usuários sintéticos e por isso reprovou também a
pré-condição `auth.users = 0` do `test:matches:web`. Depois de `db:reset` e
novo `build:web:auth-e2e`, a reexecução deu 64 passed e 10 passed, com
`auth.users = 0` no fim. Nenhum dos arquivos tocados pela descrição participa
dessa limpeza.

### Contraprovas executadas

- Sem os locks de grupo e racha, com pausa entre contar e gravar, dois "Vou
  jogar" na última vaga confirmam os dois; com os locks e a mesma pausa, um
  confirma e o outro vai à espera. Restaurado byte a byte.
- Sem o trigger, a saída do grupo deixa um confirmado sem membership
  (pgTAP). Um grant direto faz a sonda de `service_role` ler a tabela
  (pgTAP).
- Conta excluída: ocupa a vaga, sem ID, nome, apelido ou posição na
  projeção; o pseudônimo `Deleted …` não aparece.
- Descrição: com `private.normalize_match_description` trocada por uma que
  devolve o texto cru, o pgTAP da `0022` reprova 14 asserções (normalização,
  recusas e `create_match` com só espaços ou 501 pontos). Restaurado por
  `db:reset`. Os casos de recusa do `create_match` são lidos contra o par
  válido do mesmo config, que chega a `NOT_FOUND`.

### Correções da revisão do PR #71 (16/10/2026)

- **P1-1, replay com autoridade perdida.** `join_match`, `leave_match` e
  `set_match_payment` seguem a M2-D20: autenticação negada sai com o erro
  normal, inclusive no replay; perda de autoridade no grupo (rebaixamento,
  saída, remoção) devolve o desfecho gravado sem `current`, sem repetir a
  mutação.
- **P1-2, existência do racha.** `lock_match_context` confere conta, sessão e
  aceite sob o lock do perfil antes de procurar o racha;
  `private.match_actor_authority` responde NOT_FOUND para racha inexistente,
  grupo arquivado e membership não active. Fora do grupo, ID existente e
  inexistente dão o mesmo 404; sessão revogada dá 401 nos dois.
- **P2.** Cancelar a desistência devolve o foco a "Desistir".

| Comando | Resultado |
|---|---|
| db:test | 21 arquivos, 1461 asserções, PASS |
| db:test:match-players | 16 provas ok, resíduo 0 |
| demais harnesses de §5 | exit 0 |
| test:auth:web | 9 passed, 1 failed, 2 skipped na suíte (foco do Perfil, `m1-a-auth.spec.ts:450`, intermitente também na base); repetições: igual, depois 10 passed |
| test:privacy / cors / groups / matches / smoke web | 5+5 skip / 4 / 64 / 10 / 6 |
| verify:app | exit 0; vitest 36 arquivos, 385 testes |
| test:staging / test:audit / audit:high | 102 / 94 / exit 0 |

Contraprovas, cada teste novo contra o código anterior: com a 0022 de
`fdc1490`, o harness cai em "pending join_match existing" (403 NOT_MEMBER) e
o pgTAP em 2 asserções; com o replay devolvendo `current` antes da
autoridade, o harness cai em "no current after the demotion"; com o
NOT_FOUND antes da sessão, cai em "revoked join_match unknown" (404) e o
pgTAP na asserção 73; sem o retorno de foco, o e2e cai em `toBeFocused`.

## Rachas: usabilidade — `0023_geocode_gate.sql` (modo apresentação, 17/10/2026)

Autor Claude Code. Empilhada sobre o Racha completo (`fdc1490`, PR #71).
Toca login/sessão (portão da busca) e dado pessoal (posição do aparelho):
risco alto pela D63, revisão independente.

### O que foi entregue

- Detalhe do grupo com "Próximos rachas" (cards do grupo, por data) e
  "Criar racha" só para dono e organizador; o modal abre com o grupo fixo,
  sem seletor. A aba Rachas virou "Agenda", com o nome do grupo em cada card.
- Busca de endereço: `search_address` no gateway `groups` consulta o
  Nominatim (Brasil, pt-BR, até 5 resultados, `User-Agent` do Colete, cache
  de 10 min em memória, atribuição "© OpenStreetMap"). Antes de cada busca,
  inclusive de cache, `public.geocode_gate` (`0023`) confere a sessão
  (revogada recusa), exige dono ou organizador ativo de grupo não arquivado e
  toma o relógio de `private.geocode_throttle`, de uma linha só: no máximo
  uma saída por segundo para o app inteiro, entre todas as instâncias da
  Edge. Ocupado, a Edge espera uma vez 1,1 s e depois responde
  `RATE_LIMITED`. Nenhum texto buscado é gravado ou logado; a CSP do app não
  mudou.
- Criação sem GPS; escolha de resultado guarda latitude/longitude com 4 casas
  e digitar por cima descarta. Detalhe com "Ver distância" (haversine no
  aparelho), só com coordenadas; permissão negada tem texto próprio.
- Máscaras sem dependência (data, horário, valor em centavos); regra de
  horário por campo, com fim no dia seguinte até 6 h; foco no primeiro campo
  inválido; "Criando…" desabilitado; erro do servidor no campo ou no aviso do
  topo, com foco. Placar do detalhe só com a ocupação e a data em texto no
  topo. Card com bloco de data estilo ingresso e barra de ocupação.

### Provas e números medidos (pilha local, trava da sessão)

| Comando | Resultado |
|---|---|
| db:test | 22 arquivos, 1486 asserções, PASS (0023: 31) |
| db:test:matches | 15 provas ok; `search_address` revogada 401, jogador 403 `NOT_ORGANIZER`, consulta curta e chave extra 422, relógio intocado |
| demais harnesses de §5 | exit 0 |
| test:auth:web | 10 passed, 2 skipped (ver nota) |
| test:privacy:web / test:cors:web | 5 passed, 5 skipped / 4 passed |
| test:groups:web | 64 passed |
| test:matches:web | 18 passed (6 Rachas v1, 4 Racha completo, 8 usabilidade) |
| test:smoke:web | 6 passed |
| verify:app | exit 0; vitest 41 arquivos, 465 testes |
| test:staging / test:audit | 102/102 / 94/94 |
| audit:high | exit 0, duas exceções ativas |

Nota: `m1-a-auth` "creates a real account…" falha às vezes em
`toBeFocused` no rádio de posição do perfil. Na suíte, falhou 1 vez; em
3 reexecuções nesta branch, 1 verde e 2 falhas; no controle com o
`fdc1490` (sem esta fatia), 1 falha em 3. É uma instabilidade anterior,
num arquivo que esta fatia não toca.

### Contraprovas executadas

- `geocode_gate` sem a checagem de autoridade: o pgTAP da `0023` reprova
  3 asserções (jogador, grupo arquivado, organizador pendente). Sem a
  condição de um segundo, reprova também "outra pessoa no mesmo segundo
  espera" e "900 ms depois ainda é o mesmo segundo". Restaurado por
  `db:reset`.
- Sem o foco no primeiro campo inválido, o e2e de foco reprova em
  `toBeFocused` na data; restaurado byte a byte (`cmp`), passa.
- Edge (vitest): sessão revogada e jogador param antes de qualquer `fetch`;
  falha do Nominatim responde lista vazia `unavailable` e não entra no cache;
  recusa nunca ecoa o texto buscado.

### Correções da revisão do PR #72 (16/10/2026)

- **P1, espaçamento da saída ao Nominatim.** `geocode_gate` reserva horários a
  1250 ms (`max(último + 1250 ms, agora)`, até 3 s à frente; além disso,
  null e RATE_LIMITED) e devolve os milissegundos até o horário. A Edge mede
  t0 e t1 em volta da RPC no próprio relógio monotônico e só chama dentro de
  `[t1 + w, t0 + w − 1 + 250 ms]`, sem `await` entre a última checagem e o
  fetch; resposta lenta ou despertar tardio abandona o horário e reserva
  outro (até três). Cada chamada fica em [horário, horário + 250 ms], logo
  duas distam no mínimo 1 s, em qualquer instância, sem depender de relógio
  sincronizado entre banco e Edge.
- **P2.** Corpo que falha no meio da leitura vira "indisponível" e não entra
  no cache. O card quebra a linha (`flexWrap`, base de 176 px no conteúdo):
  em largura útil pequena o bloco de data fica em cima.
- **P3.** docs/27 registra a decisão de manter 12 h no servidor.

| Comando | Resultado |
|---|---|
| db:test | 22 arquivos, 1497 asserções, PASS |
| db:test:geocode (novo) | 4 provas e censo; 3 rodadas estáveis: sonda da revisão (resposta do portão 1350 ms atrasada) com saídas a ~1250 ms; 6 instâncias, menor intervalo ~1146 ms; mutante a 1000 ms com 200 ms de atraso: ~800 ms |
| db:test:match-players / matches | 16 / 14 provas ok |
| demais harnesses de §5 | exit 0 |
| test:matches:web | 18 passed |
| test:groups / privacy / cors / smoke web | 64 / 5+5 skip / 4 / 6 |
| test:auth:web | 9 passed, 1 failed (foco do Perfil, `:450`, intermitente na base), 2 skipped; repetição 10 passed |
| verify:app | exit 0; vitest 41 arquivos, 469 testes |
| test:staging / test:audit / audit:high | 102 / 94 / exit 0 |

Contraprovas: a sonda da revisão contra a 0023 e o `geocode.ts` anteriores
mediu 248 ms entre saídas; o mutante só da leitura do corpo derruba o teste
novo de corpo interrompido; sem `flexWrap`, o e2e a 200% mede 12 px no
horário. O Nominatim nunca foi chamado.

## PR B — QR do convite acadêmico (decisão humana de 15/10/2026)

Convites mostra QR do `share_url` emitido pela Edge, com módulos pretos sobre branco,
quatro módulos de margem e escala inteira, junto do código/link existentes. A
matriz permanece no componente de vida curta; regenerar substitui e revogar remove.
“Ler QR do convite”, em `/join`, valida origem exata, `/join`, ausência de query e
credenciais, e `#token=` com os 88 símbolos base64url do formato atual. Outro
conteúdo mostra **Este QR não é um convite do Colete**, sem abrir/exibir/logar ou
transmitir o conteúdo. Token válido entra em memória no preview/confirmar já
existentes; a câmera não resgata automaticamente. Negação/indisponibilidade oferece
“Digitar código” com foco no campo.

**Decisão humana de César, 15/10/2026, AGENTS §8:** plano da Fase 0 aprovado;
`qrcode-generator@2.0.4` (MIT) e `jsqr@1.4.0` (Apache-2.0) aprovados com versões
exatas, sem ^/~; expo-camera já autorizado e fixado em `57.0.6` (SDK 57).
Ambas as bibliotecas QR têm zero dependências próprias; audit isolado zero
vulnerabilidades e proposta completa zero advisories novos. `audit:high` mantém
somente as duas exceções humanas existentes. Geração/leitura são locais depois
do carregamento; preview/resgate permanecem online.

Web: `getUserMedia` sem áudio, vídeo muted/playsInline, canvas limitado a 480 px
no maior lado, intervalo mínimo de 125 ms (até 8 decodificações/s, menos o tempo
de processamento) e import dinâmico de jsqr. Não usa Expo scanner, WASM, CDN,
worker externo ou geração de código por Function. Nativo: CameraView traseira, apenas QR, autofocus,
permissão de câmera sem microfone. Build nativo exige `EXPO_PUBLIC_INVITE_ORIGIN`
igual à origem pública exata da Edge, sem path/query/fragmento (`.env.example`).
Web usa a origem da página. Testes cobrem o window sem location do React Native;
a rota também evita o listener/fragmento do browser nesse caso.

### Provas medidas e incidentes preservados

`test:qr:web`: **30/30**, 15 Chromium em 320 px e 15 WebKit iPhone, **47,89 s**.
Pixels reais de canvas entram no decoder produtivo; API/transporte de câmera simulados, com
Auth/Edge/Postgres locais reais. PNG do QR exibido foi decodificado independentemente
do gerador e comparado com o link exato; regeneração e revogação passaram.
Preview uma vez, zero resgate antes da confirmação, resultado pending depois.

Duas tracks por stream, incluindo clone, ficam ended após leitura, cancelar,
digitar, navegar, documento oculto, pagehide, erro de vídeo, track encerrada
e permissão resolvida depois de cancelar. Reabrir cria novas tracks; contador de
frames não avança depois de parar. Frames positivos comprovam até cinco leituras
em 500 ms e lado máximo 480 px. Decoder: zero requests antes da abertura e uma
do chunk ao abrir; nenhuma tentativa de WASM/CDN. Censo cobre token/código em URL,
referrer, histórico, título, console, Cache API e storages; token em body somente
nas rotas contratadas. Sentinela em localStorage reprova o censo. QR externo não
abre página nem aparece em tela/request/log. Axe, foco e reflow passaram.

Contraprova sem track.stop no caminho normal: **6/9** unitários da câmera falharam
(exit 1); arquivo restaurado em finally. Unitários finais: **32 arquivos/368 testes**,
incluindo gerador/decoder independentes, parser, origem nativa, posse do stream,
cancelamento antes do import e erro sanitizado.

Primeira rodada WebKit, local e CI, falhou antes do login. Diagnóstico com página
vazia mostrou JS/fontes/sw promovidos a HTTPS por upgrade-insecure-requests do
servidor de staging HTTP loopback, com erro TLS. Trocar click por tap não resolveu.
Corrigiu-se somente o harness QR: servidor estático HTTP dedicado (serve já existente),
sem depender dos headers, conforme condição humana 5. CSP e Permissions-Policy de
produção ficaram byte a byte intactas; test:staging e instrumentação de Function
no cspGuard permanecem. Produção exige HTTPS; a automação não prova policy física.

A primeira execução integral local parou em m1-a-auth.spec.ts:450: ArrowRight
selecionou Atacante, mas não conservou foco. Nenhum arquivo de Perfil nem asserção
foi alterado. A retomada repetiu Auth inteiro sem flags especiais e passou 10 + 2
skips; ambas as CI anteriores também passaram Auth. O incidente permanece registrado
como intermitente, sem alegar correção. Banco e QR já verdes não foram repetidos
na retomada; as demais verificações terminaram sob nova aquisição atômica da trava.

### Bundle web (gzip nível 9 por arquivo, mtime=0)

`build:web` sem configuração Auth, mesma toolchain; baseline 998c5f3. Somente JS,
sem as fontes/imagens estáticas existentes. E2E comprovou carregamento sob demanda.

| Artefato | Antes bytes | Depois bytes | Antes gzip | Depois gzip |
| --- | ---: | ---: | ---: | ---: |
| Entrada inicial | 2.281.462 | 2.311.886 | 547.850 | 558.840 |
| Decoder lazy | 0 | 130.264 | 0 | 46.322 |
| Total JS | 2.281.462 | 2.442.150 | 547.850 | 605.162 |

Aumento inicial **30.424 / 10.990 gzip**; total **160.688 / 57.312 gzip**.
Exportações JavaScript/Hermes iOS e Android finais passaram; não comprovam sensor
nem build instalável de loja.

### Validação local concluída sobre a mesma fatia

| Verificação | Resultado |
| --- | --- |
| db:start / db:reset | PASS, somente migrations 0001–0020 |
| db:test | PASS, 19 arquivos / 1.259 asserções |
| db:test:idempotency | PASS |
| db:test:gateway | PASS |
| db:test:cors | PASS |
| db:test:worker | PASS |
| db:test:deletion | PASS |
| db:test:export | PASS |
| db:test:invites | PASS |
| db:test:groups | PASS |
| db:test:membership | PASS |
| db:test:rename | PASS |
| db:test:members | PASS |
| build:web:auth-e2e | PASS |
| test:auth:web | PASS, 10 + 2 skips após retomada sem mudança |
| test:privacy:web | PASS, 4 + 4 skips |
| test:cors:web | PASS, 4 |
| test:groups:web | PASS, 62 |
| test:qr:web | PASS, 30 |
| build:web:smoke / test:smoke:web | PASS, 6 |
| verify:app / equivalente final | verify:app anterior PASS; final com todos os passos individuais e formatter limitado PASS, 368 unitários; aviso herdado View não usado em PrivacyAccountScreen |
| scan:docs / scan:secrets | PASS |
| test:audit | PASS, 94 |
| test:staging | PASS, 98 |
| audit:high | PASS, mesmas duas exceções existentes |
| git diff --check | PASS |
| Censo local | users/profiles/groups/members/invites/idempotency/rate limits = 0; schemas fixture/probe = 0 |
| db:stop / trava | exit 0; somente nossa pilha encerrada e nossa trava removida |

Depois do registro operacional, a revisão automática rejeitou format:check global
por interpretar que invoca Prettier em docs/AGENTS, proibido pelo usuário. A checagem
final foi limitada explicitamente aos arquivos de código/configuração; docs e AGENTS
não foram formatados. Os comandos verify:app anteriormente executados foram read-only
quanto ao formato, com docs já excluídos pelo .prettierignore; nenhum formatter alterou
arquivos desses caminhos.

### Arquivos e evidência

UI/fluxo, em src/features/groups: GroupInvitesScreen.tsx, JoinGroupScreen.tsx,
InviteQrCode.tsx, InviteQrScanner.tsx, InviteQrScanner.web.tsx, invite-camera.web.ts,
invite-qr.ts, invite-scanner-types.ts, join-fragment.ts; app/join.tsx e
src/lib/i18n/pt.ts. Testes: invite-qr.test.ts e invite-camera.test.ts na mesma pasta,
e2e/invite-qr.spec.ts e playwright.qr.config.ts. Configuração/registro: .env.example,
app.json, package.json, package-lock.json, .github/workflows/validation.yml,
AGENTS.md (uma linha da validação QR, sem prettier), este documento e 12 PNGs em
docs/evidence/qr-convite. Não houve migration, mudança normativa, header, aba ou FlatList.

Capturas escuras sintéticas por Chromium/WebKit: Convites, câmera aberta,
confirmação, permissão negada, câmera ausente e erro do decoder. Inspeção visual
incluiu QR/código/link, câmera e fallback; legibilidade foi provada pelos pixels.
Exemplos: [Convites](evidence/qr-convite/qr-chromium-convites.png),
[câmera](evidence/qr-convite/qr-webkit-camera.png),
[fallback](evidence/qr-convite/qr-webkit-fallback-denied.png),
[confirmação](evidence/qr-convite/qr-webkit-confirmacao.png).

### Gates

PR #69 permanece draft, sem merge/ready/main até liberação humana. Autor Codex;
revisão independente pelo Claude Code realizada em 804ffb3; conferência da correção
pendente (risco alto
por transporte do convite e entrada em grupo, AGENTS §4.12). Nenhum Supabase remoto,
staging ou Vercel real foi acessado por esta sessão. Pilha só sob criação exclusiva
atômica de pilha.lock com identificação; encerramento/remoção em finally a cada rodada.

camera=(self) pertence ao PR Rachas. César fará validação física após os dois merges:
PWA instalado no Chrome Android e Safari iPhone, HTTPS, permissões, foco/background,
leitura/regeneração/revogação, orientação, teclado/fallback. Sensor nativo também
pendente, com origem pública e permissão do plugin no build. WebKit/canvas e exportação
nativa não substituem aparelhos. Headers, abas/FlatList e banco permanecem fora desta fatia.

A segunda CI mostrou uma diferença adicional de mídia: WebKit Linux criava as tracks
mas não reproduzia de forma confiável o MediaStream de canvas; os frames ficavam
a zero e o app encerrava com câmera indisponível. O harness passou a simular também
srcObject/play/metadados do vídeo e encaminhar drawImage ao canvas de origem. Pixels,
getImageData, decoder, parser, Auth/Edge e tracks/readyState permanecem reais; nenhum
token/resultado de decoder é mockado. Isso evita depender do backend de vídeo do
runner. [Playwright documenta diferenças de mídia entre plataformas](https://github.com/microsoft/playwright/blob/main/docs/src/browsers.md).

Rodada final depois da correção do transporte e da limpeza da entrada manual: **39/39
comandos exit 0**, incluindo banco, QR, Auth/privacidade/CORS/grupos/smoke, cada passo
do app (formatter explicitamente limitado), scanners, audit/staging e censo.
`test:qr:web` 30/30 em 47,89 s. QR válido zera o campo manual/erro anterior; o novo
e2e começa por código inválido e prova essa troca. Prova QR foi antecipada na CI
logo após reset/build Auth, conservando todos os cinco jobs e demais verificações.
No run 38636420854 a prova QR Linux passou. O run 38637589283 de 804ffb3
concluiu os cinco jobs com sucesso antes da revisão independente.


### Correção da revisão #69 — permissão, ciclo de vida, foco e origem

A revisão independente de Claude Code em 804ffb3 encontrou P1-1: blur causado pelo
prompt de permissão encerrava o leitor antes de a pessoa permitir. O teste antigo
"stops on blur" afirmava o comportamento defeituoso. Foi substituído pela prova de
que blur é ignorado durante a permissão e depois de concedida. Web encerra por
visibilitychange somente quando hidden e por pagehide, além de leitura, cancelar,
digitar, navegação/desmontagem e erros. Nativo cancela no AppState background;
inactive, usado pelo alerta iOS de permissão, não cancela.

Ao abrir no web, useLayoutEffect foca Cancelar leitura. Erros de negação, câmera
indisponível, decoder e QR alheio focam a região da mensagem com tabIndex=-1.
Digitar código limpa o alerta e volta ao campo. A suíte afirma o foco por elemento,
sem aceitar BODY. Origem nativa ausente ou inválida é recusada antes de montar o
leitor, com "A leitura de QR não está configurada neste aplicativo. Digite o código
do convite para continuar." A origem configurada deve ser HTTPS exata, sem barra,
path, query, fragmento ou credenciais; web continua usando a origem da página.
Validação em runtime, sem novo app.config ou dependência. Sensor/alerta iOS real
continuam no gate físico; unitários não são prova de hardware.

Prova local da correção sob trava exclusiva atômica: db:start e db:reset exit 0;
**30/30 e2e QR**, 15 Chromium e 15 WebKit, **46,06 s** do harness (45,7 s do runner).
Inclui getUserMedia pendente, blur, concessão, leitor ainda aberto, frames reais,
novo blur após ready com tracks live e leitura do QR, encerrando todas as tracks.
Os oito cenários de término por evento/ação preservados e os fallbacks passaram.
**378 unitários / 32 arquivos PASS**, lint e tipos exit 0; somente o aviso herdado
de View não usado em PrivacyAccountScreen. Formato foi checado apenas no código;
scan:docs, scan:secrets e diff --check passaram. Censo numérico de users, profiles,
groups, members, invites, idempotency, rate limits e schemas fixture/probe: zero.
db:stop exit 0 e a própria trava removida no finally; sem acesso à pilha de outra sessão.

Contraprovas executáveis, sem enfraquecer asserções:

- Repor somente invite-camera.web.ts de 804ffb3: o e2e novo falha nos **dois**
  navegadores após blur + concessão, porque invite-camera não existe (linha 569).
  Build antigo exit 0, teste exit 1, **2 falhas** em 14,69 s.
- Restaurar a correção no finally, rebuild e repetir o mesmo e2e: **2/2 PASS**,
  exit 0 em 6,38 s; depois unitários, lint e tipos novamente verdes.
- Unitário com a câmera antiga: **1 falha / 8 PASS**, onInactive foi chamado no blur.
- Unitários com join-fragment antigo: **10 falhas / 22 PASS**, origens nativas
  malformadas/não HTTPS deixavam de ser recusadas. Arquivos restaurados em finally.

Logs completos e resultados preservados em ~/colete-noite/qr69-correcao e progresso
em ~/colete-noite/progresso-qr-convite.md. O bundle web padrão da correção mede:
entrada **2.312.250 bytes / 558.896 gzip**, decoder lazy **130.264 / 46.322**, total
**2.442.514 / 605.218** (mesmo método anterior). Contra 804ffb3: +364 bytes / +56 gzip
na entrada; contra baseline 998c5f3: +30.788 / +11.046 na entrada e +161.052 / +57.368
total. Nenhum chunk adicional nem nova dependência.

Sem rebase: base continua 998c5f3, conforme pedido humano até #70 entrar e nova
liberação. PR continua draft, sem merge/ready. Headers de produção no harness e
ordem dos passos da CI ficam explicitamente para depois; não foram alterados.
Expo-camera já estava autorizado expressamente nas mensagens humanas da tarefa,
além da aprovação posterior das duas bibliotecas QR. Próxima etapa: cinco jobs
do SHA corrigido e conferência independente; validação física permanece com César.


### Rebase do #69 após o merge do #70

Novo pedido humano liberou git fetch e rebase de feat/qr-convite sobre origin/main,
que estava em **daad76a**, merge do #70 (06c6798). Rebase concluído; somente workflow
e AGENTS.md conflitaram. No job Database security ficou um único bloco antecipado
de instalação Chromium+WebKit/build Auth/QR, mais db:test:matches após members e
matches:web após groups:web; os dois passos tardios duplicados foram removidos.
AGENTS §5 conserva matches:web e qr:web. Nenhum Prettier em docs/AGENTS.

Package/lock e tela mesclaram automaticamente, mas o lock foi regenerado por npm
install a partir do lock de main, sem upgrade. A primeira resolução deduplicava
read-pkg para type-fest 5.10.0; uma restrição temporária, removida antes da instalação
final, preservou **read-pkg → type-fest 5.9.0**, deixando 5.10.0 só na nova cadeia de
expo-camera. Nenhum override temporário entrou no commit. Comparação por caminho e
versão: **zero nós existentes de main alterados/removidos**. npm ci reproduziu a
instalação; npm ls --all encontrou **956 pares pacote/versão distintos**, zero
versões fora dos dois locks originais. Diretas resolvidas: expo-location **57.0.21**
(declaração ~57.0.21 herdada do #70), expo-camera **57.0.6**, qrcode-generator
**2.0.4**, jsqr **1.4.0**; as três do QR seguem sem ^/~. A nova cadeia transitiva
mantém exatamente as versões do #69 antes do rebase. As duas atualizações Expo
presentes em main foram herdadas, sem outra atualização nesta sessão.

A rota app/(tabs)/grupos/[groupId]/convites.tsx continua renderizando
GroupInvitesScreen, que mantém InviteQrCode junto de código/link e o Voltar ao grupo
do #70. O e2e de geração/regeneração/revogação passou nessa rota; a navegação pelas
abas também passou. A correção P1 de blur, o AppState nativo, parser de origem, foco
e e2e de permissão ficaram byte a byte iguais a 33d98d4.

Provas locais depois do rebase, sob a mesma pilha com trava exclusiva atômica:

| Verificação | Resultado medido |
| --- | --- |
| db:start / db:reset | PASS, migrations até 0021 |
| build:web:auth-e2e | PASS |
| QR Chromium/WebKit | **30/30 PASS**, 48,95 s do harness |
| QR Chromium com headers de produção locais | **15/15 PASS**, 21,91 s |
| API real getUserMedia, dispositivo Chromium simulado | PASS: camera=(self), allows=true, uma track live e depois ended |
| matches:web | **6/6 PASS**, 10,96 s |
| groups:web | **64/64 PASS**, 173,57 s |
| db:test:invites | PASS com limites intactos, 18,19 s incluindo limpeza |
| Vitest | **400/400 PASS**, 36 arquivos |
| Lint / tipos / formato limitado ao código | PASS; só o aviso View não usado em PrivacyAccountScreen herdado |
| test:staging | **102/102 PASS**, aceita camera=(self) e rejeita a negação antiga |
| test:audit / audit:high | **94 PASS** / exit 0 com as mesmas duas exceções |
| scan:docs / scan:secrets / diff --check | PASS |
| Censo local final | users/profiles/groups/members/invites/idempotency/rate limits e schemas fixture/probe: zero |
| db:stop e trava | exit 0; própria trava removida em finally |

A prova de headers usou config temporária ignorada em .expo, reutilizando o mesmo
suite QR e serve:web, sem alterar CSP, policy ou configuração permanente. A sonda
separada chamou getUserMedia real com fake device do Chromium e parou todas as
tracks antes de fechar o browser. Não é câmera física nem acesso ao staging real.
Reprodução/evidências preservadas em ~/colete-noite/qr69-rebase; os headers são
exatamente os gerados localmente pelo código de produção de main.

A falha da CI de 33d98d4 permanece registrada: db:test:invites concluiu as asserções
mas a limpeza de group_members excedeu statement_timeout de 15 s e sofreu rollback;
a pilha descartável foi encerrada. Não houve alteração do harness, timeout ou
asserções para obter este PASS local, nem diagnóstico conclusivo daquela demora.
O rebase e nova validação foram explicitamente autorizados pelo pedido humano.
Próximo gate: cinco jobs no SHA publicado após rebase e conferência independente.
PR permanece draft, sem merge/ready; nenhum Supabase remoto ou Vercel real acessado.


### Rebase do #69 após os PRs #71 e #72

Pedido humano: git fetch e rebase de feat/qr-convite sobre origin/main com racha
completo e usabilidade. Base buscada **de267cd**, merge do #72 sobre o #71.
Conflitos apenas em workflow, AGENTS.md e neste registro operacional. Nenhum em
Convites/Join: as telas, câmera, parser e e2e QR ficaram byte a byte iguais a
f0845e5. A rota (tabs)/grupos/[groupId]/convites continua com QR, código/link e
Voltar ao grupo; o teste de geração/regeneração/revogação passou nessa rota.

Workflow conserva instalação Chromium+WebKit/build Auth/QR antecipados, todos os
harnesses matches, match-players e geocode de main, e os testes web dos três cortes
de Rachas. Só os passos tardios duplicados de Chromium/build Auth saíram. AGENTS §5
mantém todos os comandos e a descrição atualizada de matches:web, além de qr:web.
Este documento reúne integralmente os registros de #71, #72 e QR, nessa ordem;
nenhum documento normativo ou migration foi modificado por esta resolução.

Npm install regenerou o lock a partir da mesclagem, sem upgrade nem restrição nova.
Npm ci reproduziu a instalação. Comparação de versões por caminho: **zero nós
existentes de main e zero nós do QR anterior alterados/removidos**. Npm ls --all
antes/depois e após ci: **956 pares pacote/versão distintos**, zero versões fora
dos locks originais. Diretas resolvidas permanecem expo-location **57.0.21**,
expo-camera **57.0.6**, qrcode-generator **2.0.4**, jsqr **1.4.0**. Read-pkg continua
com type-fest **5.9.0**; a cadeia da câmera mantém **5.10.0**. Declarações diretas e
overrides preservados, nenhuma dependência atualizada nesta rodada.

| Prova local após o rebase | Resultado medido |
| --- | --- |
| db:start / db:reset / build:web:auth-e2e | PASS, migrations até 0023 |
| QR Chromium/WebKit | **30/30 PASS**, 49,85 s |
| QR Chromium sob headers de produção locais | **15/15 PASS**, 22,61 s |
| API real getUserMedia, dispositivo Chromium simulado | PASS, camera=(self), allows=true, uma track live e depois ended |
| matches:web, incluindo racha completo e usabilidade | **18/18 PASS**, 41,03 s |
| groups:web | **64/64 PASS**, 166,44 s |
| Vitest | **510/510 PASS**, 43 arquivos |
| Lint / tipos / formato limitado a código/configuração | PASS; mesmo aviso herdado View em PrivacyAccountScreen |
| test:staging | **102/102 PASS**, camera=(self) aceito e negação antiga recusada |
| test:audit / audit:high | **94 PASS** / exit 0 com as mesmas duas exceções |
| scan:docs / scan:secrets / diff --check | PASS |
| Censo de nove conjuntos e schemas fixture/probe | Zero |
| db:stop | exit 0, própria trava removida no finally |

Pilha usada exclusivamente sob pilha.lock criada atomicamente com a identificação
codex-rebase69-pos72-01a13bcf. Censo cobre auth.users, profiles, groups,
group_members, group_invites, idempotency_records, invite_rate_limits, matches e
match_players. Nenhuma posição/busca enviada a serviço real: search_address é
simulado nos e2e; nenhum Nominatim, Supabase ou Vercel real acessado.

A prova sob headers reutilizou serve:web e a mesma suíte QR por configuração
local ignorada em .expo. API real testada com fake device; não é câmera física.
CSP e Permissions-Policy permanecem as de main, sem alteração no PR. Logs,
comparações npm ls, configuração e scripts de reprodução estão preservados em
~/colete-noite/qr69-rebase72; progresso em ~/colete-noite/progresso-qr-convite.md.
Capturas e medições de bundle das etapas anteriores continuam identificadas como
tais. Próximo gate: cinco jobs do SHA publicado após este rebase e conferência
independente. PR continua draft, sem merge/ready; físico segue com César.

## PR F — Ajustes do teste do César (17/10/2026)

- **Busca de endereço.** `0024_geocode_reserve.sql` troca `geocode_gate` por
  `geocode_reserve`: horários a 2000 ms (horizonte de 6 s), e a resposta traz
  `wait_ms` e `spacing_ms`. A Edge chama dentro de
  `[t1 + w, t0 + w − 1 + T]`, com `T = spacing − 1000 ms = 1000 ms`: cada
  chamada fica em [horário, horário + T], e duas distam no mínimo
  2000 − 1000 = 1000 ms, aceitando ida e volta da RPC de até 999 ms. Com a
  0023 (T = 250 ms), uma ida e volta de 300 ms já esvaziava a janela nas três
  tentativas e a busca terminava em RATE_LIMITED ("Muitas buscas agora"). O
  aviso "indisponível" vem só do caminho do Nominatim (rede, timeout,
  resposta não 2xx ou corpo inválido); a Edge agora registra um código fixo
  da causa (`GEOCODE_UPSTREAM_HTTP_<status>`, `_TIMEOUT`, `_NETWORK`,
  `_BODY`, `GEOCODE_SLOT_BUSY`, `GEOCODE_SLOT_LATE`), sem texto buscado nem
  URL, e o timeout passou de 5 s para 8 s.
- **Primeiro acesso** com nome, apelido, posição, perna e camisa, nos
  componentes e regras da edição (`ProfileFields`), num único
  `complete_profile`.
- **Dicas removidas** dos campos que não evitavam erro; ficam o formato do
  código do convite, a máscara do preço, o fim no dia seguinte e a força da
  senha.
- **Topo das telas** sem o rótulo acima do título; "Sair da conta" no fim do
  Perfil, destrutivo, com confirmação e foco devolvido ao cancelar.
- **Pedir para entrar** leva a Grupos (`dismissTo`, sem voltar ao
  formulário) com "Pedido enviado" e o grupo como "Aguardando aprovação".

| Comando | Resultado |
|---|---|
| db:test | 23 arquivos, 1494 asserções, PASS |
| db:test:geocode | 5 provas e censo; 3 rodadas: RPC a 300–800 ms em toda chamada, 4/4 buscas, menor intervalo ~1618 ms; sonda da revisão ~2000 ms; 6 instâncias, menor ~1897 ms; mutante (horários de fato a 1250 ms) ~350 ms |
| demais harnesses de §5 | exit 0 |
| test:groups:web | 68 passed (64 + 4 do spec novo) |
| test:matches / qr / privacy / cors / smoke web | 18 / 30 / 5+5 skip / 4 / 6 |
| test:auth:web | 9 passed, 1 failed (foco do Perfil, `:450`, intermitente na base), 2 skipped; repetição 10 passed |
| verify:app | exit 0; vitest 46 arquivos, 520 testes |
| test:staging / test:audit / audit:high | 102 / 94 / exit 0 |

Contraprova: o teste unitário da RPC lenta (300–800 ms) dá 429 RATE_LIMITED
no código anterior; o mutante de espaçamento do harness quebra o intervalo.
O Nominatim nunca foi chamado.

## PR D — Página do convite (18/10/2026)

- **`0026_invite_page.sql`.** `create or replace` só de
  `private.preview_group_invite`; `preview_group_by_code`,
  `preview_group_by_invite`, grants, `security definer` com `search_path`
  vazio, ordem de locks e o limitador da `0017` ficam iguais. A prévia
  devolve exatamente `group_name`, `member_count`, `owner_name`,
  `viewer_status`, `group_id` (só para membro ativo) e `refusal`
  (`GROUP_FULL`/`GROUP_LIMIT`). Código inexistente, malformado, divergente,
  revogado, expirado ou esgotado: o mesmo `CODE_INVALID` (400). O resgate
  segue a M2-D42.
- **Edge `groups`.** `invitePageProjection` deixa sair só os seis campos;
  resposta fora do formato vira erro interno, sem marcar a tentativa como
  sucesso.
- **App.** Código digitado, QR e `/join` levam à mesma página (ícone, nome,
  membros ativos, dono e "Pedir para entrar"); membro vê "Abrir grupo",
  pendente vê "Aguardando aprovação", grupo cheio ou cota vê a mensagem
  atual. "Entrar em grupo", no topo, volta ao formulário e tira o convite da
  memória. A câmera simulada da suíte de QR foi para
  `e2e/support/qr-camera.ts` e serve às duas suítes.

| Comando | Resultado |
|---|---|
| db:test | 24 arquivos, 1547 asserções, PASS (`0026`: 53) |
| db:test:invites | 63 provas, exit 0 (prévia HTTP com os seis campos; revogado → `CODE_INVALID`) |
| demais harnesses de §5 | exit 0 |
| test:groups:web | 75 passed, 5 skipped (spec novo: 5 testes no projeto mobile; o layout largo da página fica provado pelo m2-ui-a) |
| test:qr:web / privacy / smoke | 30 / 5 + 5 skip / 6 |
| test:auth:web | 9 passed, 1 failed, 2 skipped, em 3 rodadas: foco do Perfil (`:450`); com o app de `origin/main` o mesmo teste falhou 2 de 3 |
| verify:app | exit 0; vitest 48 arquivos, 587 testes |
| scan:docs / scan:secrets / test:audit / audit:high | exit 0 / 419 arquivos / 94 / exit 0 |

Contraprova do pgTAP da `0026`, com mutantes do corpo privado: sem a
checagem de revogação, 4 asserções reprovam; sem a de expiração, 4; sem a
de esgotamento, 1; `group_id` para todos, 3; contagem com pendentes, 1;
campo `owner_id` a mais, 3; grupo cheio como erro, o arquivo aborta em
`GROUP_FULL`. Resíduo depois da suíte: zero linhas em `auth.users`,
perfis, grupos, membros, convites, limitador e idempotência.

CI: o primeiro run (39105818163) teve os 80 testes de grupos verdes, mas o
job Database security passou do `timeout-minutes: 25` (25 min 47 s) e foi
cancelado no passo seguinte. Na base o mesmo job levou 18 min 5 s no #75 e
24 min 19 s no #74; o passo de grupos sozinho variou de 363 s a 602 s entre
runners. O spec novo custava 51 s nos dois projetos e passou a rodar só no
mobile. A folga do job é pequena para qualquer e2e novo.

**Correção do P1 da revisão.** Com o grupo travado por outra transação, a
prévia de convite revogado, expirado ou esgotado respondia em ~1,23 s, e a de
código inexistente em 30–47 ms: o tempo revelava o convite. A `0026` (ainda
não aplicada em ambiente nenhum) passou a ter o corpo `STABLE` e sem trava
nenhuma. O ator é conferido antes do lookup, o `CODE_INVALID` sai só pela
linha do convite, e grupo e membership são lidos sem trava, apenas para
convite vivo. O resgate segue com as travas da M2-D13.

| Prova | Resultado |
|---|---|
| db:test:invites, prévia com grupo, convite e memberships em `FOR UPDATE` | código e link × inexistente, revogado, expirado, esgotado e vivo: nunca em espera de Lock, todos terminam com a trava presa (0,5–2,4 ms) |
| mesmo harness com o corpo de `c118363` | exit 1: "preview code revogado under held group: waited on the holder's lock" |
| mutantes no harness | trava no corpo `STABLE` recusada pelo PostgreSQL; em `VOLATILE` com a trava do grupo, o detector vê a espera nos três terminais e não no inexistente |
| sonda do revisor, sem alteração | para em "must observe PostgreSQL lock barrier": não há mais barreira |
| sonda do revisor, só medindo | com a trava presa: existente 18,9 / 25,6 / 49,1 ms; inexistente 26,6 / 49,7 / 49,3 ms; todos 400 `CODE_INVALID`; limitador 20 → 429 |
| db:test | 24 arquivos, 1549 asserções (`0026`: 55) |
| demais itens de §5 | exit 0; test:groups:web 75 + 5 skip, qr 30, vitest 587; test:auth:web segue com a falha `:450` da base |

## Editar e cancelar racha — `0028_edit_cancel_match.sql` (18/10/2026)

- **`0028`.** `private.matches` ganha `canceled_at` e `canceled_by` (o par
  anda junto). `update_match` e `cancel_match` no padrão idempotente atual,
  com a lista de operações completa (inclusive `set_group_appearance`) e o
  validador encadeado; trava `lock_match_context`, a mesma de `join_match`.
  `join_match`, `leave_match` e `set_match_payment` recusam
  `MATCH_CANCELED`; a saída do grupo não promove a espera de racha
  cancelado. `get_match`, `list_my_matches`, `get_matches_occupancy` e
  `get_match_roster` devolvem `canceled`.
- **Edge `groups`.** Rotas `update_match` e `cancel_match`; `MATCH_CANCELED`,
  `MATCH_DONE` e `SLOTS_BELOW_CONFIRMED` (409). `SLOTS_BELOW_CONFIRMED` entrou
  no catálogo de `13` §8.
- **App.** "Editar" no canto do detalhe abre o formulário de criar preenchido
  (rota modal `editar-racha`); "Cancelar racha" no fim, com confirmação na
  tela; chip "Cancelado" no placar e nos cards; presença e marcação de pago
  fecham no cancelado.

| Comando | Resultado |
|---|---|
| db:test | 26 arquivos, 1702 asserções, PASS (`0028`: 103) |
| db:test:match-players | 20 provas, exit 0; novas: chamada forçada pela Edge (jogador 403, ex-organizador e estranho 404 iguais ao ID inexistente), vagas e promoção, preço com pago, cancelado fechando presença/espera/pagamento, editar × confirmar com barreira de lock nas duas ordens, mutante sem travas |
| demais harnesses de §5 | exit 0 |
| test:matches:web | 24 passed (spec novo `editar-racha`: 2 testes × 2 projetos) |
| test:groups:web / qr / smoke / cors | 77 + 5 skip / 30 / 6 / exit 0 |
| test:auth:web / test:privacy:web | auth em 3 rodadas: 10 passed; 9 + 1 failed; 9 + 1 failed, sempre o foco do Perfil (`:450`), que esta fatia não toca e que falha também com o app de `origin/main` (PR D); 2 skipped. privacy: 5 + 5 skip |
| verify:app | exit 0; vitest 49 arquivos, 644 testes |
| scan:docs / scan:secrets / test:audit / test:staging / audit:high | exit 0 |

Contraprovas do pgTAP da `0028`, com mutantes aplicados nas funções vivas e
restaurados byte a byte: sem `MATCH_CANCELED` em `join_match`, 2 asserções
reprovam; em `leave_match`, 3; em `set_match_payment`, 1; sem
`SLOTS_BELOW_CONFIRMED`, 1; sem a promoção, 2; sem `MATCH_DONE` na edição, 1;
no cancelamento, 1; sem a autoridade, 4 em cada RPC (e o arquivo aborta);
trigger promovendo espera de cancelado, 2; regra temporal sem a exceção dos
horários mantidos e `acquire_group_idempotency` sem `set_group_appearance`,
o arquivo aborta. No harness, sem as travas de grupo e racha e sem a defesa
final, uma edição para 1 vaga e um "Vou jogar" no meio deixam 2 confirmados
em 1 vaga; com as travas e a mesma pausa, 1 confirmado e o outro na espera.

**Correção do P1 da revisão.** Depois do cancelamento, o replay com a mesma
chave de `join_match` (confirmado e espera), `leave_match` e
`set_match_payment` feitos antes ainda devolvia HTTP 200 com o desfecho e a
projeção. A `0028` (ainda não aplicada em ambiente nenhum) passou a conferir
o cancelamento depois da autoridade e antes do replay: a mesma chave recebe a
recusa de uma chamada nova, 409 `MATCH_CANCELED`, sem desfecho, `current` ou
resumo, e o registro idempotente concluído fica como está. Quem perdeu a
autoridade continua na M2-D20 (o desfecho, sem projeção), como no #71.

| Prova | Resultado |
|---|---|
| pgTAP da `0028`, chamar → cancelar → repetir as quatro chaves | com o código de `ae3556f`: 4 asserções reprovam (os quatro replays); corrigido: 115 asserções, PASS |
| sonda do revisor (`rev79/probe.mjs`) | antes: 4 replays com 200; depois: 409 `MATCH_CANCELED` nos quatro, `DEFECTS []`, os oito pares de concorrência passam |
| db:test | 26 arquivos, 1714 asserções, PASS |
| demais itens de §5 | exit 0; matches:web 24, groups:web 77 + 5 skip, qr 30, smoke 6, vitest 644, privacy 5 + 5 skip; test:auth:web 9 + 1 / 10 / 9 + 1, só o `:450` da base |

## Apagar grupo — `0029_delete_group.sql` (19/10/2026)

- **`0029`.** `private.group_deletions` (`group_id`, `deleted_by`,
  `deleted_at`), privada, sem RLS nem privilégio; `delete_group` no padrão
  idempotente atual, com a lista de operações completa (inclusive
  `set_group_appearance`, `update_match` e `cancel_match`) e o validador
  encadeado. Trava perfil → grupo → membership própria e, sob o grupo,
  pendentes, rachas e convites em ordem crescente. Numa transação: rachas não
  terminados nem cancelados passam a cancelados, convites revogados,
  pendentes `removed` sem incremento (M2-D9), `archived_at` e a linha de
  encerramento no mesmo instante. `group_actor_authority` e
  `match_actor_authority` recusam `GROUP_DELETED` antes de tudo, fora das
  listas da M2-D20; `create_match` e o resgate de convite ganham a mesma
  checagem no replay; `get_group_members` responde `NOT_MEMBER`. A prévia não
  muda (STABLE, `CODE_INVALID` pelo convite revogado).
- **Edge `groups`.** Rota `delete_group`; `GROUP_DELETED` sai como o
  `NOT_FOUND` (404) de um grupo inexistente, com corpo idêntico.
- **App.** "Apagar grupo" no fim de Configurações, só para o dono, com a
  confirmação na tela e o nome digitado liberando o botão; Grupos mostra
  "Grupo apagado.". Detalhe, membros, configurações, ícone e convites, quando
  a leitura não acha o grupo, voltam para Grupos com "Grupo não encontrado.";
  três asserções da UI-B passaram a esperar esse retorno (organizador
  expulso, CP3 de pendente/removido/estranho, grupo arquivado pela exclusão).

| Comando | Resultado |
|---|---|
| db:test | 27 arquivos, 1882 asserções, PASS (`0029`: 168) |
| db:test:group-deletion | 9 linhas `ok`, exit 0: chamada forçada pela Edge (organizador e jogador 403 `OWNER_ONLY`, ex-membro e estranho 403 `NOT_MEMBER`), replay e chamadas novas iguais às de grupo inexistente, apagar × entrar, × criar racha e × confirmar com barreira de lock nas duas ordens, sem `40P01`, e o mutante sem a trava do grupo |
| db:test:membership | 75 `ok`; o censo de texto canônico passa a esperar a `0029` em cinco funções da `0016` |
| demais harnesses de §5 e geocode, cors | exit 0 (invites 68, groups 29, rename 11, members 6, matches 15, match-players 21, export 32, deletion 10) |
| test:groups:web | 81 passed + 5 skipped (spec novo `apagar-grupo`: 2 testes × 2 projetos) |
| test:matches:web / qr / cors / smoke / privacy | 24 / 30 / 4 / 6 / 5 + 5 skip |
| test:auth:web | sempre o foco do Perfil (`:450`), que esta fatia não toca: 7 rodadas com o app da PR, 9 passed + 1 failed em todas; 5 rodadas com o app de `b6657ea` (base, sem esta fatia), 3 com a mesma falha e 2 com 10 passed |
| verify:app | exit 0; vitest 50 arquivos, 654 testes; 1 aviso de lint da base (`PrivacyAccountScreen`) |
| scan:docs / scan:secrets / test:audit / test:staging / audit:high / diff --check | exit 0 |

Contraprovas, com mutantes aplicados nas funções vivas e restaurados byte a
byte. No pgTAP da `0029`: helper de autoridade sem a checagem, 26 asserções
reprovam; helper do racha, 11; replay de `create_match`, 1; replay do resgate,
1; leitura de membros, 1; encerramento sem revogar convites, 5; cancelando
todo racha, 1; sem `archived_at`, 10; sem encerrar pendentes, 1; organizador
apagando, 8; replay de `delete_group` como chamada nova, o arquivo aborta. Na
Edge, sem o mapeamento de `GROUP_DELETED`, 3 testes reprovam; no app, o
campo liberando qualquer nome reprova o teste do helper, e o retorno para
Grupos desligado reprova o e2e novo. No harness, sem a trava do grupo e com
uma pausa depois de cancelar os rachas, um "Criar racha" no meio deixa um
racha vivo no grupo apagado; com a trava e a mesma pausa, a criação espera e
é recusada.

**Correção do P1 da revisão do #80.** Com a linha do grupo apagado travada
por outra transação, `get_group_members` e `get_invite_share_link` esperavam
a trava (cerca de 680 ms na sonda do revisor) enquanto um ID inexistente
respondia na hora: o tempo revelava que o grupo existiu. O mesmo valia para
as escritas que travam o grupo antes da autoridade. A `0029` (ainda não
aplicada em ambiente nenhum) passou a decidir o grupo apagado antes de
travar qualquer linha dele, pelo mesmo caminho de um ID inexistente: as
travas de grupo e memberships levam `not private.is_group_deleted`, avaliado
antes de esperar; o compartilhamento e a revogação ou regeneração recusam na
busca sem trava do convite, como o convite inexistente, com `NOT_FOUND`; o
racha de grupo apagado segue o caminho do racha inexistente em
`lock_match_context`; a leitura de membros recusa `NOT_MEMBER` antes da trava
do grupo para quem não é membro ativo, o que vale também para o estranho em
grupo vivo. Ficam redefinidas, com o predicado, as sete RPCs de membros da
`0016`, `rename_group`, `set_group_appearance`, `get_invite_share_link`,
`mutate_group_invite` e `lock_match_context`. O encerramento é definitivo, então
a decisão sem trava não muda depois.

| Prova | Resultado |
|---|---|
| `db:test:group-deletion`, prova nova | conexão segurando `FOR UPDATE` o grupo apagado, memberships, convites e rachas, tomada e solta a cada operação: 23 operações (4 leituras e 19 escritas) × membro antigo e estranho, contra o ID apagado e um ID inexistente, 46 chamadas respondem com a trava presa, mesmo status e erro, a mais lenta em 34 ms; estranho lendo membros de grupo vivo travado responde `NOT_MEMBER` sem esperar |
| contraprova com a `0029` de `3054d03` | o mesmo harness reprova: 42 das 46 chamadas ao grupo apagado esperam a trava (todas, menos `get_match` e `get_match_roster`, que não travam o grupo) |
| sonda do revisor (`rev80-evidencias/probe.mjs`) | exit 0; `DELETED_READ_NO_WAIT` passa nas quatro leituras antes reprovadas: apagado 19–22 ms contra inexistente 15–16 ms, `blocked: false`; replays (22) e indistinguibilidade seguem passando |
| pgTAP da `0029` | 170 asserções, PASS; revogar, regenerar, emitir e compartilhar convite de grupo apagado passam a `NOT_FOUND`, igual ao ID inexistente |
| db:test | 27 arquivos, 1884 asserções, PASS |
| demais itens de §5 | exit 0; membership com o censo da `0029` em doze funções da `0016`; members com o mutante de autoridade derrubando as duas checagens; groups:web 81 + 5 skip, matches:web 24, qr 30, cors 4, smoke 6, privacy 5 + 5 skip, auth 10 + 2 skip, vitest 654 |

O canal do estranho em grupo vivo nas escritas e no compartilhamento já
existia antes do #80 e não fica igual: lá a resposta já difere do ID
inexistente pelo corpo (`NOT_MEMBER` contra `NOT_FOUND`), não só pelo tempo.
O resgate por código ou link de grupo apagado continua respondendo
`INVITE_REVOKED`, diferente do código inexistente, pela precedência da
M2-D42.

**Correção do P1 residual da conferência de `4c930a2`.** Os replays de
`create_group`, `join_by_code` e `join_by_invite` ainda travavam o grupo
apagado antes do `NOT_FOUND` (cerca de 690 ms na sonda do revisor), e o
resgate novo de convite do grupo apagado também travava antes do
`INVITE_REVOKED`. A `0029` passou a conferir o grupo sem travar nesses
caminhos: o replay de `create_group` só trava grupo vivo; o do resgate não
trava o grupo apagado e recusa depois da autenticação; o resgate novo de
convite de grupo apagado recusa na busca do convite, sem trava, como o código
inexistente, mantendo a precedência da M2-D42 (`INVITE_REVOKED`; material
divergente, `CODE_INVALID`). `create_group` passa a ser redefinida pela `0029`.

Varredura feita pelo catálogo vivo (`pg_get_functiondef` de todas as funções
de `public` e `private` com cláusula de trava) e pelos caminhos de replay.
Operações que tocam grupo apagado ou algo dele, todas conferidas, com a
recusa antes de qualquer trava das linhas do grupo:

| Família | Operações (chamada nova e replay) |
|---|---|
| leitura | `get_group_members`, `get_invite_share_link`, `get_match`, `get_match_roster`, `list_my_matches`, `get_matches_occupancy`, `get_my_pending_group_requests`, `preview_group_by_code`, `preview_group_by_invite`; lista, detalhe, memberships e convites por RLS (sem trava) |
| membros e pedidos | `approve_member`, `remove_member`, `set_role`, `set_monthly`, `set_ratings_visibility`, `transfer_ownership`, `leave_group` |
| grupo | `create_group` (replay), `rename_group`, `set_group_appearance`, `delete_group` |
| convites | `issue_group_invite`, `revoke_group_invite`, `regenerate_group_invite`, `join_by_code`, `join_by_invite` |
| rachas | `create_match`, `update_match`, `cancel_match`, `join_match`, `leave_match`, `set_match_payment` (as cinco últimas por `lock_match_context`) |

Fora da recusa, por desenho: `delete_account` trava as memberships do próprio
titular, inclusive em grupo apagado, porque a saga precisa encerrá-las; não
responde "não encontrado". Exportação, worker e expurgos de retenção leem
sem trava ou com `SKIP LOCKED`. Fotos de grupo ficam para outro PR.

| Prova | Resultado |
|---|---|
| `db:test:group-deletion`, prova nova de replays | 24 replays concluídos antes do encerramento, um por operação de grupo e de racha, cada um pelo próprio titular, repetidos com o grupo apagado, memberships, convites e rachas presos `FOR UPDATE`: recusa `NOT_FOUND` sem desfecho (o encerramento devolve o próprio), com a trava presa; resgate e prévia por código e link do grupo apagado, por membro antigo e estranho, contra código inexistente, e a lista de pedidos encerrados: 41 chamadas, a mais lenta em 53 ms |
| contraprova com a `0029` de `4c930a2` | o harness reprova: esperam a trava os replays de `create_group`, `join_by_code` e `join_by_invite` e os quatro resgates novos (membro antigo e estranho × código e link) |
| sondas do revisor | `replay-only.mjs`, `extra.mjs` e `probe.mjs`, exit 0; os seis replays isolados terminam com a trava presa, 23–27 ms |
| db:test | 27 arquivos, 1884 asserções, PASS |
| demais itens de §5 | exit 0; groups:web 81 + 5 skip, matches:web 24, qr 30, cors 4, smoke 6, privacy 5 + 5 skip, auth 10 + 2 skip, vitest 654 |

**Correção da regressão concorrente da conferência de `4d58e22`.** No replay
de `join_by_code` e `join_by_invite`, o estado do grupo lido antes da trava
era reaproveitado depois dela sem revalidar: se a exclusão commitasse enquanto
o replay esperava, a resposta era 200 com o desfecho guardado. A `0029` volta
a conferir `private.is_group_deleted` depois das travas, além da checagem sem
trava que recusa o grupo já apagado na hora.

Conferidas as operações que decidem algo antes da trava: só o replay do
resgate (`private.join_group_invite`, comum a `join_by_code` e
`join_by_invite`) usava o estado anterior sem revalidar. As demais já
revalidam depois das travas: o resgate novo pelo convite revogado
(`require_live_group_invite`); `mutate_group_invite`, `get_invite_share_link`,
`lock_match_context` e as travas com predicado (sete RPCs de membros,
`rename_group`, `set_group_appearance`, `create_match`, `create_group`,
`delete_group`) pelo helper de autoridade, que lê o encerramento de novo;
`get_group_members` pela releitura sob a trava; o replay de `create_match`
pela checagem depois das travas.

| Prova | Resultado |
|---|---|
| `db:test:group-deletion`, prova nova de exclusão durante a espera | 44 corridas, cada uma num grupo vivo: a conexão A executa `delete_group` sem commit; 23 chamadas novas por quem tem acesso e 21 replays concluídos com o grupo vivo são observados esperando uma trava de A; depois do commit, todos respondem como grupo inexistente (o resgate novo, `INVITE_REVOKED` da M2-D42), sem desfecho |
| contraprova com a `0029` de `4d58e22` | o harness reprova: só os replays de `join_by_code` e `join_by_invite` respondem 200 com o desfecho; as outras 42 corridas recusam |
| provas anteriores | grupo já apagado continua respondendo sem esperar: 46 chamadas novas e 41 replays, resgates, prévias e lista |
| sondas do revisor | `supplement.mjs` e `race-confirm.mjs` (de `4d58e22`), `replay-only.mjs`, `extra.mjs` e `probe.mjs`: exit 0, sem falhas |

## Fotos de perfil e do grupo — `0030_photos.sql` (19/10/2026)

Item 6 do feedback do teste, decisão humana de César (`25` §8.1, contrato em `13` §5.0.9).
Empilhado sobre o #80 (`4c930a2`, que traz a `0028` e a `0029`).

- **`0030`.** Buckets `avatars` (novo) e `group-photos` privados, só `image/jpeg`, até
  1 MB, sem policy de cliente. `private.photo_uploads` (pending → retired → deleted),
  privada, sem RLS nem privilégio, guarda todo objeto que não é a foto corrente; o caminho
  (`<profile_id>|<group_id>/<upload_id>.jpg`) nasce no banco. Cinco operações no padrão
  idempotente atual (`begin_photo_upload`, `set_profile_photo`, `remove_profile_photo`,
  `set_group_photo`, `remove_group_photo`), com a lista de operações completa, o validador
  encadeado e `photo_upload` no vocabulário de recursos; `get_photo_upload_target` e
  `get_visible_photos` (com `p_self`) para a Edge. Foto trocada, removida ou sessão vencida
  vira `delete_storage_object` de `resource_type='photo_upload'`, executado pelo handler
  genérico do worker; `deletion_has_pending_storage`, o mapeamento de falha, o alvo e o
  confirmador da `0015` ganham o tipo, sem segunda lista. Job `reclaim_photo_uploads` a cada
  5 min. A exportação leva a foto como `profile-photo.jpg`. As operações de grupo decidem o
  grupo apagado antes de esperar trava, como a correção do P1 do #80.
- **Edge `groups`.** `photo-gateway.ts`: a URL de upload assinada só sai se morrer 60 s antes
  do recolhimento; antes da troca, a Edge lê o objeto e recusa o que não for JPEG completo de
  até 512 px, ou trouxer APP1 (Exif/XMP), APP13 (IPTC) ou MPF, apagando-o. Leitura por URL
  assinada de 5 min; a própria foto vem por `self`, sem o próprio ID na requisição.
- **App.** No Perfil, o avatar grande abre "Trocar foto" e "Remover foto"; na tela "Ícone do
  grupo", só o dono tem "Foto do grupo". A foto entra na lista, no detalhe, nos membros, na
  Agenda, no racha e no avatar do topo; o convite continua com ícone e cor. O app reduz a
  512 px e recodifica em JPEG (`expo-image-manipulator`); a escolha usa `expo-image-picker`.
  `img-src` do CSP passa a incluir a origem do Supabase (`docs/14`).

| Comando | Resultado |
|---|---|
| db:test | 28 arquivos, 1976 asserções, PASS |
| db:test:photos (novo) | 20 linhas `ok`, exit 0: caminho imposto, PNG e 1 MB + 1 recusados pelo Storage, JPEG com GPS no Exif recusado e apagado pela Edge, quem vê (colega sim, estranho não, nenhum JWT nem URL pública lê o objeto), troca e remoção apagando pelo worker real, sessão abandonada recolhida, foto do grupo só do dono, grupo apagado, exportação byte a byte, exclusão de conta sem objeto órfão (o Auth espera a sessão aberta), censo de todas as tabelas no baseline |
| db:test:groups / membership | 29 / 75 `ok`; o texto canônico passa a aprovar a `0030` em cinco funções da `0015` e seis da `0016` |
| demais harnesses de §5 | exit 0 (idempotency 7, gateway 9, cors 6, worker 8, deletion 10, export 32, invites 68, rename 11, group-deletion 11, members 6, matches 15, match-players 21, geocode 7) |
| test:groups:web | 85 passed + 5 skipped (spec novo `fotos`: 2 testes × 2 projetos) |
| test:auth / privacy / matches / smoke | 10 + 2 skip / 5 + 5 skip / 24 / 6 |
| verify:app | exit 0; vitest 55 arquivos, 692 testes; 1 aviso de lint da base (`PrivacyAccountScreen`) |
| scan:docs / scan:secrets / test:audit / test:staging / audit:high / diff --check | exit 0 (test:staging 102) |

Contraprovas: no harness, `get_visible_photos` sem a regra de grupo em comum entrega a URL
ao estranho, e `remove_group_photo` sem o predicado de grupo apagado espera a trava até o
timeout de 5 s; os dois restaurados. No vitest, o inspetor sem a recusa de APP1 reprova três
testes. O e2e confere no objeto guardado que a foto escolhida com GPS chega com 512 × 384 e
sem Exif. Capturas a 390 px em `~/colete-noite/fotos-prints`.

Fica para a revisão: a foto de um grupo apagado fica inacessível, mas o objeto só sai quando
o dono exclui a conta (o grupo apagado está arquivado e entra no fence da `0015`).

**Correção do P1 da revisão do #81.** A URL de upload assinada original, ainda válida,
recriava a foto depois de confirmada e trocada, removida, apagada pelo worker e até depois
da exclusão de conta, sem linha que a recolhesse. Abordagem escolhida: recusar no banco. O
trigger `objects_require_pending_photo_upload` (`before insert or update of name,
bucket_id` em `storage.objects`, função `security definer` de `postgres`) recusa com
`PHOTO_UPLOAD_NOT_PENDING` todo objeto de `avatars` ou `group-photos` cujo caminho não seja
de uma sessão `pending` antes de `reclaim_after`. O Storage testa essa inserção antes de
gravar os bytes (`canUpload`), então nada chega ao disco; vale para a URL assinada e para
qualquer papel. As fixtures de foto dos harnesses de grupos e de exclusão passaram a abrir
uma sessão antes de gravar, como a Edge. Preferi isto a manter as linhas aposentadas até a
URL vencer e varrer de novo: aqui nenhum objeto existe nem por um instante, e a segurança
não depende da validade do token.

| Prova | Resultado |
|---|---|
| `db:test:photos`, prova nova | pedir URL → confirmar → trocar, → remover, e a foto do grupo removida: o PUT na URL original responde erro `PHOTO_UPLOAD_NOT_PENDING`, nenhum objeto no caminho |
| `db:test:photos`, exclusão de conta | depois da saga concluída, as URLs da primeira foto, da corrente e da sessão aberta não regravam; nenhum objeto sob o perfil; censo de todas as tabelas, Storage inclusive, no baseline |
| contraprova com a `0030` de `13ecc09` | o mesmo harness reprova em "after the swap: the original URL recreated the object"; sem a prova da troca, reprova em "after the account deletion, first photo" |
| pgTAP da `0030` | trigger presente e `security definer`; sem sessão, sessão de outro bucket e sessão vencida recusam; sessão aberta aceita; mover para bucket de foto recusa; outros buckets intactos |

## Notas dos jogadores — `0031_ratings.sql` (19/10/2026)

M6 do piloto, antes do sorteio (D63-A). Decisão humana de César (`25` §8.1), contrato da nota
simples em `13` §4.1.2 e os sete pontos decididos em `27` ("Notas dos jogadores"). Sobre
`origin/main` em `3d17aed`; o #82 (sorteio) passa a usar a `0032`.

- **`0031`.** `private.ratings` (nota atual por grupo e membro) e `private.rating_history`
  (de quanto para quanto, quem e quando), privadas, sem RLS nem privilégio; FK composta da nota
  atual para a versão do mesmo membro e grupo, trigger que exige estrelas, autor e instante
  iguais aos da versão, e o histórico append-only. `set_rating` no padrão idempotente atual,
  com a lista de operações completa (as 33 anteriores, inclusive as da `0027` à `0030`, mais
  `set_rating`) e o validador encadeado; outcome sem estrelas. Travas: perfis do ator e do
  alvo, grupo e memberships em UUID crescente, nota atual; o grupo apagado é decidido antes
  de travar qualquer linha dele, e autoridade, grupo e alvo são relidos depois, também no
  replay. Leituras `get_group_ratings` (no caminho de `get_group_members`) e `get_my_rating`
  (sem trava, só a linha do próprio ator). Job diário `purge_ratings` (slot e cron das 03:53
  UTC dos expurgos de grupo), no worker.
- **Edge `groups`.** Rota `set_rating` (`stars` inteiro; fora de 1–5, `STARS_RANGE` 422, que
  já estava no catálogo de `13` §8) e o módulo de leituras `rating-reads.ts`. Worker:
  `purge_ratings` na lista de jobs.
- **App.** "Minha nota" no detalhe do grupo para todos; "Avaliar jogadores" (tela 21, rota
  `/grupos/[groupId]/notas`) para dono e organizador, com quem está sem nota no topo, o aviso
  de visibilidade, a nota atual com quem mudou por último e quando, e a escolha de 1 a 5 em
  rádio (rascunho; "Salvar nota" grava); a nota dos demais na lista de membros com a
  visibilidade "membros"; a visibilidade em Configurações, só para o dono, com confirmação na
  tela; "N sem nota" no detalhe do racha, só para a organização. `database.types.ts`
  regenerado (inclui o `p_self` da `0030`, que faltava).

| Comando | Resultado |
|---|---|
| db:test | 29 arquivos, 2112 asserções, PASS (`0031`: 128); o censo de cron da `0011` passa a onze agendamentos, e os de rotinas de `service_role` da `0004` (62) e da `0020` nomeiam as três rotinas novas |
| db:test:ratings (novo) | 8 linhas `ok`, exit 0: pela Edge, dono e organizador avaliam (autoavaliação inclusa), o mesmo valor é sem mudança e o histórico guarda de quanto para quanto; jogador 403 `NOT_ORGANIZER`, ex-organizador e estranho 403 `NOT_MEMBER`, grupo inexistente 404, `STARS_RANGE` e meia estrela 422, alvo fora do grupo 409 `NOT_ACTIVE_MEMBER`; a organização vê quem e quando, o jogador só a própria com notas privadas e as dos demais sem autor com "membros"; o expulso continua lendo a própria; grupo apagado igual ao inexistente, replay inclusive. 8 corridas com barreira nas duas ordens (avaliar × avaliar o mesmo alvo, × expulsar o alvo, × apagar o grupo, e o replay × apagar). Grupo apagado com grupo, memberships e notas presos `FOR UPDATE`: 5 chamadas respondem com a trava presa, iguais às de um grupo inexistente, a mais lenta em 19 ms. Expurgo pelo worker real. Censo final em zero |
| db:test:membership | 75 `ok`; o censo de texto canônico passa a esperar a `0031` nas quatro funções de idempotência e nas duas do worker da `0016` |
| demais harnesses de §5 | exit 0 (idempotency 7, gateway 9, cors 6, worker 8, deletion 10, export 32, invites 68, groups 29, rename 11, group-deletion 13, photos 21, members 6, matches 15, match-players 21, geocode 7) |
| test:groups:web | 89 passed + 5 skipped (spec novo `notas`: 2 testes × 2 projetos — a organização avalia pelo teclado sem chamada por seta, a autoavaliação, o jogador só com a própria e sem a ferramenta, chamada forçada pela Edge recusada a jogador e estranho, o dono mostra as notas com "Voltar" sem chamada e o foco devolvido, os membros veem as notas sem autor; "N sem nota" no racha só para a organização) |
| test:matches:web / qr / cors / smoke / privacy | 24 / 30 / 4 / 6 / 5 + 5 skip |
| test:auth:web | sempre o foco do Perfil (`m1-a-auth.spec.ts:450`), que esta fatia não toca: na rodada da §5, 9 + 1 falha + 2 skip; contraprova com 7 rodadas de cada app na mesma pilha: com o app desta PR, 6 com a falha e 1 verde; com o app de `origin/main` (`3d17aed`), 5 com a falha e 2 verdes |
| verify:app | exit 0; vitest 57 arquivos, 704 testes; 1 aviso de lint da base (`PrivacyAccountScreen`) |
| scan:docs / scan:secrets / test:audit / test:staging / audit:high / diff --check | exit 0 (test:audit 94, test:staging 102, audit:high com as 2 exceções ativas) |

Contraprovas do pgTAP da `0031`, com mutantes aplicados nas funções vivas e restaurados byte
a byte (128 asserções no arquivo): sem `NOT_ORGANIZER`, 11 reprovam; sem `NOT_ACTIVE_MEMBER`,
8; sem `STARS_RANGE`, 3; repetir o valor gravando versão, o arquivo aborta (a CHECK da versão
recusa); replay devolvido antes da autoridade, 3; jogador vendo as notas privadas, 1; membros
vendo autor e instante, 1; leitura sem `NOT_MEMBER`, 6; a própria nota de grupo apagado, 1;
expurgo em 10 meses, 5; expurgo ignorando a membership já expurgada, 5. No harness: sem as
travas de perfil, grupo, membership e nota e com uma pausa depois de ler a nota atual, duas
notas simultâneas partem do nada (histórico `->4,->2`); com as travas e a mesma pausa, a
segunda espera e parte da primeira (`->4,4>2`); sem o predicado do grupo apagado na trava do
grupo, a nota num grupo apagado espera a linha presa por mais de 3 s antes de responder
`NOT_FOUND`. Capturas a 390 px em `~/colete-noite/notas-prints` (sem nota, organizador, minha
nota, mostrar as notas, notas visíveis, racha com "1 sem nota").

**Pendências:** a nota na exportação do titular (`13` §5.3), a tela da própria nota para quem
já saiu do grupo (o contrato já a devolve por `get_my_rating`), contestação de nota
(pós-piloto, obrigatória antes do público, D63-D), trilha `rating_changed_matchday`, N20 e
N24.
## Sorteio de times — `0032_draw_teams.sql` (19/10/2026)

Decisões humanas de César (`25` §8.1, contrato em `13` §4.4): o sorteio segue a D63-A, sobre
as notas do #83 (`0031`), e o goleiro segue o D8. Sobre o head do #83 (`b6e4add`); depende
dele.

- **`0032`.** `private.match_draws` (um sorteio por racha, `team_count` 2–4,
  `algorithm_version = 'snake-v1'`) e `private.match_draw_members` (time, posição na
  sequência e a versão da nota usada, `rating_history_id`, que vira `null` quando o expurgo da
  `0031` apaga a versão), privadas, sem RLS nem privilégio; nenhuma estrela e nenhuma semente
  guardadas. `draw_teams` no padrão idempotente atual, com a lista de operações completa (as 34
  anteriores, inclusive `set_rating`, mais `draw_teams`) e o validador encadeado. O sorteio
  (`private.draw_match_teams`) é a serpentina por nota de `04` §6, início 0: nota desc e UUID
  asc, `balanced_sizes`, índices `0..K-1` e `K-1..0` repetindo os extremos e pulando time
  cheio; determinístico. Recusas novas: `RATINGS_MISSING` (confirmado sem nota) e
  `UNEQUAL_TEAMS_CONFIRMATION_REQUIRED` (tamanhos diferentes sem a confirmação de `01` §5.7),
  já no catálogo de `13` §8. Racha inexistente, cancelado ou de grupo apagado é decidido antes
  de travar qualquer linha do grupo; o racha vivo passa por `lock_match_context` e o estado é
  relido depois da trava, também no replay. `get_match_teams` ordena os jogadores de cada
  time por nome e marca como desatualizado, só para a organização, o sorteio cuja nota usada
  mudou.
- **Edge `groups`.** `draw_teams` recebe `confirm_unequal_sizes` (booleano obrigatório);
  `RATINGS_MISSING` 409 e `UNEQUAL_TEAMS_CONFIRMATION_REQUIRED` 422.
- **App.** A seção "Times" pede, na própria tela, a confirmação de tamanhos diferentes antes
  do primeiro sorteio e junto com "Sortear de novo"; "Há confirmados sem nota" quando falta
  nota (o "N sem nota" do #83 leva à tela de notas). Jogadores por nome dentro de cada time.
- **Limpeza dos e2e.** Uma leitura ainda em voo da página fechada (`get_group_ratings`, do
  #83, que trava perfil e depois grupo, como o app) deu deadlock com a limpeza do
  `rachas-v1.spec.ts`, que apaga grupos antes de perfis: 1 em 4 rodadas de
  `test:matches:web`, e o resíduo derrubou a rodada seguinte. A limpeza do `rachas-v1` e a do
  `sorteio-times` passam a refazer a transação quando o Postgres a escolhe como vítima
  (`40P01`).

| Comando | Resultado |
|---|---|
| db:test | 30 arquivos, 2295 asserções, PASS (`0032`: 183); os censos de rotinas de `service_role` da `0004` (64) e da `0020` nomeiam `draw_teams` (com a confirmação) e `get_match_teams` |
| db:test:teams | 9 linhas `ok`, exit 0: pela Edge, confirmado sem nota 409 `RATINGS_MISSING` e cinco em dois times sem confirmação 422; o organizador sorteia a serpentina por nota (conferida contra um oráculo independente em JS, os dois "goleiros" do perfil juntos, versões das notas guardadas) e dono, organizador e jogador leem os mesmos times; jogador 403, ex-membro e estranho 404 iguais ao ID inexistente; 14 corridas com barreira nas duas ordens (sortear × desistir, × confirmar, × avaliar, × cancelar, × apagar o grupo, e o replay × cancelar e × apagar); racha cancelado e grupo apagado presos `FOR UPDATE` respondendo sem esperar (10 chamadas, a mais lenta em 21 ms); quatro contraprovas executáveis: sem as travas, sem a releitura depois da trava, sem a decisão antes da trava e com o goleiro no sorteio. Censo final em zero |
| db:test:ratings / membership | 8 / 75 `ok`; o censo de texto canônico passa a esperar a `0032` nas quatro funções de idempotência da `0016` |
| demais harnesses de §5 | exit 0 (idempotency 7, gateway 9, cors 6, worker 8, deletion 10, export 32, invites 68, groups 29, rename 11, group-deletion 13, photos 21, members 6, matches 15, match-players 21, geocode 7) |
| test:matches:web | 28 passed (spec `sorteio-times`: 2 testes × 2 projetos — sem nota recusa, tamanhos diferentes confirmados na tela, a serpentina 5-4-3-2-1 em A, B, B, A, A com os dois "goleiros" no Time A, o jogador com os mesmos times por nome e sem notas, sortear de novo igual, nota alterada desatualizando só para a organização, lista alterada, chamada forçada recusada); antes do ajuste da limpeza, o deadlock apareceu em 1 de 4 execuções; com ele, a rodada final passou |
| test:groups:web / qr / cors / smoke / privacy | 89 + 5 skip / 30 / 4 / 6 / 5 + 5 skip |
| test:auth:web | sempre o foco do Perfil (`m1-a-auth.spec.ts:450`), que esta fatia não toca: 9 + 1 falha + 2 skip na rodada e em 3 execuções seguidas; a contraprova com o app de `origin/main` está no registro das notas, logo acima (5 de 7 com a mesma falha) |
| verify:app | exit 0; vitest 58 arquivos, 717 testes; 1 aviso de lint da base (`PrivacyAccountScreen`) |
| scan:docs / scan:secrets / test:audit / test:staging / audit:high / diff --check | exit 0 (test:audit 94, test:staging 102, audit:high com as 2 exceções ativas) |

Contraprovas do pgTAP da `0032`, com mutantes aplicados nas funções vivas e restaurados byte
a byte (183 asserções no arquivo): goleiro no sorteio (posição antes da nota), 15 reprovam;
desempate por UUID decrescente, 12; nota crescente, 16; rodízio sem ida e volta, 19; extremos
sem repetir, 19; quem sobra no último time, 9; sem `RATINGS_MISSING`, 2; sem a confirmação de
tamanhos, 2; sem `TEAM_SIZE_INVALID`, 4; sem a releitura de `MATCH_CANCELED` depois da trava,
2; replay antes do estado do racha, 2; sem `NOT_ORGANIZER`, 6; leitura na ordem da
serpentina, 1; nota mudada aparecendo ao jogador, 1; nota mudada sem desatualizar, 1; leitura
mostrando times de racha cancelado, 2. Vetores dourados no pgTAP: notas 5, 4, 3, 2 em A, B, B,
A (o exemplo da D63-A); cinco em dois times com quem sobra no Time A; empate de notas pelo
UUID; treze em quatro times com a última escolha pulando os times cheios (`1234432112341`).
Capturas a 390 px em `~/colete-noite/sorteio-prints`.

**Depois:** o v3 de `04` (evolução), proposta e ajuste manual (`13` §4.3), trilha pública, a
lista de goleiros (`list_kind`), N12 e os times na exportação LGPD.

## Polimento final — sem migration (20/10/2026)

Pedido de César antes da entrega: corrigir o que estiver quebrado, com defeito ou mal acabado,
sem funcionalidade nova, com prioridade para o convite pelo link e pelo QR lido pela câmera do
celular. Sobre `origin/main` em `e2e0425` (migrations até a `0032`); nenhuma migration nova.
Fontes: a varredura `bugbash.md` (0 P1, 17 P2, 10 P3) e os P2/P3 ainda abertos dos pareceres
do #73 ao #83 e das prévias, todos já contidos na varredura.

- **Convite pelo link e pelo QR (P1).** O token do fragmento vivia só na memória da página e se
  perdia em toda recarga: na página do grupo de quem já entrou (voltava o formulário pedindo o
  código), em Entrar (o login ia para Grupos), em Verificar código (o cadastro recomeçava sem o
  convite) e em Complete seu perfil (terminava no formulário do código). No celular, ir ao app
  de e-mail e voltar costuma recarregar a aba. Correção (decisão humana de 20/10/2026, `25`
  §5.1 e `11`): o script inicial continua tirando o fragmento do endereço antes de tudo e
  passa a guardar um token bem formado só no `sessionStorage` da aba (`colete:invite`, prazo
  de 30 minutos); o app o apaga ao enviar o pedido, na página de quem já é membro ou já pediu,
  ao voltar ao formulário, com outro código ou QR, na recusa definitiva e na saída manual da
  conta (também de outra aba). Formato do link, prévia genérica, limitador e o que vai ao
  servidor não mudaram. "Abrir grupo" virou link de verdade (`href`).
- **Textos longos.** Nome do grupo na Agenda e no racha, o "Voltar" com o nome do grupo (agora
  numa linha, com reticências), nome e apelido no Perfil e "Escolher <nome>" da transferência
  ficam dentro da tela; prova nova que mede cada trecho de texto contra a tela e contra todo
  ancestral que corta.
- **Telas.** Notas: cartão não editado segue a leitura nova, e a perda definitiva de acesso
  descarta a projeção. Sorteio: o foco volta a "Sortear times" também quando a confirmação veio
  do servidor, e mudar uma nota no app invalida os times em cache. Apagar grupo: o campo pede o
  nome e o botão fica habilitado e explica o nome que não confere. Editar racha: fechar com
  alteração pede confirmação. Remover foto: confirmação na própria tela. Ícone do grupo: a
  escolha feita durante o salvamento é preservada, e o botão diz "Salvar ícone do grupo".
  Membros: um menu por vez. Agenda: o filtro fica no endereço (`?filtro=vou-jogar|com-vaga`).
  Hover em botões, filtros, opções de ícone e cor, cartões, abas e links. "Complete seu
  perfil" diz que só o nome é obrigatório.
- **Edge.** A foto só passa como JPEG completo: tabelas de quantização, cabeçalho de quadro
  coerente com os componentes, tabelas Huffman no quadro Huffman e varredura com dados.
- **Leituras da Edge.** Na primeira rodada da validação, o runtime local aposentou o worker de
  `groups` no limite de CPU acumulada (`per_worker`, 1 s) com duas leituras em voo, que
  voltaram 500 sem o envelope do Colete; a tela do grupo ficou sem a lista de rachas. As
  leituras passam a ser reenviadas como as mutações já eram (até duas vezes, 150 e 300 ms),
  mas só quando o 5xx não traz o envelope, isto é, quando a função nem respondeu; recusa,
  `INTERNAL` e falha de rede continuam respondendo na hora.
- **Instável do Perfil (`m1-a-auth.spec.ts:450`).** O React Hook Form refocava o campo inválido
  num `setTimeout(0)` depois do envio, além do foco do próprio formulário; quando o teste ia ao
  rádio, o timer devolvia o foco ao Apelido. `shouldFocusError: false` nos dois formulários de
  perfil.
- **Outras intermitências achadas nas rodadas.** A contraprova do mutante de `db:test:geocode`
  simulava a resposta do portão 900 ms atrasada contra uma janela de 1000 ms: com a pilha
  carregada, a ida e volta da RPC passou de 100 ms, a chamada abandonou o horário e o mutante
  não quebrou o espaçamento (1235 ms medidos); o atraso passa a 600 ms, longe dos dois limites.
  No `sorteio-times`, o toque em "2 times" caía durante a releitura do racha depois da recusa
  de 3 times, quando o app ignora a troca; o teste passa a esperar o fim da ação.
- **Testes e documentos.** Resíduos de `auth.flow_state` e do expurgo de notas limpos pelos
  testes que os criam; skills copiadas para o worktree fora do Prettier; `LOCATIONIQ_API_KEY`
  no inventário de `28`; Perfil de `11` alinhado à decisão de 17/10.

**Não corrigido:** BB-001 (estranho recebe `NOT_MEMBER` no grupo ativo e `NOT_FOUND` no ID
inexistente): é o contrato de `13` para todas as operações de grupo; por decisão de César
(20/10) fica para uma fatia própria de contrato. BB-031 (React #418 nas rotas autenticadas no
layout largo): o layout largo ou estreito vem da largura da janela, que o HTML estático não
conhece; corrigir exige outra forma de escolher o layout e fica para depois.

Deploy: app web e Edge `groups` (a regra do JPEG). Nenhuma migration, segredo ou configuração
nova.

Contraprovas executáveis, com o build de `origin/main` num worktree separado e os specs desta
fatia: `convite-link` 8 de 8 falham, e 4 de 4 no comportamento sem as asserções de
armazenamento; os demais specs alterados falham cada um na asserção nova (18 de 28 no lote, e
isolados para notas sem acesso, times desatualizados, escolha durante o salvamento, filtro no
endereço, hover de filtro, cartão, trilho e link, um menu por vez, texto do perfil, `href` do
"Abrir grupo" e rótulo do ícone). Unitárias: o teste do JPEG falha com o `photo-image.ts`
anterior; o censo de `db:test:ratings` reprova sem as duas exclusões novas; `format:check`
reprova com as skills copiadas e sem o `.prettierignore` novo. Instável do Perfil: 1 de 4
verdes em repetição antes, 8 de 8 depois.

Validação de §5, local (sem CI: os minutos do Actions acabaram), cada rodada começando por
`db:reset`. A primeira tentativa achou as leituras perdidas no runtime; a segunda, a margem do
geocode e o toque do sorteio; R2 e R3 passaram inteiras; R4 parou num teste porque o Mac
entrou em suspensão por inatividade às 16:09:28 por 323 s (`pmset -g log`), com o
`axe.runPartial` congelado 321 s. R5, R6 e R7, seguidas, sob `caffeinate -i -s`:

| Comando | R5 / R6 / R7 |
|---|---|
| db:reset | exit 0 nas três; banco recriado só pelas migrations até a `0032` |
| db:test | 30 arquivos, 2295 asserções, PASS nas três |
| harnesses de §5 e do CI | exit 0 nas três: idempotency 7, gateway 9, cors 6, worker 8, deletion 10, export 32, invites 68, groups 29, membership 75, rename 11, group-deletion 13, photos 21, members 6, matches 15, match-players 21, ratings 8, teams 9, geocode 7 (mutante 650,5 / 650,7 / 650,6 ms < 1000; restaurado 1399,7 / 1399,8 / 1399,5 ms) |
| test:groups:web | 101 passed + 5 skipped nas três (inclui `convite-link` e `textos-longos`, novos) |
| test:matches:web / qr / cors / smoke | 28 / 30 / 4 / 6 nas três |
| test:auth:web / privacy | 10 + 2 skipped (com o foco do Perfil) / 5 + 5 skipped nas três |
| verify:app | exit 0 nas três; vitest 59 arquivos, 728 testes; lint sem avisos |
| build:web:staging + verify:pwa | exit 0 nas três |
| scan:docs / scan:secrets / test:audit / test:staging / audit:high / diff --check | exit 0 nas três (test:audit 94, test:staging 102, audit:high com as 2 exceções ativas) |

Censo depois de cada rodada: zero em todas as tabelas de domínio, de Auth (usuários,
sessões, identidades, `flow_state`) e de Storage; ficam as sementes (4 MIME, 20 limites, 1
`geocode_throttle`, 3 buckets), 2814 entradas sintéticas de auditoria do Auth e uma execução
do cron `process_external_effects` da própria pilha.

### Correção da revisão do #84 — recarga em "Verificar código"

P1 da revisão de `2f2cb43`: o e-mail do cadastro esperando o código vivia só na memória da
página (Zustand); recarregar "Verificar código" (a volta do app de e-mail) tirava o campo do
código e dizia "Nenhum código está pendente", e o novo cadastro do mesmo e-mail recebia 429. Com
o convite, a pessoa não chegava à página do grupo. Correção: o e-mail e o horário do próximo
reenvio ficam só no `sessionStorage` da aba (`colete:pending-signup`), pelo prazo do código
(`otp_expiry`, 3600 s, renovado a cada reenvio); nunca o código, a senha ou o nome. Saem
quando o código é aceito, ao voltar ao formulário de cadastro, ao entrar com senha e na saída
manual da conta (também de outra aba). A tela restaura o e-mail depois da primeira
renderização, para coincidir com a página estática. Os P2/P3 da revisão ficam para depois.

Provas: no `convite-link`, a conta nova recarrega em "Verificar código" e termina na página
do grupo, com o censo do armazenamento (só o e-mail em `colete:pending-signup` antes; nada
depois); no `m1-a-auth`, o cadastro comum recarrega, espera de verdade a contagem restaurada
acabar (o Auth recusa reenvio com menos de um minuto: 429 imediato, 200 aos 62 s), reenvia,
recarrega de novo, verifica o segundo código e completa o perfil; um formulário de cadastro
aberto apaga o que estava guardado. Os dois nos dois tamanhos. Contraprova com o app de
`2f2cb43` e os specs novos: 4 de 4 falham na recarga, sem o campo do código. `convite-link` e
`m1-a-auth` seguidos, três vezes: 20 passed + 2 skipped em cada. Unitários de
`lib/pending-signup` (prazo, formato, armazenamento bloqueado, saída da conta).

Rodada de §5 sobre esta correção, sob `caffeinate`: banco recriado só pelas migrations; pgTAP
30 arquivos e 2295 asserções; os 19 harnesses exit 0; `test:auth:web` 12 + 2 skipped (com o
teste novo), `test:groups:web` 101 + 5, `test:matches:web` 28, `test:qr:web` 30, `cors` 4,
`smoke` 6, `privacy` 5 + 5; `build:web:staging`, `verify:pwa`, `scan:docs`, `scan:secrets`,
`test:audit` 94 e `test:staging` 102 exit 0; `verify:app` repetido depois de formatar o
`auth-flow-store.ts` (a rodada parou nele): exit 0, vitest 60 arquivos e 731 testes; `git diff
--check` limpo depois de tirar uma linha em branco no fim deste arquivo. **`audit:high`
reprovou** por um alerta publicado neste dia, `GHSA-587h-7wmj-h5pm` (high), no `vite@8.2.2`
que só entra pelo `vitest`, sobre o `launch-editor` no Windows; o lockfile é o mesmo de
`origin/main`, que reprova igual. Por decisão de César, fica fora deste PR (atualização do
`vite` ou exceção datada em PR próprio). Censo depois da rodada: só as sementes, os logs de
auditoria do Auth e uma execução do cron da pilha.

### Ícone do app na paleta Placar premium

O ícone do PWA ainda era o verde do scaffold (`#0A6335`), fora da paleta de `docs/29`. Pedido
do César (20/10): trocar pelo colete neon escolhido entre as variações geradas fora do
repositório. Uma vetorização automática do PNG manchava o tecido e transformava o brilho num
anel serrilhado; o `public/icons/icon.svg` foi então redesenhado à mão, com o mesmo desenho:
fundo `#0A1120`, faixas navy (`#14224A` → `#1A2B5C`) e âmbar (`#F5A62C` → `#FFC75A`),
contorno creme com borda âmbar e brilho por `feGaussianBlur`. O fundo agora ocupa o quadro
inteiro, sem cantos arredondados, porque o ícone é `maskable` e quem recorta é o sistema; o
colete cabe no círculo seguro de 80%. Os PNGs de 192 e 512 saem do SVG pelo
`generate:icons`, como antes, e o `CACHE_VERSION` do `public/sw.js` passou a
`colete-shell-v2`. A troca só descarta os ativos estáticos guardados pelo service worker. O
manifesto e o favicon não passam por esse cache, então o ícone na tela inicial de quem já
instalou o app só muda quando o navegador atualizar o app instalado.

### Correções rápidas de UX da auditoria (2ª Avaliação, 21/10/2026)

A auditoria de UX/UI e acessibilidade (`~/colete-noite/ux-auditoria.md`, fora do repositório),
consolidada com a avaliação independente do Codex, listou 48 problemas. Por decisão de César,
este PR leva só os três da lista "corrigir agora" que cabem antes da apresentação. Os demais,
inclusive os de severidade 3 (UX-003/HX-001, HX-002, HX-003, HX-005 e HX-014), ficam para
depois.

- **UX-001 / HX-004 (Nielsen 3).** "Fechar" em Criar racha descartava o formulário preenchido
  sem perguntar: a confirmação de BB-006 só valia na edição, porque a linha de base só era
  gravada ao pré-preencher. A criação agora parte do formulário vazio como linha de base, e o
  grupo escolhido no seletor conta como campo. Formulário vazio fecha direto.
- **UX-014 (WCAG 1.4.1).** Em Ícone do grupo, o ícone escolhido era indicado só pela cor da
  borda e do fundo. Ele ganha um selo ✓ (`appearance-icon-<ícone>-check`, oculto do leitor,
  que já tem `aria-pressed`), como a cor escolhida já tinha.
- **UX-002 (WCAG 2.4.7).** As linhas de link de Configurações do grupo ("Ícone do grupo") e do
  Perfil ("Trocar senha", "Privacidade e conta") ficavam dentro de um cartão com
  `overflow: hidden`, que cortava o anel de foco desenhado 2 px fora da linha: invisível na
  linha única de Configurações, um traço no Perfil. O cartão deixa de cortar e a linha ganha o
  raio do cartão, para o anel acompanhar a forma.

**Provas.** Um auxiliar novo (`e2e/support/layout.ts`, `tabTo` e `focusRingClipped`) leva o
foco por Tab até o alvo e mede o anel contra todo ancestral que corta: o estilo calculado
sozinho não detecta o corte. Ele entra em `icone-grupo` (Configurações) e em `m1-a-auth`
(Perfil). `icone-grupo` também afirma um único selo, no ícone escolhido, antes e depois da
troca. `editar-racha` ganha um teste de criação: vazio fecha; preenchido pergunta, "Continuar
editando" devolve o foco e o texto, "Descartar alterações" fecha e nada é gravado. Roda nos
dois projetos, com o celular fixado em 390 px.

**Contraprovas contra `origin/main` (`e0f44c4`)**, com os testes novos e o `src` da base:

- teste de criação: 2/2 reprovados (390 e 1280), o título "Descartar as alterações?" não
  aparece;
- `icone-grupo`: 2/2 reprovados, anel cortado em `bottom`, `left`, `right` e `top`;
- só com a correção do foco aplicada, 2/2 reprovados no selo (`toHaveCount(1)` recebeu 0);
- `m1-a-auth`: reprovado em "Trocar senha", anel cortado em `left`, `right` e `top`.

**Validação** sob `caffeinate`, com a pilha local na trava `pilha.lock`: `db:reset` exit 0;
`verify:app` exit 0 (vitest 60 arquivos e 731 testes); `build:web:auth-e2e` exit 0;
`test:matches:web` 30 passed; `test:groups:web` 101 passed + 5 skipped; `test:auth:web` 12
passed + 2 skipped; `test:privacy:web` 5 passed + 5 skipped. Censo depois da rodada: zero
usuários, perfis, grupos, membros e rachas. Prints antes/depois (390 px) em
`~/colete-noite/ux-prints/`, fora do repositório.

### Fuso do racha — HX-005, sem migration (28/10/2026)

Fatia 1.2 do plano do piloto (`~/colete-noite/plano-piloto.md`, fora do repositório; respostas
de César de 28/10/2026, P6 (a): só o app passa a mandar o fuso do racha, sem trava no servidor).
O defeito ainda acontecia em `4a115e6`: o formulário de edição pré-preenchia data e horas pelo
relógio do aparelho (`getDate`/`getHours`), montava o instante com `setHours` e, como a edição
não passava o fuso, gravava o fuso do aparelho no lugar do fuso do racha. Um organizador com o
celular em Manaus via 18:00 num racha marcado para 19:00 em São Paulo; se digitasse 19:00, o
racha ia para as 20:00 de São Paulo e passava a ser exibido no horário de Manaus para todos.

- **Formulário no fuso do racha.** Um módulo novo (`src/features/matches/match-zone.ts`, só
  `Intl`, sem dependência) converte relógio de parede ↔ instante num fuso IANA. A criação usa o
  fuso do aparelho, como antes; a edição pré-preenche, valida "hoje" e "início já passou" e
  envia no fuso do racha, e manda sempre `match.timezone`. Mudança de horário de verão: no
  buraco, o instante cai depois do salto; na hora repetida, na primeira.
- **O fuso aparece só quando o aparelho mostra outra hora.** "Horário do racha: Horário Padrão
  de Brasília (GMT-3)" acima da Data, no formulário de edição, e sob o horário, no detalhe. A
  comparação é pelo deslocamento no início do racha: um aparelho em Maceió diante de um racha de
  São Paulo não vê aviso. O texto `detail.timezone`, que não era usado, deu lugar a
  `matches.zone`.

**Provas.** `match-zone.test.ts` (ida e volta em quatro fusos, virada de mês, buraco e hora
repetida de Lisboa, quando avisar). `match-form.test.ts` ganha um bloco HX-005 com um racha em
Tóquio (UTC+9). `match-form.test.ts` e `match-schedule.test.ts` deixam de montar os instantes
esperados pelo relógio da máquina e passam a escrevê-los em UTC para São Paulo. A suíte inteira
passa com a máquina em `America/Sao_Paulo`, `America/Manaus`, `Asia/Tokyo`, `UTC`,
`Pacific/Kiritimati` e `America/Los_Angeles` (740 testes em cada). `editar-racha` ganha um
teste com o contexto do navegador em `America/Manaus` editando um racha de São Paulo: o detalhe
e o formulário mostram 19:00–20:30 e o aviso; mudar para 20:00–21:30 grava
`20:00-03:00`/`21:30-03:00` com `timezone = America/Sao_Paulo`, e o mesmo dono num contexto em
São Paulo vê 20:00–21:30 sem aviso.

**Contraprovas contra `4a115e6`**, com os testes novos e o `src` da base:

- `match-form.test.ts` com a máquina em São Paulo: 3/15 reprovados (os três do bloco HX-005);
  em Manaus: 6/15 reprovados;
- `editar-racha`, teste do fuso, nos dois projetos (412 px no `mobile-chromium`, que é o Pixel 7,
  e 1280 px; medido pelo revisor): reprovado no aviso, ausente; sem as linhas do aviso,
  reprovado em `match-startTime`, esperado "19:00", recebido "18:00".

**Validação** com a pilha local na trava `pilha.lock`: `db:start` exit 0 (migrations `0001` a
`0032`); `verify:app` exit 0 (vitest 62 arquivos e 740 testes); `build:web:auth-e2e` exit 0;
`test:matches:web` 32 passed; `test:groups:web` 121 passed + 5 skipped. Censo depois da rodada:
zero usuários, perfis, grupos, membros e rachas. Prints antes/depois (390 px) em
`~/colete-noite/ux-prints/hx005-antes/` e `hx005-depois/`, fora do repositório.

#### Correções da revisão do #88

A revisão independente (`~/colete-noite/rev88.md`, fora do repositório) deu CONFERIDO no
`3cb430b`, com 0 P1, 0 P2 e 5 P3. Por decisão de César, quatro entram neste PR e o P3-3 fica
como está: o aviso compara os fusos no início gravado, não na data digitada, e isso só muda algo
onde há horário de verão, que o Brasil não tem desde 2019.

- **P3-1.** O teste "saves an untouched edit" passava também na base, porque recebia o fuso
  pronto e o defeito estava na tela. A regra da edição sai da tela para `matchEditConfigFromForm`
  (fuso, início e fim do próprio racha), e o teste novo a chama sem fuso nenhum.
- **P3-2.** O aviso só descrevia o campo Data. Ele passa a ser um texto único acima da Data,
  ligado como descrição acessível de Data, Início e Fim (`AppTextField` ganha
  `describedByExtra`).
- **P3-4.** Sem o nome longo do fuso no `Intl`, o rótulo virava só `America/Maceio`. Agora é
  `America/Maceio (GMT-3)`.
- **P3-5.** A largura do e2e nas contraprovas acima: 412 e 1280 px, não 390 px.

**Contraprovas contra `3cb430b`**, com os testes novos e o `src` revisado: 2/20 reprovados em
`match-zone.test.ts` e `match-form.test.ts` (o rótulo sem nome longo e a edição sem fuso).

**Validação** com a pilha local na trava `pilha.lock`: vitest 741 testes com a máquina em
`America/Sao_Paulo`, `America/Manaus`, `Asia/Tokyo` e `UTC`; `verify:app` exit 0 (62 arquivos e
741 testes); `db:start` e `build:web:auth-e2e` exit 0; `test:matches:web` 32 passed;
`test:groups:web` 121 passed + 5 skipped. Censo depois da rodada: zero usuários, perfis, grupos,
membros e rachas.

### Tela que se atualiza sozinha — HX-003, sem migration (28/10/2026)

Fatia 1.5 do plano do piloto (`~/colete-noite/plano-piloto.md`, fora do repositório; resposta de
César de 28/10/2026, P9 (b): 30 s, só com a tela em primeiro plano, confirmado por medição).
Antes, aprovação, promoção da espera e mudanças feitas por outra pessoa só apareciam depois de
recarregar: o `QueryClient` não tinha `refetchInterval` (confirmado em `2a97d39`).

- **Leitura a cada 30 s com a tela na frente.** Grupos (lista e pedidos pendentes), Agenda (e a
  lista de rachas do detalhe do grupo, que usa a mesma leitura) e o detalhe do racha (racha,
  lista e times) leem de novo a cada `LIVE_REFRESH_MS` (`src/lib/query-client.ts`), só enquanto
  a página está visível **e** aquela tela é a da frente (`useLiveInterval`, com o `useIsFocused`
  do expo-router): uma aba ou tela que ficou montada por baixo de outra não lê. Ao voltar à
  frente (a página ou a tela), o que venceu é lido na hora. No celular nativo,
  `src/lib/app-focus.ts` liga o foco do TanStack ao `AppState`.
- **"Atualizado às HH:MM" e "Atualizar".** As três telas mostram a hora da leitura mais antiga
  da tela (no detalhe, contando racha, lista e times) e um botão que lê na hora (`LiveRefresh`);
  no detalhe, o botão lê também os times.
- **Falha e sessão.** Uma leitura que falha com dados na tela não troca a lista pelo aviso
  grande: a linha diz "Não foi possível atualizar. Última leitura às HH:MM" (`role="status"`). O
  aviso grande de rede fica para a tela sem nada carregado. Sessão recusada pelo servidor mostra
  o aviso de sessão e para a leitura de 30 s (`liveInterval`), em vez de um 401 a cada 30 s até
  o token vencer.

**Medição antes de fixar o intervalo** (`~/colete-noite/medicao-cpu-1.5/`, fora do
repositório): CPU do contêiner da Edge pelo cgroup (`usage_usec`), descontado o ocioso, 40
leituras por operação com um racha de 10 vagas e 11 inscritos, em duas rodadas. Por leitura:
3,2 a 3,9 ms em `list_my_matches`, `get_matches_occupancy`, `get_match`, `get_match_roster`,
`get_match_teams` e `get_my_pending_group_requests` (p50 de 20 a 22 ms). Por tela: Agenda 6,4 e
7,6 ms, detalhe 9,1 e 10,6 ms, Grupos 3,8 ms. Duas abas no detalhe lendo juntas (6 leituras em
voo, 20 rajadas): 120 de 120 respostas 200, nenhum 5xx. A 30 s, um detalhe aberto custa cerca
de 20 ms de CPU por minuto e 360 chamadas à Edge por hora (as 3 do detalhe a cada 30 s, medidas
no e2e com Grupos e Agenda montados por baixo); a Agenda na frente custa 240 chamadas à Edge e
240 ao PostgREST por hora. O que pesa no plano hospedado é o número de chamadas, não o CPU. A
revisão (rev89) mediu de 2,2 a 3,4 ms por leitura, na mesma ordem.

**Provas.** `src/lib/live-refresh.test.ts` (hora da leitura mais antiga, leitura que ainda não
aconteceu, meia-noite). Dois testes novos no fim de `e2e/rachas-ux.spec.ts` (assim a suíte
`test:matches:web` os roda sem mudar o `package.json`, cuja alteração exigiria `audit:high` com
exit 0, hoje vermelho na `main`), com o relógio da página nas mãos
do teste: a Ana, com Grupos aberto e o pedido pendente, vê o grupo aprovado aos 30 s e não aos
20 s; o dono, no detalhe, vê o segundo confirmado aos 30 s sem recarregar; na Agenda, uma
leitura por intervalo, nenhuma em 2 minutos de página oculta, uma ao voltar e "Atualizar" lê na
hora. Roda nos dois projetos (412 e 1280 px). O teste deixa o relógio rodar até cada leitura
terminar: uma leitura ainda em voo quando a página some termina depois e parece recente na
volta, e o TanStack, corretamente, não lê de novo.

**Contraprovas contra `2a97d39`**, com o teste novo e o `src` da base: reprovado no texto
"Atualizado às", ausente; sem as linhas desse texto e do botão, reprovado porque o grupo
aprovado não aparece aos 30 s e porque a Agenda não lê sozinha (0 leituras, esperada 1).

**Instável achado na rodada.** `rachas-v1`, "tabs, modal creation", falhou 4 vezes em 7 rodadas
da suíte, nunca sozinho: depois do envio vazio, o foco vai ao primeiro campo inválido num
`requestAnimationFrame`; com o quadro atrasado (cerca de 70 ms no trace), o foco voltava à Data
no meio do preenchimento do Início, e "19:30" ia para a Data cheia. O teste passa a esperar o foco
na Data antes de preencher. Depois disso, 3 rodadas seguidas da suíte com 36 passed. A revisão não
reproduziu a falha (16 execuções com o quadro atrasado à força), achou o mecanismo coerente com o
código e confirmou que a espera não esconde defeito do app; o trace da falha fica em
`~/colete-noite/hx003-evidencias/trace-rachas-v1-instavel.zip`, fora do repositório.

**Validação** com a pilha local na trava `pilha.lock`: `db:reset` exit 0; `verify:app` exit 0
(vitest 63 arquivos e 744 testes); `build:web:auth-e2e` exit 0; `test:matches:web` 36 passed em
3 rodadas seguidas; `test:groups:web` 121 passed + 5 skipped. `audit:high` exit 1 na `main` e
neste ramo, sem relação com a fatia (que não muda dependência): GHSA-587h-7wmj-h5pm (vite), o
alerta novo GHSA-mrhx-c7xc-m3w5 (zod) e a exceção órfã GHSA-vfj7-8cjw-p6xm (braces). Censo depois da rodada: zero
usuários, perfis, grupos, membros e rachas. Prints antes/depois (390 px) em
`~/colete-noite/ux-prints/hx003-antes/` e `hx003-depois/`, fora do repositório.

#### Correções da revisão do #89

A revisão independente (`~/colete-noite/rev89.md`, fora do repositório) deu CONFERIDO no
`60b4254`, com 0 P1, 1 P2 e 6 P3. Por decisão de César, todos entram neste PR.

- **P2-1.** O intervalo só parava com a página oculta: Grupos e Agenda, montados por baixo,
  continuavam lendo com o detalhe na frente, inclusive sob Criar e Editar (6 chamadas à Edge a
  cada 30 s com o detalhe aberto, não 3). Agora `useLiveInterval` liga o intervalo ao foco da
  navegação (`useIsFocused` do expo-router), e o `LiveRefresh` lê na hora, ao voltar, o que
  venceu enquanto a tela estava por baixo.
- **P3-1.** Com a sessão recusada, a tela dizia "falar com o serviço" e mandava um 401 por
  leitura a cada 30 s até o token vencer. Agora o intervalo para e aparece o aviso de sessão
  (`ReadNotice`).
- **P3-2.** Uma releitura que falha com dados na tela não põe mais o aviso grande no meio da
  lista: a linha da hora diz "Não foi possível atualizar. Última leitura às HH:MM". O aviso de
  rede fica para a tela vazia; na lista do detalhe, o erro em linha também só aparece sem lista.
- **P3-3.** No detalhe, a hora e o "Atualizando…" passam a contar os times (um observador
  desligado da mesma chave, que só acompanha o estado; quem lê continua sendo o `MatchTeams`).
- **P3-4.** Três testes novos no `rachas-ux`: só a tela da frente lê (contagem por operação com
  Grupos, Agenda, detalhe e Editar); falha com dados na tela e sessão revogada; e, com o relógio
  real, "Atualizando…" enquanto os times respondem atrasados, "Atualizar" lendo só o racha
  aberto (nada do outro racha no cache) e a falha só dos times dita na linha.
- **P3-5.** O comentário de `dayDigits` volta a ficar sobre a própria função.
- **P3-6.** A causa do instável está no trace guardado (ver acima); a revisão confirmou o
  mecanismo pelo código, sem reproduzir.

**Contraprovas contra `60b4254`**, com os testes novos e o `src` revisado: os três reprovam. Só
a tela da frente: Grupos leu com a Agenda na frente (esperado `pending: 0`). Falha com dados:
"Atualizado às", sem a linha de falha. Detalhe: a falha só dos times não aparece na linha (e,
numa rodada, a Agenda por baixo leu durante o teste).

**Validação das correções** com a pilha local na trava `pilha.lock`: `verify:app` exit 0 (vitest
63 arquivos e 747 testes); `build:web:auth-e2e` exit 0; `test:matches:web` 42 passed em duas
rodadas seguidas; `test:groups:web` 120 passed + 5 skipped + 1 falha na primeira rodada
(`ajustes-teste.spec.ts:105`, o primeiro teste da suíte, preso no carregamento inicial antes de
qualquer tela com releitura; passou 3 de 3 sozinho) e 121 passed + 5 skipped na rodada seguinte.
Censo depois: zero usuários, perfis, grupos, membros e rachas.

#### Correções da conferência do #89

A conferência (`~/colete-noite/conf89.md`, fora do repositório) deu CONFERIDO no `a2c799d`: 6
achados corrigidos, 1 parcial e 2 achados novos, todos P3. Entram neste PR:

- **N1.** "Racha não encontrado" ficava em branco quando uma releitura falhava pela rede, porque
  `readProblem` tratava o `null` da leitura (racha inexistente ou alheio) como dado na tela.
  Agora `null` conta como tela vazia, e a falha mostra o aviso de rede.
- **N2.** O `role="status"` ligava e desligava no mesmo nó a cada ciclo de falha. Agora uma região
  `role="status"` fica sempre montada e oculta, com o mesmo texto durante toda a falha ("Não foi
  possível atualizar. A tela mostra a última leitura."): é dita quando a falha começa e não se
  repete a cada 30 s. A linha visível deixa de ser região viva.
- **P3-4 (parcial).** Um teste derruba `get_match_roster` com a lista na tela e afirma que a lista
  fica e o erro em linha não aparece. O mutante M5 da conferência (voltar a trocar a lista pelo
  erro) agora reprova (`match-roster-error`: esperado 0, recebido 1).

**Contraprovas contra `a2c799d`**: os testes do anúncio e do N1 reprovam. **Validação:**
`verify:app` exit 0 (vitest 63 arquivos e 747 testes); `test:matches:web` 44 passed;
`test:groups:web` 121 passed + 5 skipped. Censo depois: zero usuários, perfis, grupos, membros e
rachas.

### Instrução de pagamento para quem joga — D63-G, sem migration (28/10/2026)

Fatia 1.1 do plano do piloto (`~/colete-noite/plano-piloto.md`, fora do repositório; pré-plano
CONFERIDO para a 1.1 em `rev-plano-piloto.md`; respostas de César de 28/10/2026: P5 (a), sem
campo novo; P11 (b), o dono e os organizadores; P12, os estados). Antes, quem jogava via só o
chip "Não pagou", e o texto `payNote` existia sem uso (UX-022).

- **O bloco "Pagamento" no detalhe do racha**, na seção de confirmados: «Pague ao organizador:
  Ana ou Beto.» e "R$ 12,50 por jogador. O acerto é feito fora do app: quando a organização
  receber, ela marca você como pago." Depois da marcação: "Pagamento marcado pela organização."
- **Quem recebe** vem de `get_group_members`, que todo membro ativo já lê: o dono primeiro e
  depois os organizadores ativos, sem o `created_by` do racha, que é histórico. Sem artigo antes
  dos nomes, porque o nome não diz qual cabe. A leitura só acontece enquanto a instrução aparece.
- **Estados (P12)** em `src/features/matches/payment-notice.ts`: a instrução só para quem está
  confirmado e não pago, também com o racha iniciado ou terminado; nada na espera, nada para quem
  não pagou num racha cancelado e nada na linha de quem organiza (que vê o resumo). Quem foi
  marcado pago vê a marcação, inclusive no racha cancelado.
- Sem migration, Edge nem mudança de contrato.

**Provas.** `payment-notice.test.ts` (nomes com o dono primeiro e organizadores ativos, sem nome
quando não há leitura, os estados da P12). `racha-completo` ganha um teste com dono, organizador,
dois confirmados e um na espera: a instrução e o preço para a confirmada não paga; nada para a
espera, nada para o dono e o organizador **confirmados** (eles jogam no racha do teste) e nenhuma
leitura de quem recebe nas três páginas; o dono primeiro mesmo vindo depois do organizador no
alfabeto; o nome do organizador removido sumindo ao tocar "Atualizar"; a marcação depois do
pagamento; nada para quem não pagou depois do cancelamento, enquanto quem pagou mantém a marcação;
e a instrução num racha já iniciado e num já terminado. Roda nos dois projetos (412 e 1280 px).

**Contraprovas contra `2760546`**, com o teste novo e o `src` da base: reprovado, o bloco não
existe. Mutante com a instrução também na espera: reprovado (`match-pay-notice`: esperado 0,
recebido 1).

**Validação** com a pilha local na trava `pilha.lock`: `verify:app` exit 0 (vitest 64 arquivos e
753 testes); `build:web:auth-e2e` exit 0; `test:matches:web` 46 passed; `test:groups:web` 121
passed + 5 skipped. Censo depois da rodada: zero usuários, perfis, grupos, membros e rachas. Prints
a 412 px (o Pixel 7 do projeto `mobile-chromium`) em `~/colete-noite/ux-prints/pagamento-11/`,
fora do repositório; o antes é a mesma tela sem o bloco. **Custo** (medido na revisão, `rev91`):
em regime, o detalhe faz as mesmas 6 leituras por minuto de antes (`get_match`,
`get_match_roster` e `get_match_teams`, a cada 30 s); a instrução acrescenta 1 `get_group_members`
ao abrir, só para quem a vê, mais a releitura ao tocar "Atualizar" ou ao voltar à tela. Quem não
vê a instrução também relê os membros ao tocar "Atualizar" se o detalhe do mesmo grupo ainda está
aberto na aba Grupos, porque aquela tela mantém a mesma leitura ligada (conferência do #91, N1):
uma leitura por toque, de uma lista que essa pessoa já lê ali. A leitura de membros não tem
`refetchInterval`.

#### Correções da revisão do #91

A revisão independente (`~/colete-noite/rev91.md`, fora do repositório) deu CONFERIDO no `f4d773d`,
com 0 P1, 3 P2 e 3 P3; o comportamento já estava certo em todos os estados da P12 e na regra da
P11. Entram neste PR:

- **P2-1.** O dono e o organizador do e2e passam a jogar (o racha ganha 4 vagas), e a afirmação
  "nada na linha de quem organiza" é feita sobre uma linha confirmada.
- **P2-2.** O dono vem depois do organizador no alfabeto, no unitário ("Zeca ou Ana", "Zeca, Ana ou
  Bruno") e no e2e, então "dono primeiro" não passa mais por ordenação por nome.
- **P2-3.** "Atualizar" no detalhe relê também quem recebe, enquanto a instrução aparece (sem
  instrução a leitura fica desligada e é pulada, salvo com o grupo aberto na aba Grupos, como diz
  o custo acima). Um organizador removido com o detalhe aberto some da
  instrução ao tocar "Atualizar". A leitura de membros continua fora do intervalo de 30 s.
- **P3-1.** O e2e cobre também o racha já terminado; o título do unitário deixou de prometer o
  início do racha, que não entra na regra.
- **P3-2.** O e2e conta as leituras de `get_group_members` nas páginas da espera, do dono e do
  organizador: zero.
- **P3-3.** A seção acima corrige a largura dos prints (412 px), traz o custo medido e descreve a
  prova do dono e do organizador como ela é.

**Mutantes da revisão**, agora todos reprovados no e2e (`mobile-chromium`): a regra sem
`canManage`; `canManage: false` na tela; nomes por ordem alfabética; leitura de membros sempre
ligada; o bloco sumindo no racha terminado; e "Atualizar" sem reler quem recebe.

**Validação das correções:** `verify:app` exit 0 (vitest 64 arquivos e 754 testes);
`test:matches:web` 46 passed; `test:groups:web` 121 passed + 5 skipped. Censo depois: zero
usuários, perfis, grupos e rachas.

### Sincronização do teste de polling ao voltar de Editar racha (05/11/2026)

O cenário de `e2e/rachas-ux.spec.ts` captura os cinco contadores antes de fechar Editar,
retém uma única resposta real de `get_match` desse racha até observar “Atualizando” e a
libera antes de esperar “Atualizado às”. O `finally` libera a resposta e remove a
interceptação também na falha. Antes de avançar o relógio, exige uma leitura de detalhe,
presença e times, com zero leituras de Grupos e Agenda; o ciclo seguinte exige o mesmo.
A conferência independente de `d984fa3` resolveu os dois P2 e não encontrou achado novo.
O arquivo de teste desta entrega é idêntico ao desse SHA.

**Contraprovas já executadas**, em mobile e wide: a resposta pronta antes da observação
faz o teste anterior perder “Atualizando” (2 falhas); com retenção, 2 passam. Suprimir só
a leitura imediata de times mantém o teste anterior verde (2 passam), mas o corrigido
detecta `teams: 0` antes do relógio (2 falhas). Sem perturbação, 30/30 antes e 30/30
depois (15 por viewport em cada versão), conforme o plano mestre. Logs da rodada em
`/tmp/rachas-p2.Xa2oYt`, fora do repositório.

**Validação obrigatória desta entrega**, sob a trava `noite/pilha.lock`, em
`/tmp/colete-polling-delivery.1VZQK8`: `db:reset` exit 0, recriando somente pelas
migrations até a `0032`; `db:test` PASS, 30 arquivos e 2.295 testes. Todos os harnesses
`db:test:idempotency`, `gateway`, `cors`, `worker`, `deletion`, `export`, `invites`,
`groups`, `membership`, `rename`, `group-deletion`, `photos`, `members`, `matches`,
`match-players`, `ratings`, `teams` e `geocode` terminaram com exit 0, incluindo seus
censos de resíduo. `build:web:auth-e2e` exit 0; auth 12 passed + 2 skipped; privacidade
5 passed + 5 skipped; CORS 4 passed; grupos 121 passed + 5 skipped; rachas 46 passed;
QR 30 passed; build smoke exit 0 e smoke 6 passed. `verify:app` exit 0, com 64 arquivos
e 754 testes unitários, lint, formatação, typecheck, build, PWA e configuração Auth;
`scan:docs` e `scan:secrets` exit 0 (500 arquivos no scan de fronteiras).
`test:audit` 94/94 e `test:staging` 102/102. Pilha local parada e trava removida ao fim.
Nenhum projeto Supabase remoto ou serviço de produção foi acessado nesta validação.

`audit:high` exit 1: exceção órfã GHSA-vfj7-8cjw-p6xm (braces) e alertas high
GHSA-mrhx-c7xc-m3w5 (zod), GHSA-qr28-fpjm-wq7f (decode-uri-component),
GHSA-7wch-p9px-956x, GHSA-jc66-7q78-782g, GHSA-8hrf-8g6f-7xwp,
GHSA-hqq3-7jhf-c5jx, GHSA-5x38-2vff-x55p (node-forge) e GHSA-587h-7wmj-h5pm
(vite). A fatia não altera arquivos abrangidos pelo gate de dependências da AGENTS §5;
o resultado é relatado conforme essa seção.

## Registro de operações de idempotência — D63.5, `0033_idempotency_operations.sql` (28/10/2026)

Fatia D63.5 (`09` D63.5; `16` §8 "Pré-M3 — registro de operações"; obrigatória antes do piloto com
usuários reais, `25` §8.1). Pré-plano conferido em duas rodadas (`~/colete-noite/plano-d63-5.md`,
`rev-plano-d63-5.md` e `rev2-plano-d63-5.md`, fora do repositório); decisões humanas de César de
28/10/2026, P-A a P-F. Cerimônia cheia: revisão completa e conferência, e o PR para por decisão
humana por alterar `docs/10`, `docs/13` e `docs/25` (AGENTS §4.11).

**O que mudou.** Até a `0032`, cada operação nova redefinia a lista de operações em cinco lugares
(três CHECKs de `private.idempotency_records`, `acquire_group_idempotency`,
`complete_group_idempotency`, o gatilho de conclusão e mais um elo numa cadeia de 13 validadores
renomeados). Agora:

- `private.idempotency_operations` (35 linhas: 4 `identity`, 2 `account`, 29 `group`) e
  `private.idempotency_operation_results` (52 pares), em `private`, sem RLS e sem grant, imutáveis
  por gatilho de linha e de `TRUNCATE`.
- Três FKs no lugar dos três CHECKs: `(operation)`, que vale também para o
  `executing_uncommitted`; `(operation, outcome_code)`; e `(operation, resource_type)`. As compostas
  são `MATCH SIMPLE`: com nulo não conferem, com valor conferem por operação, o que é mais estrito
  que os CHECKs globais. O SQLSTATE de operação desconhecida passa de `23514` a `23503`; nenhum
  chamador lê esse código (os `acquire_*` recusam antes com `VALIDATION`).
- Um validador estável (`stable`, invoker, `search_path` vazio) para os 35, e uma regra de conclusão
  única (`private.check_idempotency_conclusion`) usada pelo gatilho e pela revalidação.
- `acquire_group_idempotency` e `complete_group_idempotency` leem `family = 'group'` e o recurso da
  tabela. Os helpers de identidade e de conta ficam como estavam (P-B), mas passam a usar o mesmo
  validador e o mesmo gatilho.
- Os 13 elos da cadeia saíram.

**Endurecimentos deliberados** (caminhos que nenhuma RPC alcança): `logical_result` precisa ser
string em todas as operações (`rename_group` e `request_data_export` aceitavam JSON `null` no
validador); o gatilho compara recurso com `is distinct from` em todas (identidade e conta usavam
`<>`, que deixa nulo passar); `operation` NULL, que o elo do topo da cadeia validava como
`draw_teams`, é recusada (inalcançável: `operation` é `not null` e todo `complete_*` confere a
operação antes). O limite de 4096 bytes do desfecho, que valia para as de identidade, vale para
todas, mas é só defesa: com chaves exatas, nenhum desfecho que passe nas outras regras chega perto
dele, então ele não muda nenhum resultado.

**A migration.** Uma transação: `lock_timeout` de 5 s; `access exclusive` em
`idempotency_records` desde o início; recusa se houver `executing_uncommitted` visível; carga do
registro; validador e regra de conclusão; revalidação de todo `completed` existente com a regra
nova (P-D), abortando no primeiro que falhar, com `operation` e `request_id` do registro no
`DETAIL` (sem `actor_key`); as FKs (que conferem também os `payload_expired` ao
nascer); `drop` dos CHECKs; troca dos helpers e do gatilho; `drop` dos 13 elos. Aplicar no staging
é um gate operacional separado, com autorização própria e janela sem uso.

**Ordem de travas.** As FKs tomam `FOR KEY SHARE` na linha da operação quando o `acquire` insere o
registro; o replay não insere linha (`on conflict do nothing`) e não toma essa trava. O
`complete_*` que conclui o registro toma `FOR KEY SHARE` na linha do resultado e da operação depois
das travas de domínio, fora da sequência literal da ordem global. Não há ciclo de travas de linha
nos caminhos das RPCs: nenhuma função trava essas linhas de modo conflitante, e os gatilhos
recusam `UPDATE`, `DELETE` e `TRUNCATE`. O limite não cobre DDL; o padrão da `0033` para migrations
está registrado no `docs/25` §2, em "Modo de lock (M2-D13)". Medido no `db:test:idempotency`
(25 conexões), com `checkpoint` e
`pg_control_checkpoint()` antes e depois: 112 MultiXact por rodada na `0032` e 114 na `0033`, iguais
nas duas repetições de cada lado. O registro desta ordem no `docs/25` §2 foi autorizado por César em 05/11/2026,
com a decisão registrada no §8.1 e os ajustes P3-1 a P3-4 autorizados em 05/11/2026; o merge
continua sendo decisão dele.

**Provas.** As asserções que afirmavam onde a lista morava (os `pg_get_constraintdef` dos CHECKs, os
privilégios dos elos `validate_through_*`, os `pg_get_functiondef ... like '%draw_teams%'` e o
SQLSTATE `23514` da operação desconhecida, em `0004`, `0016`, `0021`, `0022` e `0027`–`0032`)
foram trocadas por equivalentes contra o registro, uma a uma, sem mudar a contagem de nenhum
arquivo. As comportamentais (`lives_ok`/`throws_ok` sobre o validador, os `complete_*`, os replays
e as RPCs) ficaram intactas e são a prova de equivalência. A operação desconhecida continua
recusada (`throws_ok`, agora `23503`). Novos:

- `0033_idempotency_operations.test.sql` (65): o registro (35 operações, 52 pares, famílias,
  formatos, recurso igual ao ator); sem RLS e papel-sonda negativo (`anon`, `authenticated`,
  `service_role` sem `select` nem `insert`, `service_role` sem `usage` em `private`, sem `execute`
  nas funções novas); volatilidade e `security definer` de cada função; as três FKs, o fim dos
  CHECKs e dos 13 elos; imutabilidade (`UPDATE`, `DELETE`, `TRUNCATE` e `TRUNCATE ... CASCADE`); os
  três formatos e o endurecimento; as FKs por DML direto (resultado e tipo de recurso de outra
  operação, recurso em `update_profile`, `payload_expired` com resultado alheio); a regra de
  conclusão com registros plantados (coerente passa; `outcome_code` diferente do `logical_result`,
  `resource_id` divergente e o `logical_result: null` que a cadeia velha aceitava são recusados;
  `payload_expired` coerente passa; `set_profile_photo` com recurso igual ao desfecho e diferente
do ator é recusado, com o controle do recurso igual ao ator); e os helpers de grupo recusando operação de outra família, com
  um controle positivo do mesmo ator.
- `db:test:membership` ganha a deriva da `0033` (`EXPECTED_0033_OVERRIDES`: as quatro funções da
  `0016`, agora com o validador `stable`), a consistência entre a Edge e o registro (as listas de
  `operations.ts`, `invite-gateway.ts` e `photo-gateway.ts`, menos as seis leituras declaradas,
  iguais às famílias do registro: 6 de identidade e conta, 29 de grupo) e o commit real do gatilho
  diferido (três registros que passam nas FKs e violam a regra são recusados no `COMMIT` com
  `IDEMPOTENCY_OUTCOME_INVALID`, sem resíduo; o terceiro é o de `set_profile_photo` com recurso
  diferente do ator, com o perfil criado na mesma transação). A prova roda como `postgres`, não
  como `service_role`: o gatilho é `security definer`, então o papel do `COMMIT` não muda o que
  ele lê, e a fronteira do `definer` é provada à parte (`0033` e `db:test:gateway`, mutante do
  gatilho sem `security definer`).

**Mutantes**, cada um numa cópia da `0033` com `db:reset`: validador que ignora os resultados (12
reprovados); validador que aceita chave a mais (16); regra de conclusão sem o mapeamento de recurso
(1); regra de conclusão sem a cláusula do ator (1 no `db:test`, mais o commit real);
`acquire_group_idempotency` sem o filtro de família (3: `0031` teste 53, `0032` teste 67 e `0033`
teste 64, medidos em `~/dev/colete/noite/conf92.md` no `8cc54fa`; com ator inexistente, o `acquire`
recusava pelo ator e o mutante sobrevivia antes de o teste passar a usar um perfil real); `grant`
do registro para `service_role` (7, com `select` e `insert`; só `select` dá 3); gatilho sem
`security definer` (1); só a FK simples, sem as compostas (6); gatilho que não chama a regra (1 no
`0031` e 1 no `0032`, mais o commit real); `complete_group_idempotency` sem o filtro de família (3).
O limite de 4096 bytes não tem mutante que morra, porque não tem efeito observável (ver os
endurecimentos).

**A migration sobre dados** (medição, não harness). A revalidação só age num banco que já tem
registros, e o `db:reset` parte de uma tabela vazia. Procedimento: tirar a `0033` da pasta,
`supabase db reset --local` (banco na `0032`), plantar registros por SQL, devolver a `0033` e
`supabase migration up --local`. Na revisão (`~/colete-noite/rev92.md`, fora do repositório):
256 registros válidos das 35 operações (6 deles `payload_expired`) passaram, com os dados
idênticos antes e depois e o replay devolvendo o mesmo desfecho; quatro bancos com um registro
inválido plantado abortaram com rollback total (`22023`, `23514`, `23503` e `55P03`, este com
um `executing_uncommitted` concorrente). Depois da correção, o aborto do `revoke_current_session`
sem recurso traz `operation=revoke_current_session request_id=…` no `DETAIL`. Virar isso em
harness fica como dívida aberta: pede um banco intermediário na `0032`, que nenhuma suíte monta
hoje.

**Suítes de banco** (AGENTS §5), com a pilha local na trava `pilha.lock`: `db:reset` exit 0;
`db:test` 31 arquivos e 2.360 testes; `db:test:idempotency`, `gateway`, `cors`, `worker`,
`deletion`, `export`, `invites`, `groups`, `membership`, `rename`, `group-deletion`, `photos`,
`members`, `matches`, `match-players`, `ratings`, `teams` e `geocode`, todos exit 0.

**Validação web** (AGENTS §5): `verify:app` exit 0; `build:web:auth-e2e` exit 0; `test:auth:web` 12
passed + 2 skipped; `test:privacy:web` 5 passed + 5 skipped; `test:cors:web` 4 passed;
`test:groups:web` 121 passed + 5 skipped; `test:matches:web` 44 passed em 28/10; `test:qr:web` 30 passed;
`build:web:smoke` e `test:smoke:web` 6 passed; `scan:docs`, `scan:secrets`, `test:audit` e
`test:staging` exit 0. Depois do rebase sobre `a9d6092`, `test:matches:web` passou a 46 passed,
com 2 testes vindos da `main`, conforme `~/dev/colete/noite/pr92-rebase-a9d6092/test:matches:web.log`
e a [execução 42134844299](https://github.com/Cesararanha/colete/actions/runs/42134844299).
`audit:high` exit 1 no log `~/dev/colete/noite/pr92-rebase-a9d6092/audit:high.log`:
exceção órfã GHSA-vfj7-8cjw-p6xm (braces) e alertas high GHSA-mrhx-c7xc-m3w5 (zod),
GHSA-qr28-fpjm-wq7f (decode-uri-component), GHSA-7wch-p9px-956x, GHSA-jc66-7q78-782g,
GHSA-8hrf-8g6f-7xwp, GHSA-hqq3-7jhf-c5jx, GHSA-5x38-2vff-x55p (node-forge) e
GHSA-587h-7wmj-h5pm (vite). A fatia não altera arquivos abrangidos pelo gate de dependências
da AGENTS §5; o resultado é relatado conforme essa seção. Censo depois: zero usuários, perfis,
grupos, rachas e registros de idempotência. `package.json` intocado.

#### Correções da revisão do #92

A revisão completa (`~/colete-noite/rev92.md`, fora do repositório) deu CONFERIDO no `bc7264a`, com
0 P1, 1 P2 e 7 P3. O diferencial dela (4.516 vetores no validador e 30.304 commits reais) não achou
nenhum desfecho recusado antes que passe a ser aceito. Entram neste PR:

- **P2-1.** A cláusula "recurso = ator" da regra de conclusão ganha teste: um par
  `lives_ok`/`throws_ok` no pgTAP e o terceiro caso do commit real. O mutante que a apaga, que
  sobrevivia a todas as suítes, agora reprova nas duas.
- **P3-1.** A asserção dos 4096 bytes diz o que prova, e o limite fica registrado como defesa sem
  efeito observável.
- **P3-2.** No `0031` e no `0032`, a asserção sobre os helpers volta a ler o corpo de cada função:
  os de grupo leem o registro com `family = 'group'`, e o gatilho chama a regra única.
- **P3-3.** O papel do commit real (`postgres`) e o motivo estão registrados acima.
- **P3-4.** `operation` NULL entra na lista dos endurecimentos.
- **P3-5.** O aborto da revalidação diz qual registro falhou.
- **P3-6.** O MultiXact medido está na ordem de travas.
- **P3-7.** A medição da migration sobre dados está registrada, e o harness fica como dívida
  aberta.

#### Correções da conferência final do #92 (05/11/2026)

Este PR só de documentos corrige os oito P3 de `~/dev/colete/noite/conf92-final.md`:
P3-1 a P3-4 delimitam e reposicionam a ordem de travas e seu registro no `docs/25`, com a segunda
autorização de César em 05/11/2026 e checksum recalculado; P3-5 preserva os 44 testes de 28/10 e
registra os 46 depois do rebase; P3-6 lista todos os alertas do log de auditoria; P3-7 completa o
motivo da decisão humana; P3-8 registra as 3 reprovações medidas do mutante M4. Os números de
banco, web e mutantes acima são medições anteriores, com suas fontes; a pilha local não foi
iniciada neste PR. A correção N1 da conferência do PR #94 (`~/dev/colete/noite/conf94.md`),
autorizada por César em 05/11/2026, move o parágrafo do registro para depois de "O ciclo não
precisa de dois perfis alheios", preservando a referência desse ciclo ao `FOR UPDATE` em perfil.

No `36d0a14`, `npm ci` terminou com exit 0 (1.025 pacotes instalados e 1.026 auditados).
Validação local da correção de posição do #94 (05/11/2026):
`scan:docs` exit 0 (23 documentos, 24 entradas no manifesto, D1–D62, N1–N28 e 25 telas);
`verify:app` exit 0 (64 arquivos e 754 testes unitários; fronteiras de segredo em 502 arquivos);
`git diff --check` exit 0. O diff se limita a `docs/25`, `docs/26` e ao manifesto. O terminal usou
Node 24.15.0 e npm 11.14.1, dentro de `engines`, diferentes dos 24.20.0/11.19.0 fixados para a CI.

A conferência final também encontrou a mesma falha `57014` (`statement timeout`) de
`db:test:invites` na [execução 38661901678](https://github.com/Cesararanha/colete/actions/runs/38661901678),
em 15/10/2026, antes da `0033`. Isso prova que a falha ocorre sem a `0033`; a causa não está
provada, nem que os dois eventos tenham a mesma causa.

## Piloto 1.3 — devolução no cancelamento (`0034`, 06/11/2026)

Implementação na branch `feat/devolucao-cancelamento`, com a `main 20eda49` incorporada.
Autorização de César P10/P16 e decisões do plano do piloto de 28/10 e 06/11 (§14 prevalece),
fora do repositório. Revisão independente de risco alto e publicação a cargo do orquestrador.
Somente pilha Supabase local deste projeto,
registry público de pacotes e consulta inicial ao GitHub; nenhum projeto Supabase remoto,
serviço de produção ou credencial real. Nenhum `.env` de outra checkout foi lido/copiado.

**Entrega.** `private.match_refunds`, por identidade de pagamento (inscrição + instante),
preço congelado, origem `canceled|left_group`, estados `refund_due|refunded`, datas e autores
sem referência livre. Cancelamento e saída do grupo transferem atomicamente a marcação e
limpam seus três campos; cancelado preserva lista histórica mesmo com saída do grupo.
Backfill de todo `removed` pago, inclusive em andamento/terminado, e pago em cancelado,
usando o preço atual (origem canceled prevalece). CHECK de pago somente em starter.
`record_canceled_match_payment`, `mark_refunded`, `correct_refund` por gateway/idempotência;
a correção preserva devolvido e altera só a data. `cancel_match` mantém o desfecho anterior,
sem contagem/total. As três operações são INSERT nos dois registros da `0033`, imutável:
**38 operações / 57 resultados** no estado novo. Preço e exclusão do grupo têm as travas
do `13` §3.3.2/§5.0.8. Nenhuma operação da fatia 1.4 entrou.

**Provas novas.** pgTAP: fronteira sem RLS/grants, EXECUTE nominal, unicidade por pagamento
com inserção esperando 23505 (origem diferente não pode escapar), zeramento conjunto, retorno
não pago com obrigação antiga e segundo pagamento/segunda saída produzindo duas obrigações;
P13×P17, lista starter e obrigação canceled preservadas em leave_group, preço bloqueado com
pago e com obrigação sem paid, exclusão recusada em futuro/em andamento e com obrigação de
racha terminado, permissões, datas, replays, correção preservando os fatos financeiros,
projeção própria/organizacional e conta em exclusão desidentificada. Um teste documenta o
risco já aceito: exclusão do dono solo ainda arquiva grupo com obrigação de terceiro.
Testes anteriores de preço, cancelado e apagar foram adaptados ao contrato autorizado,
conservando suas provas de replay e de concorrência; nenhuma asserção foi removida.

`db:test:refunds` usa conexões distintas, barreira observada em pg_stat_activity, duas
marcações e duas correções concorrentes com commit real sob service_role. O gatilho de
idempotência recusa commit de executing_uncommitted e de completed malformado sob esse
papel. Contraprova tira as travas do contexto e torna vermelha a barreira delete×payment;
a definição original é restaurada no finally. Backfill usa o trecho SQL real da migration
sobre fixture do estado anterior dentro de rollback (canceled, futuro, em andamento e
terminado); não é simulação do predicado em JavaScript. Também cria sessão real GoTrue e
exercita as três operações, seus replays, projeção da organização e recusa ao jogador por
HTTP Edge. Não depende do navegador para essa prova. Entra em package.json, AGENTS §5 e
Database security juntos; o workflow só mudou nesse job.

**Interface e leituras.** Bloco da 1.1 mostra a própria devolução, sem esconder a instrução
da inscrição nova quando a pessoa voltou. Organização vê inclusive ex-membros; conta em
exclusão aparece “Conta excluída”. Confirmação de cancelamento lista pagos e total; registro
manual/correção pede confirmação com pessoa, valor e racha (`15`, prevenção de erro) e data
no fuso do racha (mesmo helper da 1.2). Sem alegar confirmação bancária. Após pagamento tardio,
o foco usa o `refund_id` do desfecho, depois de renderizar; se o controle ainda não estiver
na tela, volta a Atualizar. Marcação e correção conservam o foco na obrigação; cancelar a
confirmação de pagamento volta ao botão da pessoa. A projeção nova participa de Atualizar,
intervalo e hora da leitura mais antiga. Conta refeita a partir do custo e das correções de #89/#91 neste documento:

| Tela na frente, visível | Leituras a cada 30 s | Chamadas Edge/hora (aritmética, sem retries) |
|---|---|---|
| Detalhe não cancelado, jogador | get_match, get_match_roster, get_match_teams: 3 | 360 |
| Detalhe não cancelado, organização | as mesmas + get_match_refunds: 4 | 480 |
| Detalhe cancelado, jogador | get_match, get_match_roster: 2 | 240 |
| Detalhe cancelado, organização | as mesmas + get_match_refunds: 3 | 360 |

get_group_members da instrução não tem intervalo: uma leitura ao abrir quando necessário,
mais Atualizar/volta à tela; get_group_ratings também não tem intervalo. Não há “5 leituras
periódicas” na organização. Duas abas de organização abertas: 8 chamadas por ciclo, 960/h.
As chamadas por hora são contagem do código e aritmética, sem retries. A medição nova de
CPU está registrada abaixo. O teste de polling conta também refunds e mantém
Grupos/Agenda/Editar quietos conforme foco. Os fluxos de navegador e as capturas foram
validados pelo orquestrador fora do sandbox, conforme registro abaixo.

**Medição de CPU refeita — 06/11/2026 (§13.1 do plano do piloto).** Script e
artefato fora do repositório em `/Users/cesararanha/dev/colete/noite/medicao-cpu-1.3/`:
`medir.mjs` e `resultado-1793989187662.json`. Execução, a partir desta worktree:
`node /Users/cesararanha/dev/colete/noite/medicao-cpu-1.3/medir.mjs` — exit 0.
Mesmo método da 1.5: `usage_usec` do cgroup v2 de `supabase_edge_runtime_colete`,
descontando o ocioso pela média ponderada de duas janelas de 5 s (antes/depois de cada
rodada). Ocioso: 2,7343 e 3,1430 µs/ms. Quarenta leituras sequenciais por operação,
duas rodadas, racha futuro de 10 vagas e 11 inscritos (10 confirmados + 1 na espera),
com dois times sorteados e uma obrigação pendente de pagamento anterior de quem voltou.
Sessão real GoTrue da organização; sem retries HTTP. As duas abas são simuladas por HTTP
com as quatro operações de cada detalhe em voo juntas, sem navegador. Os helpers de status local, pedidos,
conexão pg e fluxo GoTrue/Edge foram adaptados de `scripts/test-match-refunds.mjs`, sem
importá-lo (o módulo executaria o harness e a limpeza das fixtures fixas).

| Operação | CPU líquida ms/leitura, rodada 1 | Rodada 2 | Respostas 200 (duas rodadas) | 5xx |
|---|---|---|---|---|
| get_match | 2,4068 | 2,4313 | 80/80 | 0 |
| get_match_roster | 3,0037 | 2,5686 | 80/80 | 0 |
| get_match_teams | 2,9507 | 2,1776 | 80/80 | 0 |
| get_match_refunds | 2,5516 | 2,9415 | 80/80 | 0 |
| Duas abas de organização, 8 leituras em voo × 20 rajadas por rodada | 1,7855 | 1,8911 | 320/320 | 0 |

Soma das quatro leituras isoladas do detalhe: **10,9128 e 10,1189 ms de CPU**;
a cada 30 s, estimativa aritmética de 21,8255 e 20,2378 ms de CPU/minuto por detalhe
não cancelado. As rajadas consumiram **285,6865 e 302,5759 ms de CPU** no total de
160 leituras por rodada (14,2843 e 15,1288 ms por rajada). Latência p50 por operação
isolada: 17,55–19,55 ms; nas rajadas: 41,23 e 42,24 ms. Total medido: **640/640 HTTP 200,
zero 5xx**, zero outros HTTP/erros de transporte/envelopes inválidos; aquecimento à parte:
40/40 HTTP 200. Medição local do contêiner, sem inferir custo do runtime hospedado.

Uma tentativa de preparo inicial recusou o sorteio com 409 por falta de notas na fixture;
foi limpa sem chegar à medição. O script passou a cadastrar as notas antes do sorteio.
Nas duas execuções, o censo dos IDs criados terminou em zero usuários Auth, perfis, grupos,
memberships, rachas, inscrições, sorteios e idempotências. Obrigações e membros de times
seguem as FKs com cascade; notas/histórico do grupo criado são removidos explicitamente.
Nenhum dado preexistente foi apagado, nenhum outro contêiner foi acessado.

**Validação da implementação original.** SUPABASE_TELEMETRY_DISABLED=1 foi usado para evitar a
escrita de telemetria fora das raízes permitidas. O primeiro db:reset teve exit 1 por
EPERM de telemetria; com telemetria desligada, exit 1 porque a pilha estava parada.
db:start terminou com exit 0, baixando imagens pelo CLI e aplicando migrations do zero;
depois db:reset exit 0 até a 0034. O Docker não foi bloqueado nem contornado. A pilha local
permaneceu ligada; nenhum outro contêiner foi inspecionado/parado/removido.

| Comando | Exit final / resultado |
|---|---|
| npm run db:start | 0 |
| npm run db:reset | 0; recriação só pelas migrations |
| npm run db:test | 0; 32 arquivos, **2.449 asserções** |
| npm run db:test:idempotency | 0 |
| npm run db:test:gateway | 0 |
| npm run db:test:cors | 0 |
| npm run db:test:worker | 0 |
| npm run db:test:deletion | 0 |
| npm run db:test:export | 0 |
| npm run db:test:invites | 0 |
| npm run db:test:groups | 0 |
| npm run db:test:membership | 0 |
| npm run db:test:rename | 0 |
| npm run db:test:group-deletion | 0; retestado após adaptar fixtures de sucesso à trava financeira |
| npm run db:test:photos | 0 |
| npm run db:test:members | 0 |
| npm run db:test:matches | 0 |
| npm run db:test:match-players | 0 |
| npm run db:test:ratings | 0 |
| npm run db:test:teams | 0 |
| npm run db:test:refunds | 0; barreiras, mutante, migração, commits e HTTP real; retestado após correção |
| npm run db:test:geocode | 0 |
| npm run generate:db-types | 0; gerado do banco local |
| npm run verify:app | 0; lint, formato, tipos, **65 arquivos / 773 unitários**, build, PWA, config Auth, scans |
| npm run build:web:auth-e2e | 0 |
| npm run build:web:smoke | 0 |
| npm run scan:docs | 0; hashes reais de 13/25 no manifesto |
| npm run scan:secrets | 0 |
| npm run test:audit | 0; 94 testes |
| npm run test:staging | 0; 102 testes locais, sem acessar staging |
| npm run audit:high | 0; uma exceção vigente, nenhum high/critical fora dela |
| git diff --check | 0 |
| npx playwright test --list | 0; 236 testes descobertos em 22 arquivos |
| npx playwright test e2e/racha-completo.spec.ts e2e/apagar-grupo.spec.ts --grep 'Pagamento:&#124;the owner deletes the group' --workers=1 | 1; 4 lançamentos bloqueados antes de abrir página |

Rodadas iniciais de db:test reprovaram as allowlists antigas e as expectativas substituídas
pelos contratos aprovados; o harness de grupo reprovou fixtures com pago antes de apagar.
Tudo corrigido e retestado acima. verify:app reprovou uma vez a formatação do harness novo,
depois exit 0. O harness de devolução foi corrigido durante sua construção (assinaturas,
casts e relógio de teste; datas vêm do relógio do banco para não presumir sincronização de
milissegundos com a máquina). São falhas resolvidas, distintas do limite do navegador.

**Validação de navegador pelo orquestrador — 06/11/2026.** Fora do sandbox, sobre a
`main 20eda49` incorporada:

| Comando | Exit / resultado |
|---|---|
| npm run build:web:auth-e2e | 0 |
| npm run test:qr:web | 0; 30 passaram |
| npm run test:auth:web | 0; 12 passaram |
| npm run test:privacy:web | 0; 5 passaram |
| npm run test:cors:web | 0; 4 passaram |
| npm run build:web:smoke | 0 |
| npm run test:smoke:web | 0; 6 passaram |
| npm run test:groups:web | 1; 120 passaram, 5 pulados, 1 falha |
| Repetição isolada de e2e/ajustes-teste.spec.ts, com build de autenticação refeito | 0; 6 de 6 passaram |
| npm run test:matches:web, após corrigir a assinatura com alvo | 0; 46 passaram |

A falha de `test:groups:web` foi em `e2e/ajustes-teste.spec.ts:105`, projeto
mobile-chromium: timeout esperando `complete_profile`. O teste não toca devolução;
fica registrado como intermitente, sem causa provada. A primeira execução de
`test:matches:web` falhou nos dois projetos em `e2e/racha-completo.spec.ts:376`:
o cliente recusava `profile_id` antes do transporte em `record_canceled_match_payment`.
A operação entrou na lista de assinaturas com alvo; depois disso, 46 passaram.
O teste novo de `src/lib/api.test.ts`, no padrão de `set_rating`, afirma a URL e o corpo
com `request_id`, `match_id` e `profile_id`. Contraprova executada: retirar somente essa
operação da lista faz o teste falhar com `AppError`/`VALIDATION`, antes do fetch (exit 1);
com a correção restaurada, exit 0.

Prints da devolução em 390 e 1280 px foram gerados e olhados pelo orquestrador;
a acessibilidade automática do fluxo (`assertAccessible`) passou no teste. Os ajustes
posteriores de foco e conteúdo da confirmação receberam a validação local abaixo;
nenhum Playwright foi executado novamente no sandbox.

**Validação local dos ajustes — 06/11/2026.**

| Comando | Exit / resultado |
|---|---|
| npx vitest run src/lib/api.test.ts -t 'sends a canceled match payment' | 0; teste novo passou (35 outros não selecionados) |
| Mesmo teste com a operação retirada temporariamente da lista de alvos | 1; VALIDATION antes do transporte, correção restaurada em finally |
| npm run verify:app | 0; lint, formato, tipos, 65 arquivos / 774 unitários, build web, PWA, Auth e scans |
| npm run scan:docs | 0; hash real de docs/25 atualizado no manifesto |
| git diff --check | 0 |

Log da verificação local: `/tmp/colete-refunds-followup-verify.log`. Nenhuma migration foi
alterada; a suíte de navegador não foi reexecutada no sandbox. Os resultados do orquestrador
acima precedem estes ajustes de foco e confirmação.

**Validação depois da revisão do #96 — 06/11/2026, fora do sandbox.**
Correções de `~/dev/colete/noite/rev96.md`, com as decisões do §15 do plano do piloto: backfill de todo
pago fora de `starter` e campo vazio usando o relógio do servidor. Pilha local recriada por `db:reset`.

| Comando | Exit / resultado |
|---|---|
| npm run db:test | 0; 2.464 asserções |
| npm run db:test:refunds, match-players, membership, deletion | 0 |
| npm run db:test:group-deletion, primeira execução | 1; limite de 3 s em `waited for the lock of the deleted group: replay regenerate_group_invite`, causa não comprovada |
| npm run db:test:group-deletion, repetido | 0; máximo de 107 ms nessa prova |
| npm run verify:app | 0; 778 unitários |
| npm run test:groups:web, test:cors:web, test:privacy:web, test:smoke:web | 0; 121, 4, 5 e 6 passaram |
| npm run test:qr:web, na rodada completa | 1; 28 passaram e 2 falharam, levando 7,2 min |
| npm run test:qr:web, repetido sozinho | 0; 30 passaram, em 47 s |
| npm run test:auth:web, na rodada completa | 1; 10 passaram e 2 falharam em `m1-a-auth.spec.ts:1169` |
| Esse teste de `m1-a-auth`, repetido sozinho | 0; 2 passaram |
| npm run test:matches:web, no código final | 0; 50 passaram |

As falhas de QR e autenticação foram tempo limite com a máquina carregada, e não voltaram ao repetir;
a causa não foi provada, e a suíte de autenticação inteira não foi repetida depois disso. A asserção nova de foco achou um
defeito: o `AppButton` com `ariaDisabled` é outro elemento na web e, ao terminar o envio, o foco posto
nele se perdia. O foco agora é pedido em um efeito, depois do commit em que o botão volta a ficar ativo. O Playwright rodou uma vez com o relógio do aparelho a +2 e a -2 minutos, nos
dois projetos. Depois da conferência (`~/dev/colete/noite/conf96.md`), mudaram o efeito de foco, o texto de `13` e `25`, a
limpeza do erro ao cancelar, a faixa "até agora" só no servidor e a espera da leitura nos testes do painel.
Em seguida: `test:matches:web` com 50 passando, numa versão do efeito ainda com estado, e, na versão final com referência,
`verify:app` com exit 0 e 777 unitários e `e2e/racha-completo.spec.ts` com 10 passando. As demais suítes não
foram repetidas: quem as confirma no SHA final é o `Database security`.

Censo final da validação original: **zero** auth.users, profiles, groups, group_members, matches,
match_players, match_refunds, idempotency_records, deletion_requests e external_effects.
As sementes/execuções operacionais da pilha permanecem; nenhum objeto de teste novo ficou.
Logs locais: /tmp/colete-refunds-validation, /tmp/colete-refunds-final e
/tmp/colete-refunds-{db,harness,deletion-retest,e2e-new}.log, fora do repositório.

**PERGUNTAS:** nenhuma decisão nova de produto/contrato pendente nesta fatia. Permanecem
os limites aprovados e registrados no 27: exclusão financeira da conta, ex-membro, retenção
e desidentificação financeira; 1.4, livro completo, Pix/provas, referência, notificações,
disputas e Admin não foram antecipados.


## Piloto 1.4 — adicionar e remover jogador pela organização (`0035`, 06/11/2026)

Implementação na worktree `adicionar-remover-jogador`, branch
`feat/adicionar-remover-jogador`, base `88d14dc` (#96, 1.3). Sem commit, push, PR,
deploy ou acesso a Supabase remoto; publicação e execução de Playwright ficam com o
coordenador, por instrução expressa. A pilha local Colete permanece de pé. Risco alto:
vaga, fila, dinheiro e projeção de membros; revisão completa independente e conferência
continuam exigidas pelo AGENTS §4.12.

**Entrega.** Migration append-only `0035_organizer_match_players.sql`: duas RPCs
nominais exclusivas de `service_role`, contexto e trava de `join_match`, membership do
alvo revalidada depois da trava. Dono/organizador ativo adiciona sem furar fila e remove
confirmado/espera antes do início; jogador, pendente, ex-membro e estranho recebem o
mesmo `NOT_FOUND`. `removed` entra no CHECK da obrigação; remoção paga transfere o
pagamento pelo helper da `0034`. Registros da `0033` recebem só INSERT: 40 operações,
62 pares de resultado. Sem coluna nova: autor da remoção somente na idempotência
por 30 dias. Autorremoção paga: `PAYMENT_ALREADY_REAL`; não paga: `FORBIDDEN`, já no
catálogo, e orientação ao “Desistir”. Nenhuma decisão de produto reaberta.

Gateway compartilhado publica as duas operações em `groups`, normaliza UUIDs, recusa
campos extras e usa os validadores e replay por registro. Cliente inclui operações,
tipos e testes de fronteira. `generate:db-types` gerou o arquivo do banco local;
`generate:error-codes` gerou 116 códigos, sem diferença no arquivo de códigos.
Tela oferece lista de membros ativos ausentes do racha, confirmação de remoção no
lugar, alerta de devolução e “os times ficam desatualizados”. Confirmação recebe foco;
cancelamento retorna ao controle; remoção retorna a Atualizar quando a linha desaparece.
Todos os textos novos estão em `pt`; cenário e2e nos projetos `mobile-chromium` e
`wide-chromium`, ver a execução de navegador abaixo.

**Contraprovas executadas em `db:test:match-players`.**

| Prova / mutante real | Resultado observado |
|---|---|
| `add_player` × `join_match` e × `leave_match` | 4 pares, ambas as ordens, competidores observados na trava do grupo; exatamente 1 confirmado em 1 vaga |
| Sem travas de grupo/racha e sem defesa final de capacidade, pausa entre contar e gravar | 2 confirmados em 1 vaga; asserção de capacidade falha; mesma pausa com travas mantém 1 |
| Membership lida antes da trava | alvo sai via `leave_group` enquanto adição espera; original recusa `NOT_FOUND` sem inscrição, mutante adiciona ex-membro como `starter` |
| Volta preservando `queue_seq` antigo | mutante volta em 1º passando A; asserção de posição 2 falha; original volta em 2º e não pago, com obrigação anterior pendente |
| Trava de preço olhando só `paid` | zero pagos e obrigação `removed` pendente; original recusa `PRICE_LOCKED`; a mesma asserção de recusa falha no mutante, que grava preço 19.00 |
| Unicidade antiga por inscrição (índice parcial de teste) | pagar → remover → voltar → pagar → remover: mutante aborta segunda remoção com `23505`; original cria 2 obrigações `removed` |
| Organizador pago remove a si mesmo, guarda removida | original recusa `PAYMENT_ALREADY_REAL`; mutante cria 1 devolução para si, violando contagem esperada 0 |
| Replay de adicionar depois de remover; replay de remover depois de voltar | conserva desfecho original, sem repetir adição/remoção |
| Commit real sob `service_role` | chamadas válidas concluem; 4 commits de registro incompleto/desfecho com campo extra (2 operações × 2 estados) recusados pelo trigger diferido |
| Saída do grupo depois de segunda remoção manual | preserva as 2 obrigações, sem criar outra |

Definições mutadas de add/remove/join/update e helper de locks restauradas em `finally`;
o harness compara as quatro RPCs com as definições originais, byte a byte. Censo final
independente: 13 tabelas de fixture com zero registros (Auth, perfis, grupos,
memberships, rachas, inscrições, obrigações, sorteios, membros de times, notas,
histórico de notas, idempotências e pedidos de exclusão). Índice mutante ausente;
zero pausas `pg_sleep` nas RPCs testadas. Nenhum contêiner de outro projeto foi
inspecionado ou parado; a trava externa da pilha não foi tocada.

**Censo de `removed`.** Busca textual em todas as migrations, cliente e export e
censo no banco vivo das 22 rotinas que referenciam `match_players`. Versões vigentes:
`join_match`/`leave_match` (`0028`) reaproveitam/ignoram a linha fora da lista;
`match_player_current`, resumo, promoção e ocupação (`0022`/`0027`) filtram
`starter|waitlist`, sem inferir saída do grupo. `get_match_roster` e obrigações (`0034`)
ocultam a linha removida e continuam projetando as obrigações. Sorteio (`0032`,
`draw_match_teams`, `draw_teams`, `get_match_teams`) filtra confirmados, esconde removido
e marca desatualizado por diferença de composição. Gatilho de saída (`0034`) só percorre
`starter|waitlist` futuros não cancelados: não duplica obrigação de remoção manual.
Notas/retenção (`0031`) dependem de `group_members`, que a remoção do racha preserva;
`changed_by_removed`/`account_removed` tratam exclusão de conta, não inscrição. Export
(`worker_get_data_export_build_target` vigente da `0030`, `data-export.ts`) exporta
memberships, sem ramo por status de inscrição e ainda sem export financeiro de rachas,
pendência já registrada na 1.3. Exclusão de conta passa memberships a removidas e
aciona o mesmo gatilho; não precisa distinguir a origem da inscrição já removida.
Cliente mantém `out` para ausência/left/removed, reentrada por “Vou jogar” e notas
baseadas na membership. Não foi necessário alterar esses leitores nem migrations
entregues; só nova origem, RPCs e suas fronteiras. Comentários antigos da `0022` são
históricos e permanecem imutáveis.

**Validação medida.** Todos os comandos abaixo terminaram com exit 0 na execução
sequencial final. Nos harnesses, a contagem é de linhas nominais `ok` emitidas,
incluindo censos, **não** a quantidade de chamadas a `assert`. Tempo e logs desta
sessão ficam em `/tmp/colete14-validation.json` e `/tmp/colete14-final-*.log`, fora do
repositório e sem conteúdo copiado de notas pessoais.

| Comando | Exit | Contagem medida |
|---|---|---|
| `npm run db:reset` | 0 | 34 migrations, até 0035 |
| `npm run db:test` | 0 | 33 arquivos / 2.599 asserções |
| `npm run db:test:idempotency` | 0 | 7 linhas ok |
| `npm run db:test:gateway` | 0 | 9 linhas ok |
| `npm run db:test:cors` | 0 | 6 linhas ok |
| `npm run db:test:worker` | 0 | 8 linhas ok |
| `npm run db:test:deletion` | 0 | 10 linhas ok |
| `npm run db:test:export` | 0 | 32 linhas ok |
| `npm run db:test:invites` | 0 | 68 linhas ok |
| `npm run db:test:groups` | 0 | 29 linhas ok |
| `npm run db:test:membership` | 0 | 77 linhas ok |
| `npm run db:test:rename` | 0 | 11 linhas ok |
| `npm run db:test:group-deletion` | 0 | 13 linhas ok |
| `npm run db:test:photos` | 0 | 21 linhas ok |
| `npm run db:test:members` | 0 | 6 linhas ok |
| `npm run db:test:matches` | 0 | 15 linhas ok |
| `npm run db:test:match-players` | 0 | 27 linhas ok |
| `npm run db:test:ratings` | 0 | 8 linhas ok |
| `npm run db:test:teams` | 0 | 9 linhas ok |
| `npm run db:test:refunds` | 0 | 8 linhas ok |
| `npm run db:test:geocode` | 0 | 7 linhas ok |
| `npm run build:web:auth-e2e` | 0 | 43 rotas estáticas |
| `npm run build:web:smoke` | 0 | 43 rotas estáticas |
| `npm run verify:app` | 0 | 65 arquivos / 782 unitários; lint, formato, tipos, build/PWA/Auth e scans |
| `npm run scan:docs` | 0 | 23 arquivos; hashes reais de 13/25 no manifesto |
| `npm run scan:secrets` | 0 | 511 arquivos, zero achados |
| `npm run test:audit` | 0 | 94 testes |
| `npm run test:staging` | 0 | 102 testes locais, sem staging remoto |
| `npm run audit:high` | 0 | 1 exceção vigente; zero high/critical fora dela |
| `npm run generate:db-types` | 0 | 2 RPCs novas geradas do banco local |
| `npm run generate:error-codes` | 0 | 116 códigos; sem diff |
| `git diff --check` | 0 | zero erros |

**Falhas anteriores, preservadas no relato.** Primeiro `db:start`: exit 1 porque o
banco ainda estava `starting`; repetição: exit 0. Primeiro `db:test` sem a variável de
telemetria: exit 1 por EPERM ao tentar gravar fora das raízes; execuções seguintes com
`SUPABASE_TELEMETRY_DISABLED=1`. Primeiro pgTAP efetivo reprovou allowlists antigas e a
permissão do helper temporário de teste, ajustados. Uma rodada de `db:test` executada
simultaneamente ao harness reprovou 3 contagens globais da `0029`; a repetição isolada
passou. É uma falha que passou ao repetir, relatada sem chamá-la de resolvida; os números
extras são compatíveis com interferência entre suítes. Primeiro harness estendido
reprovou o nickname sintético longo de uma fixture; nomes encurtados, depois exit 0.
Não houve falha de CI nesta sessão: CI não foi acionada, e não houve commit/push.

**Navegador, executado pelo coordenador fora do sandbox do autor (06/11/2026).** O Chromium
não abre no sandbox do autor, que escreveu o e2e sem poder rodá-lo. Após `db:reset`, primeira
rodada, sem repetição, todas com exit 0: `test:matches:web` 52 passed (2,6 min);
`test:auth:web` 12 passed + 2 skipped (1,3 min); `test:privacy:web` 5 passed + 5 skipped;
`test:cors:web` 4 passed; `test:groups:web` 121 passed + 5 skipped (5,6 min); `test:qr:web`
30 passed; `test:smoke:web` 6 passed. Novo cenário em `e2e/racha-completo.spec.ts:743`, nos
dois projetos: adicionar com vaga e sem vaga após sorteio; ocultar pendente e já listado;
organizador confirma/cancela remoção paga e restaura foco; promove fila, mostra devolução e
times desatualizados; jogador removido volta não pago ao fim da fila; remoção de espera não
cria obrigação; jogador não vê ações; 390 px e axe.

Como `e2e/racha-completo.spec.ts` e `scripts/test-match-players.mjs` foram editados durante
ou depois da validação do autor, o coordenador repetiu sobre a versão final: `verify:app` exit
0 (782 unitários), `db:test` exit 0 (33 arquivos, 2.599 asserções), `db:test:match-players`
exit 0 e `git diff --check` limpo.

### Correção da revisão — PR #97 (`a257b93`, 06/11/2026)

**P2-1.** Adição e remoção agora apresentam o `NOT_FOUND` uniforme como
“Não foi possível alterar a lista do racha. O acesso ou a participação no grupo pode
ter mudado.” O cliente não atribui a causa ao ator nem tenta distingui-la pela resposta.
Depois dessa recusa, relê os membros ativos autorizados; com leitura bem-sucedida,
atualiza também o racha/roster. A lista não oferece dados antigos quando a releitura
falha. Se o ator perdeu acesso, conserva a recusa na tela, sem forçar a releitura do
racha que retiraria sua explicação. Nenhuma alteração no servidor ou código de erro.

**P2-2.** O retorno das duas ações fica em uma região `AppAlert` das listas, acima
dos componentes condicionais: sobrevive à retirada da adição e das remoções de
confirmados ou da espera. `role=alert` e anúncio assertivo permanecem; a tentativa
recusada encaminha o foco para “Atualizar racha”, que sobrevive à atualização. Um novo
intento ou “Dispensar aviso” limpa o retorno; mudança posterior do estado que invalide
a recusa também a limpa (por exemplo, aviso de início quando o racha passa a cancelado).

**Provas acrescentadas; provas anteriores preservadas.**

- E2e em `racha-completo.spec.ts`: 12 casos parametrizados (adição, remoção de
  confirmado e remoção da espera × saída do alvo, saída do ator, início e cancelamento),
  previstos nos dois projetos Chromium. Leituras autorizadas ficam congeladas até
  entregar a recusa real da Edge/Postgres; a mudança concorrente usa outra sessão
  ou relógio da fixture. Conferem código uniforme, texto, região viva, foco sobrevivente,
  retirada do candidato/linha, manutenção da explicação ao perder acesso e limpeza
  do aviso. O autor não os executou; execução e contraprova do coordenador na parte
  de navegador abaixo.
- Harness: 6 pares novos com barreira observada por `pg_stat_activity` e
  `pg_blocking_pids`, conexões/atores independentes e COMMIT real como `service_role`.
  `remove_player` × `set_match_payment` nas duas ordens, inicialmente pago e não pago:
  marcação posterior à remoção recusa `NOT_STARTER`; pagamento anterior gera exatamente
  uma obrigação `removed` de 12.50 para o alvo; nenhum `paid` ou marcador residual.
  `remove_player` × `cancel_match`, nas duas ordens, inicialmente pago: exatamente uma
  obrigação, origem `removed` ou `canceled` conforme a ordem, sem pagamento sobrando.
- Replay: matriz HTTP real para as duas operações, incluindo mesmo `request_id`
  com alvo ou racha diferente (`IDEMPOTENCY_CONFLICT`), perda de papel/saída do grupo
  (somente desfecho), início (replay conserva desfecho; tentativa nova recusa),
  cancelamento com autoridade (`MATCH_CANCELED`, registro original intacto) e sem
  autoridade (somente desfecho). Conflito também conferido após perda de papel,
  início e cancelamento. Um efeito inverso antes do replay permite detectar repetição;
  snapshots de inscrição/obrigações permanecem idênticos.

As provas novas de banco passaram com a `0035` original: preenchem lacunas de prova,
sem demonstrar defeito do banco antigo. Nenhum mutante financeiro novo foi executado;
por leitura, perda de pagamento, pago removido, obrigação extra/errada ou replay com
efeito quebram respectivamente as asserções de contagem/valor/beneficiário, marcadores,
origem e snapshots. As contraprovas executáveis anteriores continuam no harness e
passaram. **Nenhum defeito novo de banco encontrado; nenhuma migration alterada.**

**Validação desta correção.** Comandos de banco em sequência, sem pgTAP simultâneo
a harness. Linhas `ok` são itens nominais, não contagem de chamadas a `assert`.

| Comando | Exit | Contagem medida |
|---|---:|---|
| `npm run db:reset` | 0 | 34 migrations, até 0035 |
| `npm run db:test` | 0 | 33 arquivos / 2.599 asserções |
| `npm run db:test:match-players` — primeira execução | 1 | 33 linhas ok; erro na fixture de reativação da membership |
| `npm run db:test:match-players` — repetição após corrigir fixture | 0 | 35 linhas ok, incluindo 6 pares novos e 2 matrizes de replay |
| `npm run db:test:refunds` | 0 | 8 linhas ok |
| `npm run db:test:matches` | 0 | 15 linhas ok |
| `npm run verify:app` — primeira execução | 1 | lint: `react-hooks/set-state-in-effect` |
| `npm run verify:app` — repetição após corrigir a limpeza do aviso | 0 | 65 arquivos / 782 unitários, 43 rotas; lint/formato/tipos/PWA/Auth/scans |
| `npm run scan:docs` | 0 | 23 arquivos, 24 hashes do manifesto |
| `npm run scan:secrets` | 0 | 511 arquivos, zero achados |
| `git diff --check` | 0 | zero erros |

A falha inicial do harness foi `group_members_removed_at_check`: a fixture tentava
reativar quem havia saído sem limpar `removed_at`. Corrigida a fixture, a repetição
passou; não foi necessário alterar função ou constraint. O primeiro `verify:app`
parou no lint por `setState` dentro de efeito; a validade do aviso passou a ser
derivada do estado exibido, sem suprimir a regra, e a repetição passou. Nas duas
execuções do harness a limpeza
passou com zero registros nas **8 tabelas** do censo automático do harness; não foi
repetido aqui o censo independente de 13 tabelas da primeira rodada.
Logs locais em `/tmp/rev97-*.log`. Alterações somente no working tree, sem add,
commit, push, consulta remota ou Playwright. Pilha Colete preservada, sem tocar
contêineres de outros projetos ou a trava externa. Conferência independente pendente.

**Navegador da correção, executado pelo coordenador fora do sandbox (06 e 07/11/2026).**

- **Rodada 1, com falha.** `test:matches:web`: 74 passed, 2 failed, ambos em `wide-chromium`.
  `racha-completo.spec.ts:178` estourou 30 s em `context.close`, e a limpeza do `finally` não
  rodou. Os 4 `auth.users` que sobraram reprovaram `rachas-v1.spec.ts:179`, `db:test` (2
  subtestes de `0016`) e `db:test:match-players` (`auth.users before proofs`). Essa cadeia está
  provada pelos logs. A causa do estouro não está: a rodada atravessou o sono do Mac, de tampa
  fechada e na bateria (`pmset`: sono às 23:34:38, despertar às 23:37:28; o build levou 993 s,
  contra 9 s acordado). É coincidência de horário, compatível, sem reprodução isolada.
- **Rodada 2, do zero e com o Mac acordado.** `db:reset` exit 0; `build:web:auth-e2e` exit 0
  (9 s); `test:matches:web` 76 passed (3,0 min), com os 12 casos novos nos dois projetos;
  `db:test` 33 arquivos / 2.599 asserções; `db:test:match-players` 35 linhas ok. `verify:app`
  exit 0 (782 unitários) sobre o mesmo código, ao fim da rodada 1.
- **Não repetidos localmente depois da correção:** `test:auth:web`, `test:privacy:web`,
  `test:cors:web`, `test:groups:web`, `test:qr:web` e `test:smoke:web`. A correção só toca a tela
  do racha; ficam para a CI.
- **Contraprova em `a257b93`, inconclusiva.** Os 12 casos falham em `mobile-chromium`, mas todos
  em `racha-completo.spec.ts:1025`, porque `match-player-error` só existe no código novo. Isso
  prova a ausência do seletor, não o comportamento.
- **Mutantes de tela no código novo, um comportamento por vez, só em `mobile-chromium`:**

| Mutante | Casos rodados | Falharam | Asserção que pegou |
|---|---:|---:|---|
| `NOT_FOUND` volta à mensagem falsa | 6 | 6 | linha 1025, texto |
| Sem reler membros e racha depois de `NOT_FOUND` | 6 | 2, só adição | linhas 1040 e 1043, candidato fora |
| Aviso some com os controles | 6 | 6 | linha 1057, aviso continua |
| Sem foco na recusa da adição | 4 | 4 | linha 1034, foco |
| Sem foco na recusa da remoção | 8 | 2, só `ACTOR_NOT_FOUND` | linha 1034, foco |
| Dispensar não limpa o aviso | 3 | 3 | linha 1062, aviso vazio |

Limites: os mutantes rodaram com o Mac dormindo entre as execuções, e o e2e não fixa a releitura
na remoção, porque os 4 casos de remoção passaram sem ela. O foco da remoção nas outras recusas
também não caiu com o segundo mutante de foco. A rodada de controle desses mutantes, na worktree
temporária e durante o sono, deu 10 passed e 2 failed (estouro de 30 s e `leave_group` 401). Ela
não foi repetida; o controle válido é a rodada 2, que tem os mesmos casos.

### Correção da conferência — PR #97 (`8926d58`, 07/11/2026)

**P2-C1.** O encaminhamento de foco das tentativas de adicionar/remover pertence agora
às listas (`Rosters`), que sobrevivem à retirada de uma linha. Cada tentativa captura
sua interação, controle focado, confirmação no lugar e contêiner da tela, obtido
pela ref das listas independentemente do foco inicial (P2-C3, abaixo). Novo intento,
cancelamento, dispensa do aviso ou desmontagem das listas invalida sua continuação. Ao concluir,
só encaminha o foco se ele ainda pertence ao controle de origem (inclusive sua troca
por `AppButton` pendente), ou ficou sem destino, e não existe outra confirmação aberta
no contêiner da própria tela do racha (escopo corrigido no P2-C2, abaixo).
`GroupConfirmation` identifica suas regiões por atributo de dados, sem bloquear ações.
A remoção deixa de focar incondicionalmente no cleanup; a conclusão usa a mesma guarda,
inclusive quando a releitura retirou a linha. Adição bem-sucedida restaura o controle
somente com essa guarda. Mensagem uniforme, releitura autorizada e aviso persistente
do P2-1/P2-2 permanecem; nenhum contrato, banco ou migration foi alterado.

**Provas de tela.** Quatro casos parametrizados em
`e2e/racha-completo.spec.ts` (adição/remoção × com/sem dispensa do aviso), previstos nos
dois projetos Chromium: o alvo sai pela Edge real, a tentativa recebe `NOT_FOUND`,
a resposta da releitura de membros fica retida, outra confirmação de remoção recebe
foco e só então a resposta é liberada. Após terminar a releitura e a continuação,
a confirmação nova deve conservar o foco. Todos os seletores do cenário já existem
em `8926d58`; por leitura, esse código deve falhar na última asserção de foco porque
a continuação antiga (e o cleanup da remoção) foca “Atualizar racha”. Contraprova nesse
SHA e execução verde da correção: não executadas pelo autor; resultado do coordenador abaixo.

**Lacuna P3 da conferência.** Nos dois casos `NOT_FOUND` de
remoção (confirmado/espera), a prova agora exige ausência tanto da confirmação quanto
da linha identificada pelo nome do alvo, antes de abrir o seletor de adição. O helper
conserva o snapshot anterior nas leituras periódicas até a releitura de membros,
impedindo que ela substitua a renovação imediata exigida após a recusa. Esses reforços
não são alegados como falhas de `8926d58`: devem detectar o mutante sem releitura,
antes mascarado pela ausência do botão já trocado pela confirmação. Não foi demonstrado
nesta sessão defeito adicional na releitura da remoção; se a versão corrigida falhar
nessas asserções, a lacuna permanece aberta e exige correção, não relaxamento da prova.

**Limite preservado.** A fragilidade anterior em `racha-completo.spec.ts:315`
permanece fora do escopo: falha em `context.close` pode impedir `cleanActors`/`db.end`.
Nenhuma nova atribuição de causa aos timeouts ou ao 401 da rodada anterior.

**Validação desta correção.** Contagens medidas nesta sessão:

| Comando | Exit | Contagem medida |
|---|---:|---|
| `npm run verify:app` — primeira execução | 2 | lint/formato aprovados; TypeScript recusou `dataSet` no `View` |
| `npm run verify:app` — após mover o atributo ao heading web existente | 0 | 65 arquivos / 782 unitários; 43 rotas; lint/formato/tipos/PWA/Auth/scans |
| `npm run scan:docs` | 0 | 23 documentos, 24 hashes do manifesto |
| `npm run scan:secrets` | 0 | 511 arquivos, zero achados |
| `git diff --check` | 0 | zero erros |

Logs locais: `/tmp/conf97-verify-app.log`, `/tmp/conf97-verify-app-final.log`,
`/tmp/conf97-scan-docs.log` e `/tmp/conf97-scan-secrets.log`. O erro de tipo foi
corrigido sem cast nem supressão: o atributo fica no elemento HTML que já recebe
foco em `GroupConfirmation`. Nenhum comando de banco foi executado nesta sessão.
Navegador, contraprova em `8926d58` e mutante sem releitura: executados pelo
coordenador, abaixo. Sem Playwright, add, commit, push, consulta remota ou acesso
a contêineres; pilha Colete e trava externa preservadas. Mudanças somente no working tree.

**Navegador da correção da conferência, executado pelo coordenador (07/11/2026, Mac acordado).**
Após `db:reset`, primeira rodada, sem repetição:

| Execução | Resultado |
|---|---|
| `test:matches:web` | exit 0, 84 passed (3,2 min), com os 4 casos de foco nos dois projetos |
| `test:groups:web` | exit 0, 121 passed + 5 skipped; `GroupConfirmation` é compartilhado |
| Contraprova: e2e novo sobre `8926d58` | 8 failed de 8, todos em `racha-completo.spec.ts:1173`, `toBeFocused` do título da confirmação nova |
| Mutante sem releitura depois de `NOT_FOUND`, sobre o código novo | 2 failed de 2 nos casos de remoção, em `:1055`, confirmação ainda presente |
| Controle sem mutante, mesmos casos e os de foco, `mobile-chromium` | 6 passed |
| `verify:app` | exit 0, 782 unitários |
| `db:test` | exit 0, 33 arquivos / 2.599 asserções |

A contraprova é comportamental: o cenário só usa seletores que já existiam em `8926d58`.
A lacuna da releitura na remoção fica fechada: o mutante que antes passava agora reprova.

### Correção da conferência restrita — PR #97 (`41ce0e5`, 07/11/2026)

**P2-C2.** A tentativa captura o ancestral `authenticated-main` das listas pela ref
do bloco de confirmados (origem corrigida no P2-C3, abaixo), antes que o envio
substitua o botão ou a releitura retire a linha. A busca de outras
confirmações fica nesse contêiner, em vez do documento inteiro. Assim, a confirmação
“Expulsar” conservada em Membros pela aba oculta não veta a restauração no racha.
O escopo estrutural independe do CSS e da implementação de visibilidade das abas.
Se o contêiner foi retirado do documento, a continuação não encaminha foco.

`focusGroupControl` aceitava somente o testID e podia escolher o primeiro homônimo
de outra tela montada. Agora aceita um contêiner opcional; a conclusão da tentativa
passa o mesmo contêiner capturado, sem fallback global quando ele não existe.
A substituição do controle com o mesmo testID também precisa pertencer a esse contêiner.
As gerações de interação, a guarda do controle focado e o veto de outra confirmação
na própria tela permanecem, preservando a proteção do P2-C1. Nenhum bloqueio global
de ações foi criado; P2-1/P2-2, releitura, avisos e provas anteriores não foram alterados.

**Prova nova.** Dois casos parametrizados em
`e2e/racha-completo.spec.ts`, adição e remoção, previstos nos dois projetos Chromium:
abrem Grupos → Membros → “Expulsar”, deixam a confirmação aberta, mudam para Agenda
pela navegação do app e abrem o racha pelo cartão. Exigem que a confirmação de Membros
continue montada no `authenticated-main` de Membros e ausente do `authenticated-main`
do racha, antes e depois da mutação bem-sucedida. O link Agenda precisa ter
`aria-current="page"`; Grupos perde esse estado ao trocar de aba, e a URL acompanha
a navegação. Não se exige `toBeHidden` nem um valor de CSS. Adição exige o foco
em “Adicionar jogador”; remoção exige o foco em “Atualizar racha”. Não há `goto` nem
reload entre a confirmação e a mutação. Todos os seletores já existem em `41ce0e5`.
Por leitura, nesse SHA a consulta global encontra a confirmação da aba inativa e veta o foco;
o teste deve falhar no `toBeFocused` final, após comprovar o sucesso da mutação e a
retirada do controle de origem. A execução da versão final, com as asserções estruturais,
fica **PENDENTE-PLAYWRIGHT**, sem alegação de reprodução em navegador pelo autor.

**Diagnóstico do navegador recebido nesta continuação (07/11/2026).** Em
`noite/codex-1.4/corr97c/resumo.txt`, o coordenador registrou `test:matches:web`
exit 1, 84 passed / 4 failed, e `test:groups:web` exit 0, 121 passed / 5 skipped.
Os quatro casos novos pararam em `toBeHidden` tanto na correção (`08-controle.log`)
quanto em `41ce0e5` (`06-antigo-aba-oculta.log`): essa contraprova era inválida,
pois não chegou ao foco. O snapshot `error-context-mobile-add.md` mostra os dois
`main`, Membros com a confirmação e Agenda com o cartão do racha.

Há também uma rodada diagnóstica em `corr97c/diag/`, executada por uma segunda sessão
de coordenação que rodava em paralelo na mesma worktree, já encerrada:
`00-spec-diag.diff` remove somente as duas asserções `toBeHidden`;
`02-correcao.log` registra exit 0, **4 passed**, e `04-antigo.log` registra exit 1,
**4 failed**, todos no `toBeFocused` final, nos dois projetos Chromium. Essa rodada
prova a diferença comportamental de foco; não executa as novas asserções estruturais
acrescentadas nesta continuação. O autor apenas leu esses logs, sem rodar Playwright.

**Mecanismo web e escopo confirmado por leitura local.** No Expo Router 57.0.17,
`build/react-navigation/bottom-tabs/views/BottomTabView.js:173–202` conserva as abas
visitadas e posiciona suas cenas com preenchimento absoluto e `zIndex` 0 (ativa) ou
−1 (inativa). `ScreenFallback.js:21–25` usa um `View` quando `screensEnabled()` é
falso. No react-native-screens 4.26.0, `src/core.ts:5–10,36–37` inicia essa flag
desligada na web; o app não chama `enableScreens`. Portanto o caminho de
`src/components/Screen.web.tsx:24–33`, que aplicaria `hidden` e `display: none`, não
é usado pelas abas. A cena inativa fica atrás da ativa e continua montada;
`toBeHidden` não mede essa sobreposição. `AuthenticatedShell.tsx:216–232` cria um
`authenticated-main` por tela; Membros e racha o usam separadamente. A confirmação
de expulsão está no primeiro, fora do segundo, como exige a correção. Não foi
necessário alterar novamente `MatchPlayerManagement.tsx` nem `GroupConfirmation.tsx`.

**Observação fora do escopo — acessibilidade da aba inativa.** O snapshot recebido
continua incluindo o `main` de Membros e sua confirmação na árvore de acessibilidade
depois que Agenda se torna ativa. A ausência efetiva de `aria-hidden` foi inferida
desse snapshot de acessibilidade, sem inspeção dos atributos do DOM. O componente `elements/Screen.js:62` do Expo Router
declara `aria-hidden={!focused}`, mas essa declaração não substitui a evidência do
navegador sobre a árvore efetivamente exposta. A exposição da tela inativa fica
registrada para investigação própria, sem correção de navegação ou acessibilidade
nesta fatia, conforme o limite desta rodada.

**Validação local da primeira correção, antes desta continuação.** Contagens
preservadas da sessão anterior:

| Comando | Exit | Contagem medida |
|---|---:|---|
| `npm run verify:app` — primeira execução | 1 | lint aprovado; formato recusou somente o e2e novo |
| `npm run verify:app` — após Prettier no e2e | 0 | 65 arquivos / 782 unitários; 43 rotas; lint/formato/tipos/PWA/Auth/scans |
| `npm run scan:docs` | 0 | 23 documentos, 24 hashes do manifesto |
| `npm run scan:secrets` | 0 | 511 arquivos, zero achados |
| `git diff --check` | 0 | zero erros |

Logs locais: `/tmp/conf97c-verify-app.log`, `/tmp/conf97c-verify-app-final.log`,
`/tmp/conf97c-scan-docs.log` e `/tmp/conf97c-scan-secrets.log`.
Navegador da versão final e regressões P2-C1/P2-1/P2-2: **PENDENTE-PLAYWRIGHT**;
o diagnóstico e a contraprova recebidos estão discriminados acima.
Sem execução de Playwright, banco, contêineres ou consulta remota; pilha Colete e
trava externa preservadas. Sem add, commit ou push; mudanças somente no working tree.
Nenhum contrato, documento normativo, dependência ou migration foi alterado.

**Validação desta continuação — asserções estruturais (07/11/2026).**

| Comando | Exit | Contagem medida |
|---|---:|---|
| `npm run verify:app` | 0 | 65 arquivos / 782 unitários; 43 rotas; lint/formato/tipos/PWA/Auth/scans; scanner de segredos: 511 arquivos |
| `npm run scan:docs` | 0 | 23 documentos; 24 entradas no manifesto |
| `git diff --check` | 0 | zero erros |

Logs: `/tmp/conf97c-structural-verify-app.log` e
`/tmp/conf97c-structural-scan-docs.log`. Nenhum Playwright, comando de banco ou
contêiner foi executado nesta continuação; sem add, commit ou push. Houve uma
consulta inicial `gh pr list` ao GitHub pelo protocolo de descoberta, um desvio
do limite desta rodada de não acessar remotos. Não houve outra consulta remota,
acesso a Supabase remoto, deploy ou serviço de produção.

**Navegador e contraprova pelo coordenador (07/11/2026).** Executados sobre a versão
final do working tree, com o Mac acordado (`caffeinate -i`). Logs em
`noite/codex-1.4/corr97c2/`, com `resumo.txt` e o diff aplicado em `00-diff.patch`.

| Execução | Exit | Resultado |
|---|---:|---|
| `npm run db:reset` | 0 | migrations até `0035` |
| `npm run build:web:auth-e2e` | 0 | build Auth |
| `npm run test:matches:web` | 0 | **88 passed**, sem repetição |
| `npm run test:groups:web` | 0 | **121 passed, 5 skipped** |
| Contraprova: árvore `41ce0e5` só com o e2e novo (`05-antigo-arvore.txt`), `--grep 'outra aba oculta'` | 1 | **4 failed**, todos em `racha-completo.spec.ts:1181`, `toBeFocused` recebeu `inactive` |
| Controle na correção, mesmo `--grep` | 0 | **4 passed** |
| `npm run verify:app` | 0 | 782 unitários |

Na contraprova, as asserções estruturais anteriores ao foco passaram em `41ce0e5`:
a falha é do veto da confirmação da aba inativa, não de seletor ou premissa. As
regressões P2-C1, P2-1 e P2-2 estão dentro dos 88 casos de `test:matches:web`.
Os itens **PENDENTE-PLAYWRIGHT** acima ficam resolvidos por esta tabela.

### Correção da terceira conferência restrita — PR #97 (`8a2f818`)

**P2-C3.** `usePlayerManagementFeedback` passa a devolver uma ref usada no `View`
já existente de confirmados em `Rosters`. Ao iniciar adição, cancelamento da adição
ou confirmação da remoção, a tentativa resolve o `authenticated-main` pelo ancestral
desse elemento das listas, sem depender de `document.activeElement`. O foco inicial
continua capturado somente para a guarda de propriedade do foco. O contêiner
capturado delimita tanto o veto por outra confirmação quanto o destino do foco;
confirmações em outras telas montadas continuam fora desse escopo (P2-C2).
A geração das listas, a guarda de foco e o veto por outra confirmação na mesma tela
permanecem (P2-C1). Desmontar as listas invalida a geração; retirar a tela do
documento impede a continuação por `isConnected`. Nenhum bloqueio global de ações,
mudança de releitura/avisos do P2-1/P2-2, banco, migration, contrato ou normativo.

**Prova nova — PENDENTE-PLAYWRIGHT.** Três casos parametrizados em
`e2e/racha-completo.spec.ts`: adição, cancelamento da adição e remoção, previstos
nos dois projetos Chromium. Após abrir e conferir o foco no título da confirmação,
o teste aguarda o controle disponível, retira o foco com `blur` e dispara um
`MouseEvent('click', { bubbles: true, cancelable: true })`, sem pressionar o ponteiro
nem focar o botão. O `PressResponder` do react-native-web 0.21.2 chama `onPress`
no clique quando `altKey === false`, valor fornecido por `MouseEvent`; um `Event`
genérico não fornece essa premissa. A avaliação retorna duas observações exigidas
como verdadeiras: foco no `body` antes do disparo e durante a captura do clique
no controle, antes do handler React. Não há outra interação após esse disparo.

Adição/remoção exigem HTTP 200, quadro atualizado e fechamento da confirmação;
a adição também confere a linha do alvo e o resultado, e a remoção a ausência da
linha. O cancelamento exige fechamento sem inscrição. Só depois o teste exige
foco em “Adicionar jogador” (adição/cancelamento) ou “Atualizar racha” (remoção).
Todos os seletores já existem em `8a2f818`: nesse SHA, por leitura, a origem no
`body` deixa `screen` nulo e a continuação retorna sem focar; o teste deve chegar
à asserção final de foco e falhar ali. **Contraprova em `8a2f818` somente com o
e2e novo, controle na correção e regressões P2-C1/P2-C2/P2-1/P2-2:
PENDENTE-PLAYWRIGHT.** Nenhuma execução de navegador ou contraprova é alegada aqui.

**Validação local desta correção.** Contagens medidas nesta sessão:

| Comando | Exit | Contagem medida |
|---|---:|---|
| `npm run verify:app` | 0 | 65 arquivos / 782 unitários; 43 rotas; lint/formato/tipos/PWA/Auth/scans |
| `npm run scan:docs` | 0 | 23 documentos; 24 hashes do manifesto |
| `npm run scan:secrets` | 0 | 511 arquivos; zero achados |
| `git diff --check` | 0 | zero erros |

Logs locais: `/tmp/conf97d-verify-app.log`, `/tmp/conf97d-scan-docs.log` e
`/tmp/conf97d-scan-secrets.log`. Sem Playwright, banco, contêineres, add, commit,
push ou consulta remota; pilha Colete e trava externa preservadas. Mudanças
somente no working tree, limitadas ao foco, às provas e a este registro operacional.

**Navegador e contraprova pelo coordenador (07/11/2026).** Executados sobre a versão
final do working tree, com `caffeinate -i`. Logs em `noite/codex-1.4/corr97d/`, com
`resumo.txt` e o diff aplicado em `00-diff.patch`.

| Execução | Exit | Resultado |
|---|---:|---|
| `npm run db:reset` | 0 | migrations até `0035` |
| `npm run build:web:auth-e2e` | 0 | build Auth |
| `npm run test:matches:web` | 0 | **94 passed**, sem repetição |
| `npm run test:groups:web` | 0 | **121 passed, 5 skipped** |
| Contraprova: árvore `8a2f818` só com o e2e novo (`05-antigo-arvore.txt`), `--grep 'foco inicial no body'` | 1 | **6 failed**, todos em `racha-completo.spec.ts:1175`, `toBeFocused` recebeu `inactive` |
| Controle na correção, mesmo `--grep` | 0 | **6 passed** |
| `npm run verify:app` | 0 | 782 unitários |

Na contraprova, as premissas anteriores ao foco final, inclusive o foco no `body`
durante o clique, passaram em `8a2f818`. As regressões P2-C1, P2-C2, P2-1 e P2-2
estão dentro dos 94 casos de `test:matches:web`. Os itens **PENDENTE-PLAYWRIGHT**
desta subseção ficam resolvidos por esta tabela.
