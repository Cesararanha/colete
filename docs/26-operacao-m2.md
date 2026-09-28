# Operação e evidências do M2

Status deste documento: operacional. Ele não altera requisitos nem substitui
as fontes normativas `10`, `13`, `14`, `16`, `17`, `22` e `25`. Continua de
`23-operacao-m1-b.md`. Fica fora de `docs/spec-manifest.sha256` pelo mesmo
precedente de `19`–`21` e `23`: registra o que aconteceu, não é contrato
congelado.

Este documento registra as fatias do M2 à medida que entram. Por enquanto,
somente a Fatia 1.

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
| `scripts/harness-guard.mjs` | guarda dos harnesses `db:test:groups`, `db:test:export` e `db:test:idempotency`: na falha, inclusive por `unhandledRejection`, relata a causa primeiro, recusa trabalho novo por um sinal de abort, espera o trabalho em voo com prazo e, estourado o prazo, encerra as conexões do harness pelo `application_name`; só então limpa, numa conexão própria, roda o censo à parte e sai com código 1; marca e varredura dos usuários Auth de harness, que nunca apaga usuário com perfil |

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
