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
O achado de `request_data_export` continua divergência temporária, com prazo
antes de fechar o M2, na mesma migration da M2-D15 (`25` §8.2). Nenhuma RPC fora
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

## Fatia 4 — `0018_rename_group.sql` (PILOTO, 01/10/2026)

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
