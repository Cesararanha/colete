# Operação e evidências do M1-B

Status deste documento: operacional. Ele não altera requisitos nem substitui
as fontes normativas `10`, `13`, `14`, `16`, `17` e `22`. Continua de
`21-operacao-m1-a.md`.

Este documento registra as quatro fatias do M1-B: as três migrations e os
controles da tela 13, que fecham a entrega visível do marco.

## Fatia 1 — `0011_worker_foundation.sql`

### O que foi entregue

| Objeto | Contrato provado |
| --- | --- |
| extensões `pg_cron` e `pg_net` | agenda versionada chama a Edge por nomes guardados no Vault, sem URL ou segredo no comando cron |
| seis linhas novas em `private.app_limits` | lease 180 s, deadline suave 120 s, máximo 8 tentativas, backoff 60–3.600 s e lote de 10 `effects` |
| `external_effects.lease_token` e constraints append-only | só `leased` carrega token/prazo; estados pendente, retryable e terminais têm combinações fechadas |
| `private.external_effect_backoff_seconds` | equal jitter determinístico entre 50% e 100% de `min(3600, 60*2^(attempts-1))` |
| `worker_acquire_external_effect` | `READ COMMITTED`, lease vencido reclassificado, `FOR UPDATE SKIP LOCKED` e ordem `next_attempt_at asc nulls first, created_at, id` |
| `worker_complete_external_effect` | row lock e barreira conjunta por ID, token, status e `lease_until > clock_timestamp()` |
| `worker_begin_job`, `worker_execute_database_job` e `worker_finish_job` | slot UTC derivado no banco, no-op pela unique do `run_key`, conclusão observável e abandono como `failed/RUN_ABANDONED` |
| `private.purge_expired_revoked_sessions` | expurgo pelo relógio do servidor e evidência apenas por contagens em `retention_runs` |
| quatro agendas `colete_v1_*` | efeitos por minuto; saúde a cada 5 min; sessões revogadas no minuto 17; idempotência às 03:23 UTC |
| Edge Function `worker`, em Deno 2/TypeScript | autenticação dedicada em tempo constante, chamadas apenas às cinco RPCs nominais e espera do lote antes da resposta |
| harness externo | três conexões PostgreSQL independentes, fakes de Auth/Storage, relógio controlado e integração apenas com a stack local |

A aquisição recebe do runtime a lista fechada de kinds cujos handlers foram
publicados. Na Fatia 1 essa lista é vazia: o loop de efeitos é executável, mas
nenhum dos cinco kinds existentes é consumido antes de a `0012` publicar seus
primeiros handlers. A suíte cria uma allowlist exclusivamente como fixture para
provar a primitiva e a desfaz ao terminar.

### Decisões de implementação

- O jitter inclusivo é calculado em segundos inteiros. Os primeiros 32 bits de
  `SHA-256(effect.id::text || attempts::text)` escolhem um ponto de
  `floor(raw/2)` até `raw`; isso torna a dispersão reproduzível sem sincronizar
  retries.
- Lease vencido com menos de oito tentativas fica imediatamente elegível para
  reconciliação. O oitavo lease vencido é a oitava falha e vai para `dead`, em
  vez de criar uma nona tentativa que contrariaria o limite.
- Os quatro comandos do catálogo cron contêm apenas
  `private.invoke_worker_cron('<job>')`. URL, publishable key e segredo de
  invocação são lidos em execução pelos nomes `worker_project_url`,
  `worker_publishable_key` e `worker_cron_secret`; ausência ou duplicidade falha
  fechado antes do HTTP.
- A Edge usa `WORKER_CRON_SECRET`, distinto do HMAC de idempotência, e só abre o
  cliente administrativo depois da comparação. O ambiente local recebe material
  de teste público construído em memória; nenhum valor remoto ou segredo real
  foi criado, lido ou versionado.
- O vetor dourado de canonicalização é executado dentro do isolate antes de
  `worker_begin_job`. Assim a prova do terceiro runtime faz parte do caminho
  agendado real, não apenas de um teste unitário em Node.
- `service_role` recebeu `EXECUTE` nominal em exatamente cinco RPCs novas. Ele
  continua sem `USAGE` no schema `private` e sem `SELECT`/DML direto nas tabelas;
  a migration não repete as revogações globais da `0004`.

### Provas e números medidos

Depois de `db:reset`, `npm run db:test` executou **658 asserções pgTAP em 10
arquivos**: as 606 anteriores mais **52** da `0011`. Todas passaram.

`npm test` executou **71 testes em 12 arquivos**. A Fatia 1 acrescentou seis
testes do runtime: segredo dedicado, vetor dourado, no-op de slot, fechamento de
run, sanitização de falha bruta e erro permanente normalizado.

`npm run db:test:worker` usou **três conexões PostgreSQL com PIDs distintos** e
passou todas as provas de saída de `22` §3.5: vencedor único; rejeição depois do
vencimento sem nova aquisição; fencing; convergência do lease; prioridade do
trabalho novo; backoff/teto/oitava tentativa; sanitização do provedor;
privilégios; lifecycle e abandono; e vetor dourado dentro da Edge local.

Três contraprovas executáveis demonstraram que os fixtures não passam por
acidente:

1. uma atualização defeituosa por apenas `(id,status)` aceitou o lease vencido
   dentro de uma transação depois revertida;
2. a mesma versão sem `lease_token` deixou o worker velho concluir a tentativa
   nova, também sob rollback;
3. a consulta com `NULLS LAST` escolheu o retry vencido antes do efeito novo,
   enquanto a RPC produtiva escolheu o efeito novo.

Depois dos harnesses, a medição no banco encontrou **zero** linha residual em
`private.external_effects`, `private.job_runs`, `private.retention_runs`,
`private.idempotency_records` e `public.profiles`.

### Configuração por ambiente

| Local | Vault/Edge hospedado | Conteúdo no repositório |
| --- | --- | --- |
| `WORKER_CRON_SECRET` sintético, construído por `start-local-supabase.mjs` | Vault: `worker_project_url`, `worker_publishable_key`, `worker_cron_secret`; Edge: `WORKER_CRON_SECRET` | somente nomes e gerador público de teste; nenhum valor real |

Nenhum Vault hospedado, secret remoto, deploy ou projeto Supabase remoto foi
acessado nesta fatia.

### O que continua fora

- handlers de Auth, Storage, build ou purge de export; entram na `0012` e na
  `0013` junto de seus produtores e reconciliação;
- `delete_account`, `request_data_export`, mudança de schema das sagas,
  `finalize_deletion`, bucket `data-exports`, ZIP e endpoint de download;
- agendas `purge_completed_deletion_requests` e `expire_data_exports`;
- textos legais, Google OAuth, rate limit produtivo, domínios de grupos/finanças,
  notificações, deploy, secrets reais e qualquer acesso remoto;
- controles de exportação/exclusão na tela 13.

## Fatia 2 — `0012_account_deletion.sql`

### O que foi entregue

| Objeto | Contrato provado |
| --- | --- |
| `delete_account` | envelope append-only, idempotência antes do lock, guard financeiro, cancelamento de build, criação da saga, denylist, perda de autoridade e enfileiramento sem avanço prematuro em uma transação |
| `private.deletion_requests` | tabela de serviço sem RLS nem DML administrativo; leitura direta anterior revogada e schema movido de forma append-only |
| `get_own_deletion_request` | projeção própria por tipo composto com somente protocolo, estado, dois instantes e booleano de falha; `completed_at` gerado como anulável e leitura preservada no shell de exclusão |
| policies de leitura | JWT antigo perde perfil, aceites e exports imediatamente; somente projeção da saga e canal de privacidade continuam funcionais |
| três handlers de efeito | `delete_data_export`, `delete_storage_object` e `delete_auth_user`, e nenhum kind sem consumidor publicado |
| reconciliação da saga | `requested → cleaning_storage → deleting_auth → finalizing → completed`, com ausência em Storage/Auth tratada como sucesso |
| `finalize_deletion` | exige Auth e objetos ausentes, deidentifica o perfil, redige a saga e conclui sem reabrir autoridade |
| retenção da saga | agenda `colete_v1_purge_completed_deletion_requests` às 03:43 UTC, `run_key` por slot e expurgo após conclusão + 90 dias com evidência só por contagens |
| harness externo | commits reais, concorrência, perda de conexão, timeout, mutação recusada pela Edge com JWT antigo, GoTrue e Storage locais e censo residual por tabela |

### Decisões de implementação

- O ledger continua guardando somente
  `deletion_request_id/logical_result='deletion_requested'`. Replays combinam
  esse outcome imutável com uma projeção fresca; estado operacional nunca vira
  payload congelado de idempotência.
- `delete_account` devolve o literal contratual `status:'requested'`, enquanto
  o trigger `after insert` executa a reconciliação dentro da mesma transação e,
  havendo Storage pendente, a linha já fica em `cleaning_storage`. O literal é
  o outcome estável de `13` §5.3; o
  estado atual vem de projeção fresca, como determina `22` §4. A asserção da
  `0012` descrita como “permanece `requested` até o worker rodar” verifica hoje
  somente o literal e deixou de ser contraprova do estado persistido. Quando
  não existe objeto de Storage conhecido, a RPC ainda cria na mesma transação o
  efeito `delete_auth_user:<request_id>`; o worker chama a reconciliação ao
  adquirir o primeiro efeito.
- O purge de cada export iniciado por `delete_account` usa
  `delete_data_export:<export_id>:<deletion_request_id>`. A deduplicação fica
  limitada à ocasião da saga: um efeito `succeeded` ou `dead` de ocasião anterior
  permanece como histórico, enquanto o pedido novo sempre ganha trabalho
  adquirível. O handler continua opaco à chave e reconcilia pelo `kind` e pelo
  `resource_id`.
- O guard `private.require_financial_deletion_substitute` é fechado e chamado
  antes da perda de autoridade. O conjunto do M1-B é vazio; migrations dos
  domínios futuros substituem a primitiva sem remover a chamada obrigatória.
- A policy do canal de privacidade usa um helper `SECURITY DEFINER` mínimo para
  resolver o perfil mesmo depois de `deletion_pending`. `authenticated` recebe
  `EXECUTE` apenas para a avaliação da policy e continua sem `USAGE` em
  `private`, portanto não consegue chamar o helper nem selecionar a saga.
- Cada handler observa o provedor antes de agir e confirma no banco sob o mesmo
  lease. O runtime usa `HEAD` com a semântica 400/404 de ausência do SDK Storage
  fixado e prefere o JWT legado de `service_role` nas APIs locais que ainda não
  aceitam `sb_secret_*`; a chave moderna continua sendo enviada somente em
  `apikey`, nunca como Bearer.
- A agenda diária usa `private.account_deletion_job_slot`, com conversão UTC
  explícita. A migration não altera `private.worker_job_slot` da `0011`.
- `service_role` passou a executar 13 RPCs públicas nominais no total, sete com
  prefixo `worker_`, e continua sem privilégio direto de tabela nos schemas da
  aplicação.

### Provas e números medidos

Depois de recriar o banco somente por migrations, `npm run db:test` executou
**723 asserções pgTAP em 11 arquivos**: as 658 anteriores mais **65** da
`0012_account_deletion.test.sql`. Todas passaram. As provas novas cobrem a
fronteira privada/projeção funcional com papel sem `BYPASSRLS`, transação
inicial ainda em `requested` com efeito Auth enfileirado, replay, conflito,
autoridade removida, prioridade sobre build, backoff, fencing, guard financeiro,
finalização, nulabilidade da projeção, retenção e censos negativos de payload.
As duas asserções acrescentadas reproduzem efeitos terminais anteriores — um
`succeeded` e um `dead` — e exigem, em cada caso, resposta `requested`, aquisição
do efeito de export da ocasião nova e conclusão integral da saga.
O censo agora procura também os valores literais do Auth UUID e do session UUID;
uma sonda sob rollback prova que o regex antigo não detectava o Auth UUID cru e
que o novo detecta a mesma linha.

`npm test` executou **80 testes em 13 arquivos**. A Fatia 2 acrescentou **nove**:
um para o contrato canônico vazio de `delete_account` e oito para os handlers.
As fronteiras de crash exercitadas foram antes do efeito, depois do efeito e
antes da confirmação, depois da confirmação commitada com resposta perdida, e
depois da finalização commitada antes da conclusão genérica do efeito. Cada
retry reobservou o estado e convergiu.

`npm run db:test:deletion` mediu **13 conexões PostgreSQL simultâneas com PIDs
distintos**. O harness provou uma saga para chamadas concorrentes, replay,
`IDEMPOTENCY_CONFLICT`, `payload_expired`, rollback por perda real da conexão,
espera limitada em 3.000 ms, retry posterior, recusa `UNAUTHENTICATED` de
`update_profile` pela Edge com o JWT emitido antes de `delete_account`, Storage
ausente na API local, Auth not-found real e finalização única.

Ao terminar, o censo mediu **zero linha** em cada uma das 15 tabelas operacionais
enumeradas: `public.profiles`, `public.policy_acceptances`,
`public.privacy_requests`, `public.data_exports`,
`private.deletion_requests`, `private.revoked_auth_sessions`,
`private.idempotency_records`, `private.external_effects`, `private.job_runs`,
`private.retention_runs`, `auth.users`, `auth.identities`, `auth.sessions`,
`auth.refresh_tokens` e `storage.objects`. O censo dinâmico de todas as tabelas
base de `public`, `private`, `auth` e `storage` confirmou que nenhuma outra
tabela mudou em relação à baseline, exceto `auth.audit_log_entries`: ela terminou
com **14 linhas**, das quais **12** foram acrescentadas pelo harness. Esse resíduo
é aceito e reportado porque a tabela pertence ao GoTrue e criar, autenticar e
apagar usuários Auth reais escreve auditoria por definição; o harness não apaga
evidência do provedor nem volta a afirmar zero global.

Os harnesses herdados de idempotência, gateway e worker também passaram. O do
worker continuou usando três conexões PostgreSQL independentes e suas três
contraprovas executáveis de fencing/prioridade permaneceram vermelhas para as
implementações defeituosas e verdes para a implementação publicada.

### Contrato normativo e ambiente

O bloco de schema em `docs/10-schema-db.md` passou a qualificar
`private.deletion_requests`, como exige `22` §4. Por decisão humana separada de
09/09/2026, a deriva pré-existente da denylist também foi corrigida no mesmo
bloco para `private.revoked_auth_sessions`. O checksum de `docs/10` foi
recalculado uma vez depois das duas linhas; o manifesto mantém 23 entradas.

Nenhum Vault hospedado, segredo remoto, deploy ou projeto Supabase remoto foi
acessado. Auth e Storage exercitados pelo harness são exclusivamente os
serviços descartáveis da stack local.

### O que continua fora

- exportação governada, bucket `data-exports`, ZIP e endpoint de download da
  Fatia 3;
- controles de exportação e exclusão na tela 13, pertencentes à Fatia 4;
- grupos, ownership e casos financeiros futuros, que estenderão o guard sem
  relaxar a transação desta fatia;
- deploy, configuração de Vault hospedado, secrets reais e qualquer acesso a
  projeto remoto.

## Fatia 3 — `0013_data_export_delivery.sql`

### O que foi entregue

| Objeto | Contrato provado |
| --- | --- |
| `request_data_export` | envelope append-only, idempotência antes do lock do perfil, criação atômica do pedido LGPD, export e efeito de build; canal aberto para `suspended|banned` e fechado para `deletion_pending` |
| `private.data_exports` | tabela de serviço sem RLS ou grants, índice parcial de um export ativo por perfil, `snapshot_at` persistido na primeira aquisição e referências da `0012` atualizadas append-only |
| `get_own_data_exports` | projeção tipada própria sem `storage_path` nem `content_digest`, isolada por titular sob papel sem `BYPASSRLS` |
| ZIP `colete-export-v1` | sete entradas fixas, ordem lexical, JSON JCS/UTF-8, método `store`, mtime constante, CRC32, SHA-256 por entrada e digest do ZIP |
| bucket `data-exports` | privado, 50 MiB, somente `application/zip`, path determinístico e zero policy de cliente |
| handlers de build/purge | lock canônico perfil→export, observação do objeto antes da ação, overwrite desabilitado, comparação de digest, publicação de `ready` só depois da leitura confirmatória, build terminal convertido em purge determinístico e Auth cercado por um único predicado de Storage |
| `consume_data_export` e Edge `data-exports` | canal para `suspended|banned`, reauth de 300 s pelo timestamp de método em `amr`, denylist antes do CAS, `ready → downloaded` antes do stream e rejeição de resposta que não seja ZIP direto |
| `expire_data_exports` | agenda `colete_v1_expire_data_exports` no minuto 7 de cada hora e reconciliação de todo `downloaded` ainda com path pela chave estável |
| harness externo | nove usuários GoTrue, seis objetos Storage, chamadas HTTP concorrentes, corrida build×exclusão, três retries de build interrompido, reconstrução real, queda pós-CAS, logout real pela Edge e censo dinâmico |

### Decisões de implementação

- As seis funções da `0012` que continham a referência textual
  `public.data_exports` são primeiro recriadas pela `0013` a partir da definição
  no catálogo. `delete_account` também deixa de fabricar `purged_at` para build
  cancelado; as demais extensões explícitas ficam listadas abaixo. Isso mantém
  as migrations entregues imutáveis e evita uma view pública de compatibilidade
  que recolocaria path e digest no schema exposto.
- O outcome idempotente contém exatamente `export_id` e
  `logical_result='data_export_requested'`. A projeção `current` é relida e
  nunca congela `queued` no livro.
- `snapshot_at` é escolhido na primeira aquisição do build e persistido no
  próprio export. Esse instante representa a primeira leitura efetiva dos dados;
  retries reutilizam o valor, permitindo reconstruir e comparar o mesmo ZIP.
- O build passou a travar perfil antes de export. A correção não recriou nem
  alterou `delete_account` da `0012`; as seis funções anteriores continuam sendo
  recriadas na `0013` somente pela mudança já existente de schema da tabela.
- `privacy-requests.json` não contém o UUID técnico do pedido. O validador e a
  projeção usam a mesma allowlist fechada de tipo, status, resposta e instantes.
- O manifesto enumera e assina as seis entradas de conteúdo; ele próprio fica
  fora da lista para evitar uma dependência circular de digest. O ZIP final
  contém também `manifest.json`, totalizando sete entradas.
- `auth.json` inclui o endereço somente quando o Auth o marcou como verificado,
  além dos nomes ordenados dos provedores. Não inclui senha, hash, token,
  refresh token, `session_id` ou metadado arbitrário.
- A Edge usa `redirect: 'error'` tanto ao validar o usuário quanto ao abrir o
  objeto. O cliente recebe bytes com `application/zip`, attachment e
  `private, no-store`; nunca recebe URL assinada, path ou digest.
- Conclusão, erro e cancelamento do leitor convergem para
  `delete_data_export:<export_id>`. Se o callback não ocorrer, a agenda horária
  cria a mesma chave para todo `downloaded` ainda com path.
- Um retry de build que encontra export `failed|expired`, perfil em exclusão ou
  `cleanup_pending` converge para o mesmo purge mesmo sem path publicado. O
  handler sonda `exports/<profile_id>/<export_id>.zip`, apaga quando presente,
  confirma a ausência e só então conclui a reconciliação. A ausência inicial do
  objeto é o mesmo sucesso reconciliado.
- `private.deletion_has_pending_storage(uuid)` é agora a única resposta para
  “ainda falta Storage nesta saga?”. A lista
  `build_data_export|delete_data_export|delete_storage_object` aparece uma vez
  nessa função; tanto `reconcile_deletion_request` quanto a guarda de aquisição
  de Auth a reutilizam, inclusive quando a saga já alcançou `deleting_auth`.
  `pending|leased|failed_retryable` de qualquer dos três kinds mantém o fence.
- Build `dead` muda o export para `failed`, libera o índice parcial para um novo
  pedido do titular e cria `delete_data_export:<export_id>`. O handler sonda o
  path determinístico mesmo sem `storage_path`; somente ausência confirmada
  grava `purged_at`.
- A política terminal de todo purge de Storage é única: a saga avança. Segurar
  `dead` em `cleaning_storage` seria um travamento permanente depois das oito
  tentativas. A coluna booleana durável
  `deletion_requests.has_operational_failure` registra o evento sem texto, path
  ou PII. `finalize_deletion` continua zerando `last_error_code`, mas não apaga
  o booleano; a projeção de cinco campos combina o marcador com retry vivo.
  Quando a ausência não foi confirmada, o export fica `failed`, conserva o path
  apenas na tabela privada para recuperação e mantém `purged_at` nulo.
- `delete_account` não marca mais `purged_at` ao cancelar `queued|building`:
  path determinístico desconhecido pelo banco ainda exige a sonda de purge. A
  constraint de estado distingue falha terminal de purge confirmado.
- A classificação HTTP é semântica em todos os handlers de Storage/Auth:
  `404` é ausência reconciliada; `401`, `403`, `429`, timeout, rede e 5xx são
  retryable; somente requisição intrinsecamente malformada é permanente.
- Lista completa de funções anteriores recriadas pela `0013` nesta versão:
  da `0011`, `public.worker_acquire_external_effect(text[])`,
  `public.worker_begin_job(text)`,
  `public.worker_execute_database_job(bigint)` e
  `private.invoke_worker_cron(text)`; da `0012`,
  `private.deletion_request_projection(uuid)`,
  `public.get_own_deletion_request()`,
  `private.reconcile_deletion_request(uuid)`,
  `public.delete_account(uuid,uuid,uuid,text,integer,integer)`,
  `public.worker_get_deletion_effect_target(uuid,uuid)`,
  `public.worker_confirm_deletion_effect(uuid,uuid)`,
  `public.finalize_deletion(uuid)` e
  `private.sync_deletion_failure_from_effect()`.
- Logout não toca o artefato. O harness chama `revoke_current_session` pela
  Edge real e confirma que o download posterior recebe 401 enquanto a linha
  continua `ready` e com path.
- `service_role` executa 18 RPCs públicas nominais no total, nove com prefixo
  `worker_`, e continua sem privilégio direto nas tabelas da aplicação.

### Provas e números medidos

Depois de recriar o banco somente por migrations, `npm run db:test` executou
**802 asserções pgTAP em 12 arquivos**. A suíte prova os cinco estados de export
ativo, snapshot persistido, canal de conta suspensa/banida, bloqueio de
`deletion_pending`, CAS one-shot, negação de sessão revogada antes de alterar a
linha, backoff futuro de Storage rate-limited, build não terminal cercando Auth,
build `dead` liberando novo pedido e criando purge, purge conhecido `dead`
chegando a `completed` sem `purged_at`, marcador durável e censos negativos,
além das garantias anteriores.

`npm test` executou **107 testes em 16 arquivos**. Os testes novos cobrem bytes
determinísticos, remoção do UUID de pedido, cinco classes de campo proibido,
reauth velha/ausente pela Edge completa, rejeição de corpo que não seja ZIP,
headers sem `Location`, instrumentação da emissão de signed URL no cliente real
de Storage, purge em conclusão/cancelamento/erro do stream e a classificação
real de `429` pela Edge como `retryable_failure`.

`npm run db:test:export` criou **nove usuários Auth**, executou **sete uploads
Storage** ao longo das jornadas e
abriu **duas requisições HTTP concorrentes** para o mesmo export: exatamente uma
recebeu 200 e a outra 410. Duas aquisições do alvo real produziram bytes
idênticos e digest
`70f384cf8105b6b3f5aaac5a94a995b6f5f5ae953b3d57e028eb79a73632bbae`.
Duas conexões independentes reproduziram a ordem adversarial do build e da
exclusão sem `40P01`; a exclusão venceu com perfil `deletion_pending` e export
`failed`. Cancelar o corpo antes de ler bytes da aplicação preservou o CAS
`downloaded` e enfileirou um único purge.

Três jornadas adicionais interromperam o build depois da escolha do path e antes
de `worker_publish_data_export`: exclusão da conta com ZIP presente, expiração
com ZIP presente e cancelamento sem upload. Os três retries enfileiraram e
executaram o purge, sondaram o path determinístico e deixaram path/digest nulos;
os dois objetos existentes foram apagados e o objeto ausente convergiu sem erro.
Na jornada de exclusão, o avatar foi reconciliado primeiro e a saga permaneceu
em `cleaning_storage` por causa do build `failed_retryable`; nenhum
`delete_auth_user` ficou adquirível. O build então morreu, criou o purge pelo
path determinístico, o ZIP foi removido e a saga chegou a `completed`. Outra
jornada deixou o purge de path conhecido em `dead` e também chegou a
`completed`, com marcador verdadeiro, erro textual redigido, path somente na
tabela privada e `purged_at` nulo. O harness de exclusão confirmou em ambos os
lados da mudança que uma conta sem objeto continua chegando a `completed` uma
única vez.

O censo dinâmico mediu todas as **46 tabelas BASE TABLE** de `public`, `private`,
`auth` e `storage` antes e depois do harness, na execução completa:

| Tabela | Antes → depois (delta) |
| --- | --- |
| `auth.audit_log_entries` | 14 → 41 (+27, resíduo aceito do GoTrue) |
| `auth.custom_oauth_providers` | 0 → 0 |
| `auth.flow_state` | 0 → 0 |
| `auth.identities` | 0 → 0 |
| `auth.instances` | 0 → 0 |
| `auth.mfa_amr_claims` | 0 → 0 |
| `auth.mfa_challenges` | 0 → 0 |
| `auth.mfa_factors` | 0 → 0 |
| `auth.oauth_authorizations` | 0 → 0 |
| `auth.oauth_client_states` | 0 → 0 |
| `auth.oauth_clients` | 0 → 0 |
| `auth.oauth_consents` | 0 → 0 |
| `auth.one_time_tokens` | 0 → 0 |
| `auth.refresh_tokens` | 0 → 0 |
| `auth.saml_providers` | 0 → 0 |
| `auth.saml_relay_states` | 0 → 0 |
| `auth.schema_migrations` | 77 → 77 |
| `auth.sessions` | 0 → 0 |
| `auth.sso_domains` | 0 → 0 |
| `auth.sso_providers` | 0 → 0 |
| `auth.users` | 0 → 0 |
| `auth.webauthn_challenges` | 0 → 0 |
| `auth.webauthn_credentials` | 0 → 0 |
| `private.allowed_proof_mime_types` | 4 → 4 |
| `private.app_limits` | 13 → 13 |
| `private.data_exports` | 0 → 0 |
| `private.deletion_requests` | 0 → 0 |
| `private.external_effects` | 0 → 0 |
| `private.idempotency_records` | 0 → 0 |
| `private.job_runs` | 0 → 0 |
| `private.policy_documents` | 0 → 0 |
| `private.retention_runs` | 0 → 0 |
| `private.revoked_auth_sessions` | 0 → 0 |
| `public.policy_acceptances` | 0 → 0 |
| `public.privacy_requests` | 0 → 0 |
| `public.profiles` | 0 → 0 |
| `storage.buckets` | 1 → 1 |
| `storage.buckets_analytics` | 0 → 0 |
| `storage.buckets_vectors` | 0 → 0 |
| `storage.iceberg_namespaces` | 0 → 0 |
| `storage.iceberg_tables` | 0 → 0 |
| `storage.migrations` | 65 → 65 |
| `storage.objects` | 0 → 0 |
| `storage.s3_multipart_uploads` | 0 → 0 |
| `storage.s3_multipart_uploads_parts` | 0 → 0 |
| `storage.vector_indexes` | 0 → 0 |

As contraprovas foram executadas em clone temporário isolado no commit
`656f288`. Falharam literalmente com `PROFILE_SUSPENDED`, `FORBIDDEN`,
`have: 2 / want: 1` para os snapshots, ausência da coluna persistida,
`privacy request ids stay outside the closed export allowlist`,
`expected [Function] to throw an error`, `expected 200 to be 410` para signed
URL e `build_data_export died with SQLSTATE 40P01`. A regeneração de tipos
produziu diff de 112 linhas (55 inserções, 57 remoções). Os testes de reauth
velha/ausente, erro de stream, censo dinâmico, queda zero-byte e cinco estados
ativos são regressões de cobertura: passavam em `656f288` quando o comportamento
correto já existia, e não foram relatados como contraprovas.

Os três testes de órfão foram aplicados separadamente a um clone temporário de
`e327865` e falharam, respectivamente, com as mensagens literais
`cancelled-after-upload: build retry did not enqueue deterministic purge`,
`expired-after-upload: build retry did not enqueue deterministic purge` e
`cancelled-without-upload: build retry did not enqueue deterministic purge`.
A contraprova de signed URL, por outro lado, **passou em `e327865`** (8/8 no
arquivo), porque é regressão de cobertura e a implementação já fazia download
direto. No mesmo clone, uma variante que emitiu em paralelo e ignorou uma signed
URL, mantendo resposta 200/ZIP sem `Location`, falhou literalmente com
`expected "vi.fn()" to not be called at all, but actually been called 1 times`;
a chamada observada foi
`/storage/v1/object/sign/data-exports/exports/profile/export.zip`.

As novas contraprovas foram aplicadas em clone temporário isolado de `a093a24`.
O ZIP órfão falhou literalmente com
`AssertionError [ERR_ASSERTION]: export-orphan: delete_auth_user became acquirable while the crashed build could still reveal an object`,
mostrando um efeito `delete_auth_user` adquirido em vez de `null`. Uma segunda
contraprova focada no estado falhou com
`export-orphan: deletion left cleaning_storage before deterministic purge completed`,
`actual: 'requested'` e `expected: 'cleaning_storage'`. O avatar falhou literalmente com
`Failed test 41: "a leased avatar purge keeps the saga in cleaning_storage after absence is confirmed"`,
`have: deleting_auth` e `want: cleaning_storage`. O controle sem objeto passou
em `a093a24` com
`ok - real Auth not-found is reconciled as success and finalizes once`, como
esperado para uma regressão de comportamento que já era correto; por isso não
existe mensagem de falha honesta contra esse commit. A prova de `dead` falhou no
mesmo clone com `have: failed_retryable` e `want: deleting_auth`. No estado
corrigido, as três jornadas chegam a `completed`.

As seis contraprovas desta revisão foram então aplicadas separadamente a um
clone temporário isolado de `ae8cfe2`. Elas falharam literalmente com:

1. `export-orphan: saga advanced after avatar purge while build was retryable`,
   com `actual: { status: 'deleting_auth', photo_url: null }` e
   `expected: { status: 'cleaning_storage', photo_url: null }`;
2. o retorno real de Storage `429` produziu `p_result: 'permanent_failure'` em
   vez de `p_result: 'retryable_failure'`;
3. `terminal build did not enqueue deterministic purge`, com `actual:
   undefined` em vez do `export_id` esperado;
4. `terminal build left export active instead of failed`, com `actual:
   'building'` e `expected: 'failed'`;
5. `known-path-dead-purge: saga did not advance after the purge effect became
   terminal`, com `actual: 'cleaning_storage'` e `expected: 'deleting_auth'`;
6. `completed deletion lost durable operational failure marker`, com `false !==
   true`.

O controle sem qualquer objeto Storage passou nos dois lados da mudança com
`ok - deletion without any Storage object still reaches completed exactly once`;
ele é regressão, não contraprova.

Os harnesses herdados também passaram: idempotência com 25 conexões, worker com
três conexões e exclusão com 13 conexões. `verify:app` mediu 14 rotas estáticas,
`scan:docs` confirmou 22 arquivos e D1–D62/N1–N28/25 telas,
`scan:secrets` verificou 188 arquivos, e `npm audit --audit-level=high` terminou
sem vulnerabilidade alta (13 vulnerabilidades moderadas reportadas pelo registry,
sem alteração de dependências nesta fatia).

Nenhum projeto Supabase remoto, deploy, Vault hospedado ou segredo real foi
acessado. Auth, Storage, Edge e Postgres exercitados são exclusivamente os
serviços descartáveis da stack local.

### O que continua fora

- controles de exportação e exclusão da tela 13, pertencentes à Fatia 4;
- validação jurídica da allowlist e designação do responsável operacional,
  gates externos anteriores ao convite do beta;
- deploy, configuração remota, secrets reais e domínios futuros do inventário.

## Fatia 4 — controles da tela 13, sem migration

### O que foi entregue

| Objeto | Contrato provado |
| --- | --- |
| `DataExportCard` | os cinco estados de `22` §6 derivados só da projeção `get_own_data_exports`: `queued|building` → **Preparando seus dados** sem download; `ready` válido → **Pronto para baixar** com validade absoluta e aviso de tentativa única; `expired` → **Export expirado** com **Gerar novo export**; `downloaded|cleanup_pending` → **Download já consumido**, novo export só depois de `purged_at`; `failed` → erro honesto, novo pedido e suporte quando a falha se repete |
| `api.requestDataExport` / `api.deleteAccount` | intenções do gateway com `request_id` único por intenção consciente, conservado em retry de transporte e em `IDEMPOTENCY_WAIT_TIMEOUT`; recusa de negócio encerra a intenção e a próxima ação cria outro ID |
| `api.downloadDataExport` | uma única tentativa contra `GET /data-exports/:id/content`, sem retry automático, sem cache (`no-store`), sem URL assinada; bytes ficam em memória e vão ao navegador por object URL revogada; `DownloadInterruptedError` nunca reabre o stream |
| reautenticação no mesmo lugar | `RECENT_REAUTH_REQUIRED` real da Edge abre o campo de senha dentro do card, foco no campo, e o sucesso retoma o download do mesmo `export_id` |
| `DeleteAccountCard` | primeiro passo explica anonimização, perda imediata, limpeza assíncrona e bloqueios; primeira confirmação abre o resumo; segunda exige checkbox explícito e botão destrutivo **Excluir minha conta**; sem a caixa, o botão continua focável, descreve o requisito por `aria-describedby`, anuncia o erro e move o foco à caixa; `FINANCIAL_SUBSTITUTE_REQUIRED` mostra a ação normativa sem contorno |
| `DeletionShellScreen` | shell restrito com protocolo, `requested|cleaning_storage|deleting_auth|finalizing` como **Exclusão em andamento**, `failed_retryable`/`has_operational_failure` como **Exclusão com atraso** com suporte, `completed` como concluído, e **Pedido registrado** quando o status deixa de ser verificável; nenhum card de domínio permanece |
| `AuthGateScreen` | ordem sessão → `get_own_deletion_request` → perfil; perfil ausente nunca significa "complete seu perfil" enquanto houver pedido; protocolo conservado localmente (`colete.deletion-protocol.v1`, somente `id` e `requested_at`) sustenta o shell sem sessão e sem recriar sessão |
| `AppCheckbox` | controle `role="checkbox"` de 48 px, alterna por toque, Enter e Espaço, erro associado e anunciado |
| `e2e/m1-b-privacy.spec.ts` | as duas jornadas contra Auth, Edge, worker agendado e Storage locais reais, com as duas provas de navegador de `22` §6 e passada axe nos dois temas |

### Decisões de implementação

- Nenhuma migration: a fatia lê apenas as duas projeções tipadas da `0012` e da
  `0013` e escreve somente pelo gateway. Os schemas Zod de
  `src/lib/privacy-schema.ts` são `strict`: uma linha que trouxesse path,
  digest, Auth ID ou tentativa seria recusada antes de chegar a uma tela.
- `ready` com `expires_at` no passado, antes da varredura horária, é mostrado
  como **Export expirado** aguardando limpeza, com **Atualizar status** e sem
  **Gerar novo export**: o índice parcial ainda conta a linha como ativa e o
  pedido receberia `EXPORT_ALREADY_PENDING`. `EXPORT_ALREADY_PENDING` nunca é
  apresentado como falha: a tela relê a projeção e mostra o estado do export
  existente.
- `cleanup_pending` só nasce de expiração ou cancelamento, nunca de download,
  mas a tabela normativa manda apresentá-lo como consumido; o texto do estado
  diz explicitamente que a tentativa única pode ter sido usada por download,
  por queda de conexão ou pelo fim do prazo.
- O botão de confirmação da exclusão não usa `disabled` nem `aria-disabled`:
  `react-native-web` sobrescreve `aria-disabled` no `Pressable` e `disabled`
  tira o botão do teclado. A regra de `15` ("botão sempre habilitado; com erro,
  foco vai ao primeiro campo inválido") é cumprida com texto adjacente
  associado e foco na caixa.
- A limpeza do protocolo local acontece nos pontos explícitos de nova
  autenticação (`LoginScreen`, `VerifyCodeScreen`) e quando um perfil válido
  volta a existir. `SIGNED_IN` do supabase-js não serve como sinal: ele também
  dispara ao refocar a aba, e apagou o protocolo no meio da prova.
- O canal de suporte continua sendo a pergunta 2 de `22` §8. A tela usa a
  formulação neutra "procure o canal de suporte do Colete", com o rótulo em um
  único ponto (`pt.support.channel`), sem e-mail, link, telefone ou formulário
  inventados.
- Dois defeitos da Fatia 3 impediam a jornada 1 e foram corrigidos aqui, com
  contraprova e teste unitário próprios, porque não exigiam decisão de contrato:
  `rpcParameters` do gateway não tinha `case 'request_data_export'` e a operação
  respondia `500 INTERNAL` pela Edge real; e os providers de Storage do worker
  só reconheciam `404` como ausência, enquanto o Storage local responde `400`
  com corpo `{"statusCode":"404","error":"not_found"}`, o que matava
  `build_data_export` e `delete_data_export` como `STORAGE_UNAVAILABLE`
  permanente na primeira tentativa. O `exists` reprova um `400` de HEAD com um
  `GET` de um byte antes de decidir. A revisão independente da Fatia 4 extraiu
  esse adaptador para `_shared/worker-providers.ts`: o worker e o harness da
  Fatia 3 agora executam exatamente a mesma implementação, em vez do antigo
  `exists` próprio que convertia qualquer `400 || 404` em ausência.

### Provas e números medidos

`npm run db:reset` recriou o banco em 28,6 s somente pelas migrations e
`npm run db:test` executou **802 asserções pgTAP em 12 arquivos**, o mesmo
número da Fatia 3, como exige uma fatia sem migration.

`npm test` executou **140 testes em 19 arquivos** (+33 testes, +3 arquivos):
os seis operations do gateway chegam à RPC com ator e HMAC e nunca com
parâmetros indefinidos; `404`, `400 error:not_found` e `400 statusCode:404` do
Storage viram ausência reconciliada, os dois últimos com a sequência `HEAD` →
`GET+range`; `400 permission_denied` é permanente; `401`, `403`, `429`, `500`,
falha de rede e erro desconhecido são retryable. Os cinco estados de apresentação do
export, inclusive `ready` vencido antes da varredura, `downloaded|cleanup_pending`
com e sem `purged_at` e `failed` repetido; o protocolo local recusa qualquer
campo além de `id` e `requested_at`; e os cinco códigos de `13` §5.3 têm texto
normativo.

`npm run test:privacy:web` executou as duas jornadas em **9,7 s** contra a stack
local (`mobile-chromium`; `wide-chromium` cobre a tela 13 pelo `m1-a`). Na
jornada de export, a página emitiu **21 requisições** à API (5 ao gateway, 11 a
RPCs de projeção, 3 ao endpoint de download), o worker real construiu e
publicou dois exports e o navegador recebeu um ZIP de **2331 bytes** começando
por `PK`. Na jornada de exclusão foram **12 requisições** (5 ao gateway, 5 a
projeções) e o worker real removeu o usuário Auth e finalizou a saga.

Prova 1 (corpo nunca contém identidade): as 33 requisições capturadas depois da
conclusão do perfil foram inspecionadas uma a uma; nenhuma URL ou corpo contém
Auth ID, `profile_id`, `session_id` de qualquer sessão da conta, e-mail, nome,
`exports/<profile_id>`, `.zip`, `input_hmac`, `storage_path`, `content_digest`
nem um hexadecimal de 64 dígitos; todo corpo para `request_data_export` e
`delete_account` tem exatamente a chave `request_id`; toda chamada de projeção
vai com corpo vazio; o download é `GET` sem corpo.

Prova 2 (queda depois de iniciar não dispara retry): o segundo export foi
baixado com o Storage respondendo pela Edge real e a conexão do navegador
derrubada depois do CAS (`route.fetch` + `abort('connectionreset')`). A tela
mostrou "A transferência foi interrompida" e **Download já consumido**, o
banco ficou `downloaded`, o endpoint recebeu **exatamente 1** requisição para
aquele export mesmo 1,5 s depois, nenhum evento de download ocorreu e o botão
**Baixar agora** não voltou nem após recarregar. A prova de reauth usou a Edge
real: com `amr` envelhecido para 10 min por `auth.mfa_amr_claims` e token
renovado, a primeira chamada recebeu `403 RECENT_REAUTH_REQUIRED` sem alterar a
linha `ready`; a senha confirmada no card retomou o mesmo `export_id` e a
segunda chamada entregou o arquivo.

Retry de transporte: o pedido inicial de export atravessou **4 corpos com o
mesmo `request_id`** (3 tentativas automáticas abortadas + a manual que
venceu); o pedido consciente seguinte nasceu com outro ID. Na exclusão, **4
corpos** compartilharam o ID através da queda e da recusa
`FINANCIAL_SUBSTITUTE_REQUIRED`, e a confirmação real veio com ID novo. O
arquivo não deixou rastro: zero entradas de `/functions/` no Cache API e nenhum
valor de `localStorage` menciona o `export_id`.

Acessibilidade: a passada axe rodou **seis vezes** sem violação (perfil com os
dois cards em claro e escuro, resumo da exclusão, shell da exclusão em claro e
escuro), todos os alvos visíveis (links, botões, campos e a caixa de seleção)
mediram ≥ 44 × 44 px e nenhuma página apresentou rolagem horizontal. Com zoom
CSS de 200%, as ações das duas jornadas permaneceram visíveis e a página
continuou sem rolagem horizontal. Foco gerenciado provado: campo de senha após
`RECENT_REAUTH_REQUIRED`, resumo final ao abrir a segunda etapa e caixa de
seleção após tentar confirmar sem marcá-la. A ordem de tabulação percorreu senha
→ mostrar senha → confirmar → cancelar e caixa → confirmar → voltar, sem
armadilha; Espaço alterna a caixa pelo teclado. Os dois erros têm uma única live
region, `id` estável, `aria-invalid=true` e `aria-describedby` que sobrevive a
foco/desfoco; a senha valida no blur e em tempo real depois do primeiro erro.
A recusa de senha incorreta usa a mesma associação e devolve o foco ao campo,
sem criar um segundo alerta geral.
A árvore ARIA automatizada prova essa estrutura, mas não substitui nem é
registrada como passada de VoiceOver, TalkBack ou NVDA.

`npm run test:auth:web` continuou verde (8 testes, 9,9 s) depois de escopar
quatro localizadores `status`/`alert` ao card correspondente: a live region
do export passou a existir na mesma página. Os harnesses herdados passaram:
idempotência, gateway, worker, exclusão e export. `verify:app` mediu 14 rotas
estáticas, `scan:docs` confirmou 22 arquivos, `scan:secrets` verificou 203
arquivos e `npm audit --audit-level=high` terminou sem vulnerabilidade alta (13
moderadas, sem alteração de dependências).

Contraprovas: sem o `case 'request_data_export'`, `gateway.test.ts` falhou em
`request_data_export reaches its RPC with the actor and HMAC, never undefined`
(6/7), e a Edge real respondeu literalmente
`{"error":{"code":"INTERNAL","message":"The request could not be completed."}}`;
sem a classificação do `400 not_found`, `worker-provider.test.ts` falhou em
`reads a Storage 400 whose body says not_found as reconciled absence` e o
worker real deixou `build_data_export|dead|1|STORAGE_UNAVAILABLE` com o export
`failed`. A revisão independente executou mais cinco mutações: `404` tratado
como erro e os dois formatos de `400 not_found` recusados produziram
`expected [] to have a length of 1 but got 0`; `permission_denied` tratado como
ausência produziu `expected confirmations length 0, received 1`; tornar
`401|403|429|500` permanentes produziu o diff
`retryable_failure → permanent_failure` nos quatro testes; e tornar falha de
rede/erro desconhecido permanentes produziu o mesmo diff nos dois testes. Antes
de trocar `SIGNED_IN` pelos pontos explícitos de login, a
jornada 2 falhou após `page.reload()` mostrando **Complete seu perfil** em vez
de **Pedido registrado**.

Nenhum projeto Supabase remoto, deploy, Vault hospedado ou segredo real foi
acessado.

### Divergências encontradas na fatia 4

- `completed` é inobservável pelo titular: `finalize_deletion` zera
  `profiles.auth_user_id` no mesmo commit em que grava `completed`, e
  `get_own_deletion_request` faz `join` por `auth_user_id = auth.uid()`. A
  projeção devolve conjunto vazio a partir daí; a tela implementa o estado
  concluído, mas na prática o titular vê **Pedido registrado** (não
  verificável). A `0014` corrige a promessa incompatível de `22` §6 sem mudar a
  tela.
- O e2e precisa apagar a linha de `private.job_runs` do minuto corrente entre
  acordar o worker duas vezes: a agenda de `process_external_effects` é um run
  por minuto, e nenhuma saga de teste cabe nessa cadência.
- O edge runtime local não recarregou `worker/index.ts` com a política
  `per_worker`; foi preciso `docker restart supabase_edge_runtime_colete`. Na
  CI a stack nasce limpa.

### O que continua fora

- Google OAuth, vínculo/desvínculo e `avatars`/`photo_url`, mesmo com a tela
  13 de `11` mencionando o vínculo: contratos independentes por `22` §7;
- textos legais, aceite, rate limit do gateway, grupos, ownership e casos
  financeiros;
- entrega do arquivo em alvo nativo: `deliverBlobToBrowser` é web; sem
  `document` a função devolve `false` e a tentativa única já foi consumida;
- o canal real de suporte e o responsável operacional.

## Correções de review — `0014_worker_slot_and_gate.sql`

### O que foi corrigido

- `private.worker_job_slot` passou a resolver, em uma única implementação, os
  seis jobs publicados. O cálculo converte o instante para `timestamp` UTC
  antes de truncar dia, hora ou minuto e volta a `timestamptz` com UTC
  explícito; a função é `stable`, não `immutable`.
- `worker_begin_job` e `invoke_worker_cron` usam somente o resolvedor canônico.
  Os adaptadores `account_deletion_job_slot` e `data_export_job_slot` foram
  removidos para não conservar três implementações do mesmo conceito.
- O gancho de elegibilidade de `delete_auth_user` admite o pedido `completed`.
  Se o isolate cai depois de `finalize_deletion` e antes da conclusão genérica
  do efeito, o lease vencido volta a ser adquirido, o target devolve
  `action:'none'` e o efeito termina em `succeeded` sem repetir Auth.
- `22` §3.3 registra o gancho de elegibilidade por domínio e §6 registra que
  `completed` é inobservável pelo titular. A nota operacional da Fatia 2 fixa
  que o literal `status:'requested'` da RPC não representa necessariamente o
  estado já reconciliado da linha.

### Contraprovas contra `4bcb4c0`

As duas provas foram executadas em clone temporário isolado, recriado somente
pelas migrations `0001`–`0013`. Com `SET TimeZone='Asia/Kathmandu'`, a prova dos
seis jobs falhou literalmente em:

```text
# Failed test 3: "all six jobs keep their UTC slot under Asia/Kathmandu: purge_expired_revoked_sessions"
#         have: 2026-09-07 17:17:00+05:45
#         want: 2026-09-07 17:02:00+05:45
# Failed test 4: "all six jobs keep their UTC slot under Asia/Kathmandu: purge_expired_idempotency_outcomes"
#         have: 2026-09-07 03:23:00+05:45
#         want: 2026-09-06 09:08:00+05:45
```

A saga sem Storage adquiriu Auth, confirmou sua ausência e commitou
`completed`; depois do vencimento forçado do lease, a base antiga falhou
literalmente em:

```text
# Failed test 4: "a lease expired after completed is reacquired instead of stranded retryable"
```

O estado do titular já era `completed`; a falha afirma o efeito não-terminal,
que é o defeito de higiene da fila.

### Provas e números medidos

Depois de `db:reset`, `npm run db:test` executou **822 asserções pgTAP em 13
arquivos**: 20 asserções novas verificam a função única, os seis slots sob
`Asia/Kathmandu`, o enum fechado e a saga completa de lease vencido. Os cinco
harnesses passaram: idempotência com 25 conexões, gateway, worker com três
conexões, exclusão com 13 conexões e exportação. Os censos terminaram sem
resíduo operacional; somente `auth.audit_log_entries`, trilha própria do
GoTrue, conservou o resíduo já aceito.

`verify:app` passou com **140 testes em 19 arquivos** e 14 rotas estáticas. O
fluxo Auth passou 8 testes e pulou 2 duplicatas por projeto; o fluxo da tela 13
passou 2 e pulou 2 pela mesma matriz. `scan:docs` confirmou 22 documentos,
`scan:secrets` verificou 216 arquivos e `npm audit --audit-level=high` terminou
sem vulnerabilidade alta ou crítica, mantendo as 13 moderadas fora do escopo.

A auditoria do workflow encontrou os dez scripts de teste do `package.json` e
nenhuma ausência: `test`, três `test:*`, `db:test` e cinco `db:test:*`. O
manifesto continua com 23 entradas; somente o hash de `22` mudou, e o hash de
`10` permaneceu
`03d041b9a91a5ce5cd087daec655b9962163f8393becb58e53326625de3c9535`.

Nenhum projeto Supabase remoto, deploy, Vault hospedado ou segredo real foi
acessado.

## Correções pós-fatia — consultas privadas presas ao ciclo da sessão

Esta correção não tem migration. Ela registra três defeitos da mesma classe,
achados depois da fatia 4: uma leitura privada do app que não estava amarrada
ao ciclo de vida da sessão Auth.

### Defeitos encontrados

1. **Requisição anônima depois do logout.** O `onSuccess` do logout chama
   `queryClient.resetQueries()`, que refaz toda consulta ativa. A consulta
   `own-data-exports` do `DataExportCard` não tinha `enabled` ligado à sessão e
   usava a sessão implícita do supabase-js. Sem sessão, o supabase-js envia a
   chave publicável como `Authorization`, e toda execução mandava
   `POST /rest/v1/rpc/get_own_data_exports`, recebendo `401` com
   `42501 permission denied for function`. O `resetQueries` é o gatilho; o
   defeito é a consulta não depender da sessão.
2. **Dado da conta anterior no cache.** O handler de Auth do gate só removia
   `own-profile` e `deletion-request` no `SIGNED_OUT`. O export ficava no cache
   da aba para a próxima conta. A revisão independente mostrou o efeito na tela
   do `main`: depois de um logout em outra aba, a segunda conta chegou a
   `/perfil` na terceira tentativa e o card mostrou "Preparando seus dados", que
   era o export da primeira conta.
3. **Assinatura de Auth só no gate.** A única chamada a `onAuthStateChange`
   vivia no `AuthGateScreen`. Um login feito em `/entrar` depois de um logout em
   outra aba não era observado: o gate lia do cache uma sessão `null` ainda
   fresca e mandava a pessoa de volta a `/entrar`.

### O que foi corrigido

- `SessionLifecycle`, montado em `app/_layout.tsx`, é a única assinatura de
  Auth do app e vive tanto quanto o cache de consultas. O build de smoke não se
  inscreve, porque não tem configuração do Supabase.
- Toda leitura privada fica sob a raiz de chaves `['private']` e passa por
  `usePrivateQuery`. A consulta só roda com sessão utilizável e lê o token do
  Auth na hora da chamada; sem token, lança `UNAUTHENTICATED` sem enviar nada.
  `getOwnDataExports` passou a mandar o token explícito, como as outras duas
  projeções.
- `applySessionChange` remove tudo sob `['private']` no logout ou na troca de
  pessoa, antes de publicar a nova sessão. A renovação de token da mesma pessoa
  preserva o cache. A remoção também cancela o fetch em voo: `removeQueries`
  destrói a consulta, e a destruição chama `cancel({ silent: true })`.
- Cada sessão publicada abre uma nova geração. Uma leitura da sessão iniciada
  antes da última publicação devolve a sessão publicada, e não o próprio
  resultado, que pode ser da pessoa anterior.
- Quando a sessão não se confirma numa leitura privada, o gate e o card de
  export mostram "Não foi possível confirmar sua sessão", separado do aviso de
  rede, com "Tentar de novo".

**Mudança de desenho em relação ao PR #31.** O #31 derivava o token do estado
de sessão já estabelecido no render do gate. Agora o token é relido do Auth na
hora de cada chamada. O caminho novo falha fechado: sem sessão legível, nenhuma
requisição sai. A regressão do #31 só reage a `_getSessionToken` e não exercita
essa releitura, por isso ela ganhou um teste próprio.

### Correções da revisão independente

- O observador de PostgREST compara em memória o `sub` do JWT com o Auth user
  id da conta que saiu e registra só booleanos e contagens. No M1-A, falha se
  alguma requisição depois do logout carregar o JWT dessa conta, e prova que a
  comparação está viva exigindo ao menos uma requisição dela antes do logout.
  No M1-B, a projeção retida precisa carregar o JWT da segunda conta.
- O `cancelQueries` redundante saiu de `clearPrivateQueries`.
- O teste do M1-B `a private query whose call-time session read fails sends
  nothing and recovers` nega uma única leitura de sessão feita por
  `auth.getSession()` fora de `_getSessionToken`, depois de "Atualizar status".
  Ele afirma que nenhuma projeção sai, que o card mostra o aviso de sessão e não
  o de rede, e que "Tentar de novo" recupera o estado com uma única projeção
  carregando o JWT da conta.

### Contraprovas

Todas as mutações abaixo foram temporárias e revertidas antes do commit.

Com uma requisição injetada depois do logout do M1-A, carregando o JWT da conta
que saiu, a asserção antiga passou e a nova falhou literalmente em:

```text
[rest-authorization] 9 PostgREST requests before logout (9 with a user JWT); 1 after logout (0 without a user JWT)
[rest-authorization-account] 9 PostgREST requests before logout with the JWT of the account that left; 1 of 1 after logout
Error: PostgREST requests with the JWT of the account that left, after logout: 9 PostgREST requests before logout with the JWT of the account that left; 1 of 1 after logout
+   "POST /rest/v1/rpc/get_own_deletion_request",
```

No M1-B, comparar a projeção retida com a primeira conta, em vez da segunda,
falhou com `Received: [false]`: o predicado distingue as contas, o que
`carriesUserJwt` sozinho não fazia.

Sem o contador de geração, dois testes unitários falharam literalmente em:

```text
× never lets a read started before a published change overwrite it
AssertionError: expected 'user-a' to be 'user-b' // Object.is equality
× never lets a stale read bring a session back after sign-out
AssertionError: expected { …(2) } to be null
```

O teste da releitura falhou nas duas mutações. Com o card de volta ao aviso de
rede, recebeu `"Não foi possível falar com o serviçoEntre novamente para
continuar com segurança.Tentar de novo"`. Com o token capturado no render, como
no #31, a negação nunca atuou e o aviso de sessão não apareceu
(`element(s) not found`).

### Provas e números medidos

Depois de `db:reset`, `npm run db:test` executou **822 asserções pgTAP em 13
arquivos**, sem mudança, porque a correção não toca o banco. Os cinco harnesses
passaram: idempotência com 25 conexões, gateway, worker com três conexões,
exclusão com 13 conexões e exportação. Os censos terminaram sem resíduo
operacional; somente `auth.audit_log_entries`, trilha própria do GoTrue,
conservou o resíduo já aceito (12 linhas na exclusão, 27 na exportação).

`verify:app` passou com **153 testes em 20 arquivos** e 14 rotas estáticas;
`private-queries.test.ts` tem 10 testes. O fluxo Auth passou 8 testes e pulou 2
duplicatas por projeto. O fluxo da tela 13 passou 4 e pulou 4 pela mesma
matriz. O smoke do PWA passou 6. `scan:docs` confirmou 22 documentos,
`scan:secrets` verificou 210 arquivos e `npm audit --audit-level=high` terminou
sem vulnerabilidade alta ou crítica, mantendo as 13 moderadas fora do escopo.

Os observadores registraram, em todas as execuções: no M1-A,
`9 before (9 with a user JWT); 0 after logout (0 without a user JWT)` e
`9 ... with the JWT of the account that left; 0 of 0 after logout`; no M1-B,
`6 before (6 with a user JWT); 5 after logout (0 without a user JWT)`.

Os specs afetados (`m1-a-auth.spec.ts` e `m1-b-privacy.spec.ts`, inteiros)
rodaram em duas séries de dez execuções seguidas, em processos separados. Na
primeira série, 19 das 20 passaram. Na execução 1 do M1-B, o teste novo estourou
o timeout de 60 s na limpeza, com o `DELETE /auth/v1/admin/users` ainda
pendente, depois que todas as asserções do corpo já tinham passado. O arquivo
inteiro levou 6,6 min, contra cerca de 14 s nas outras execuções. Entre
17:56:56Z e 18:03:20Z, o Postgres local não registrou nenhum disparo do
`pg_cron`, que roda a cada minuto, e o GoTrue não registrou nenhuma requisição:
a VM do Docker ficou parada nesse intervalo. A segunda série rodou sobre a
árvore final, com o bundle recompilado, e as 20 execuções passaram:
`m1-a-auth.spec.ts` com 8 passed e 2 skipped, e `m1-b-privacy.spec.ts` com
4 passed e 4 skipped, todas as dez vezes, com as contagens dos observadores
idênticas.

Nenhum documento normativo mudou e o manifesto não foi tocado. Nenhum projeto
Supabase remoto, deploy, Vault hospedado ou segredo real foi acessado.

## Correção pós-marco: `PGRST303` intermitente e Supabase CLI 2.118.0

### Achado

O run `36212852999` da CI reprovou um teste de browser com um 401 rápido numa
leitura do PostgREST, e a investigação de 2026-09-27 reproduziu localmente
recusas `PGRST303` (“JWT issued at future”) de tokens recém-emitidos. A pilha
local e a CI usavam o PostgREST 16.1, trazido pela Supabase CLI 2.116.0; o log
da CI `36299157833` baixa `postgrest:v16.1`. Que o 401 do run `36212852999`
seja esse mesmo `PGRST303` é inferência: o log não guardou o corpo da resposta.

### Mecanismo

No PostgREST 16.1 (`src/library/PostgREST/Auth/Jwt.hs`, linhas 56–72), o
`iat` é recusado quando passa de “agora” mais uma tolerância fixa de 30 s, sem
configuração. O “agora” vinha de um relógio em cache (`mkAutoUpdate`,
`src/library/PostgREST/AppState.hs`, linha 81), que fica velho depois de um
período sem tráfego: a primeira requisição depois da pausa compara o `iat` com
um instante antigo e o recusa. A correção da 16.1 (PR #5159) não bastou; a
issue #5196 registrou o sintoma, e o PR #5208, entregue na 16.3, removeu o
cache e passou a ler o relógio a cada requisição (`AppState.hs`, linha 79, na
tag `v16.3`). A tolerância de 30 s é a mesma nas duas versões. A CLI 2.117.0
traz o PostgREST 16.2, e a 2.118.0, o 16.3.

### Decisão

Decisão humana de 2026-09-27: fixar a Supabase CLI em `2.118.0` exata, e não
“a mais nova”, e não acrescentar nova tentativa de 401 no app. A branch
`fix/jwt-issued-at-future` faz a troca em `package.json` e `package-lock.json`,
e o `19-operacao-m0-a.md` registra a versão nova. No `package-lock.json`, além
de `version`, `resolved` e `integrity` da CLI e dos oito binários, muda a faixa
de `jose` declarada pelo pacote `supabase`, de `^6.2.9` para `^6.2.10`; o
`jose` instalado continua na 6.2.10, que satisfaz as duas faixas.

### Números

Medidos em 2026-09-27 na pilha local, com uma sonda que assina tokens HS256
com o segredo local, `role=authenticated` e `sub` aleatório, e lê
`GET /rest/v1/profiles` pelo Kong. Cada execução são 16 ciclos de 35 s sem
tráfego seguidos de uma rajada de 16 requisições com `iat` igual ao instante do
host: 256 requisições.

| PostgREST (CLI) | Execuções | `PGRST303` | Forma |
| --- | --- | --- | --- |
| 16.1 (2.116.0) | 3 | **16**, **14** e **16** de 256 | 1 ou 2 recusas por ciclo, nas primeiras requisições depois da pausa |
| 16.3 (2.118.0) | 6 | **0**, **0**, **16**, **0**, **0** e **0** de 256 | as 16 da terceira execução num único ciclo, a rajada inteira no mesmo segundo |

As 16 recusas da 16.3 não têm a forma do defeito corrigido: recusar a rajada
inteira exige que o relógio do contêiner estivesse mais de 30 s atrás do host
naquele instante, e a 16.3 lê o relógio a cada requisição. Um amostrador do
relógio da VM do Docker contra o do host, uma vez por segundo, não registrou
desvio acima de 0,028 s nas três execuções seguintes da 16.3 nem acima de 2 s
nas três da 16.1.

A causa daquele ciclo foi verificada pela revisão independente do #38 e está
no ambiente de medição, não no PostgREST nem no app:

- o log de energia do macOS (`pmset -g log`) registra o Mac entrando em sono
  às 18:08:22 (-03), por 159 s, até 18:11:01; o ciclo recusado aparece no Kong
  às 21:08:29 UTC, 18:08:29 em -03, 7 s depois do início do sono. A rajada
  recusada da tentativa descartada, às 20:31:28 UTC, caiu 5 s depois de outro
  sono, iniciado às 17:31:23 (-03) e encerrado às 17:39:42. Nenhuma das janelas
  com 0 recusas, nas duas versões, teve sono;
- a sonda assina o `iat` com o relógio do host, e o PostgREST o valida com o
  relógio da VM do Docker. A leitura da revisão é que o relógio da VM, que
  também dá o horário do Kong, parou durante o sono, e o do host não: ao
  acordar, os 16 `iat` do ciclo estavam cerca de 159 s no futuro para o
  PostgREST, bem além da tolerância de 30 s. Esse mecanismo é inferência; a
  coincidência de horário nos dois casos recusados e a ausência de sono nas
  janelas sem recusa são medidas;
- no fluxo real, o token vem do GoTrue, na mesma VM que o PostgREST, e os dois
  leem o mesmo relógio. Uma sonda da revisão com login por senha no GoTrue
  local e rajadas de 16 leituras de `profiles` depois de 35 s sem tráfego, em
  seis execuções de 16 ciclos, teve 0 `PGRST303` em 1536 requisições, com o
  host de 0,002 s a 0,993 s à frente do `iat`. O Mac não dormiu durante essa
  série; que o sono também não afete o fluxo real continua inferência, coerente
  com o mecanismo acima.

Deslocamento do `iat`, três vezes cada: na 16.3, +29 s e +30 s dão 200 e +31 s
dá 401 `PGRST303`; na 16.1, +29 s dá 200, +30 s dá 401 em duas de três e +31 s
dá 401. A tolerância é a mesma; na 16.1 o relógio em cache come parte dela.

Com a 2.118.0, a validação completa do `AGENTS.md` §5 passou, e as três suítes
de browser rodaram 10 vezes seguidas cada, todas verdes e sem `PGRST303` nos
logs: `test:auth:web` 8 testes, 9,8–10,2 s; `test:privacy:web` 4, 13,6–13,8 s;
`test:smoke:web` 6, 1,7–1,9 s.

O observador do `profiles` em `waitForProfileGate`
(`e2e/m1-a-auth.spec.ts`) esperava só uma resposta ok e ficava cego a uma
recusa. Ele passou a capturar a primeira resposta, como o da exclusão, e a
afirmá-la na chegada com status e corpo, token redigido. Contraprova com
`page.route` devolvendo uma vez `401 PGRST303` no primeiro `profiles`: o
observador antigo esperou até o timeout de 60 s, sem corpo; o novo falhou em
2 s com `GET /rest/v1/profiles returned 401: {"code":"PGRST303",…}`.

A revisão do #38 mostrou que o observador novo ainda deixava resíduo: a
promessa criada antes do clique só recebia tratador no `await`, depois da
navegação. Quando o primeiro `profiles` chegava recusado, a rejeição ficava sem
tratador, o Playwright a tomava como falha do teste e fechava as fixtures com
o corpo ainda rodando, e o `finally` encontrava o `request` fechado. O
seguimento (`fix/e2e-observer-followup`) anexa o tratador na mesma instrução
que cria o observador, como o `25` §2 exige das promessas da barreira, por
`handledObserver` (`e2e/support/observers.ts`): a mesma promessa continua
rejeitando no `await` do teste, com a própria mensagem. Ele vale para os
observadores de resposta criados antes da ação que observam e esperados depois
dela: os dois de `waitForProfileGate` em `e2e/m1-a-auth.spec.ts`
(`firstProfileGate` e `reloadedProfileGate`) e `projectionAfterRequest` em
`e2e/m1-b-privacy.spec.ts`. Contraprova, com a mesma injeção de um
`401 PGRST303` no primeiro `profiles`, no teste “creates a real account…” em
`mobile-chromium`: em `main`, o comando saiu com código 1 em 2,7 s de parede,
com o corpo, seguido de `apiRequestContext.get: Target page, context or
browser has been closed`, e ficou um usuário `auth-e2e-*` em `auth.users`,
removido à mão; com o tratador, saiu com código 1 em 1,8 s, com a mesma
mensagem, sem `has been closed`, e `auth.users` terminou com 0 linhas.

### Checagem antes do deploy

- [ ] O projeto hospedado roda PostgREST ≥ 16.3.

## Manifesto de especificação

Este documento fica fora de `docs/spec-manifest.sha256`, pelo mesmo precedente
de `19`, `20` e `21`. A baseline continua com 23 entradas e inclui o plano
normativo `22`; criar `23` não altera nenhum checksum de especificação.

## Comandos locais

```sh
npm run db:reset
npm run db:test
npm run db:test:idempotency
npm run db:test:gateway
npm run db:test:worker
npm run db:test:deletion
npm run db:test:export
npm run verify:app
npm run build:web:auth-e2e
npm run test:auth:web
npm run test:privacy:web
npm run scan:docs
npm run scan:secrets
npm run audit:high
git diff --check
```

O job `Database security` da CI executa **seis passos de banco**: pgTAP,
idempotência, gateway, worker, exclusão e exportação. Depois instala o Chromium
e executa os fluxos de autenticação e dos controles da tela 13. A auditoria de
scripts confirmou que todos os dez scripts de teste do `package.json` aparecem
no workflow: `test`, os três `test:*`, `db:test` e os cinco `db:test:*`; não há
ausência a justificar.
Os cinco nomes de job continuam `App quality`, `PWA export`,
`Database security`, `Repository guardrails` e `PWA smoke`.

## Exceção datada de auditoria — decisão humana de 02/10/2026

### Alerta, conferência e decisão

O alerta [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
(CVE-2026-85393) classifica como alta a aceitação de elementos extras em
`DigestAlgorithm` na verificação RSA PKCS#1 v1.5 do `node-forge` até 1.4.0.
A conferência anterior à mudança usou `origin/main` em `eb66c7b`, instalação por
`npm ci` e export de produção por `npm run build:web`.

Saída completa de `npm ls node-forge` (omitido somente o diretório local):

```text
colete@0.0.1
└─┬ expo@57.0.18
  └─┬ @expo/cli@57.0.20
    ├─┬ @expo/code-signing-certificates@0.0.6
    │ └── node-forge@1.4.0 deduped
    └── node-forge@1.4.0
```

O pacote está na cadeia de **produção** do npm: `expo` é dependência de
produção e a entrada de `node-forge` no lockfile não tem `dev: true`.
Isso não o coloca no app publicado: nessa cadeia ele atende à CLI e à geração
de certificados usados pelas ferramentas do Expo. Não se usou `--omit`.

O export terminou com 1.028 módulos web, 14 rotas estáticas e o bundle
`entry-53a5285187afc6d0b1dbb31977ca0941.js` de 2,1 MB. A busca foi:

```sh
rg -n 'node-forge|DigestAlgorithm|emsaPkcs1v15|digestFromOid|forge\.pki|forge\.asn1|forge\.md|_modPow|pki\.rsa' dist supabase/functions
```

Saída: **nenhuma linha**, código 1, zero ocorrências tanto no PWA exportado
quanto no código das Edge Functions. Uma segunda busca por literais presentes
em `node-forge/lib/rsa.js` e `lib/pkcs1.js` — `DigestInfo.DigestAlgorithm`,
`Invalid RSAES-OAEP`, `Encryption block is invalid` e
`Unknown message digest algorithm` — também terminou sem ocorrência.

`npm view node-forge versions --json` terminou em:

```text
"1.3.1", "1.3.2", "1.3.3", "1.4.0"
```

A API oficial `gh api /advisories/GHSA-86w9-cpqp-85rv` respondeu
`severity: high`, `vulnerable_version_range: <= 1.4.0` e
`first_patched_version: null`. Nenhuma versão corrigida estava publicada.
O fixture versionado conserva a saída integral de `npm audit --json`:
21 registros, 17 moderados e quatro altos. Os quatro altos são o alerta direto
em `node-forge` e sua propagação a `@expo/code-signing-certificates`,
`@expo/cli` e `expo`; não são quatro alertas distintos.

César Aranha decidiu em 02/10/2026, pelo AGENTS §8, aceitar **somente** esse ID,
por 14 dias, condicionado à ausência no app publicado comprovada acima.
`audit-exceptions.json` registra ID, pacote, motivo, evidência, decisor e
`expiresOn: 2026-10-16`. A exceção vence **no início de 16/10/2026 UTC**;
não há tolerância adicional nem renovação automática.

### Mecanismo, provas e contraprovas

`audit:high` conserva a consulta integral com `--audit-level=high` e avalia o
JSON no script versionado. As causas dos registros transitivos são resolvidas
por `via`, e a autorização exige simultaneamente o ID e o pacote. Alertas
moderados continuam fora do limiar. Qualquer outro alerta alto ou crítico,
causa desconhecida ou erro de consulta reprova. Entrada vencida ou órfã
reprova mesmo sem outro alerta alto e a mensagem identifica a entrada.

`npm run test:audit` executa o CLI real em diretório descartável com um
processo npm que devolve o fixture. Não existe bypass no script produtivo.
As quatro provas exigidas verificam códigos de saída:

| Caso | Código exigido e observado |
| --- | --- |
| ID listado dentro do prazo | 0; sem a entrada, 1 |
| Mesma entrada vencida | 1, com ID e mensagem de vencimento |
| Outro alerta alto, inclusive no mesmo pacote | 1, com ID não autorizado |
| Exceção órfã | 1, com ID e mensagem de remoção |

Dois testes adicionais cobrem alerta crítico, erro do audit, pacote divergente
e causa desconhecida ao lado da causa permitida. As três mutações temporárias
retiraram a guarda de vencimento, retiraram a guarda de órfão e autorizaram todo
alerta do pacote em vez do ID. Cada mutação reprovou a suíte; restaurado o
script, os seis testes passaram. Nenhuma mutação foi conservada.

### Validação e procedimento ao vencer

A validação completa do AGENTS §5 passou, incluindo os quatro harnesses M2:
**1.194 asserções pgTAP em 17 arquivos**, nove harnesses de integração,
**193 testes unitários em 22 arquivos**, Auth com oito testes efetivos e dois
ignorados, privacidade com quatro efetivos e quatro ignorados, e smoke com seis.
`scan:docs` confirmou 23 arquivos; `scan:secrets` verificou 239 arquivos.
Os censos dos harnesses não deixaram registro operacional nem objeto Storage;
a trilha própria `auth.audit_log_entries` mantém o resíduo aceito do GoTrue.
O banco foi recriado exclusivamente pelas migrations `0001`–`0018`.

O comando público `audit:high` conserva o nome; `test:audit` foi acrescentado ao
`package.json`, ao AGENTS §5 e ao job `Database security`. Os cinco jobs e o
limiar alto/crítico permanecem. Nenhuma dependência, migration ou documento
normativo foi alterado; o manifesto não mudou. Nenhum projeto Supabase remoto,
deploy ou segredo real foi acessado.

Quando vencer, a CI deve reprovar. Conferir novamente o registry e o alerta;
havendo correção, atualizar somente `node-forge` por caminho compatível ou
`overrides`, remover a entrada e repetir conferência e validação. Se o alerta
sumir antes, a guarda de órfão exige a mesma remoção. Sem correção, parar para
nova decisão humana: esta autorização não permite estender o prazo, aceitar
outro ID, omitir dependências nem desligar o job.

## Exceção de braces e correção de ciclos — decisão humana de 03/10/2026

Trabalho próprio a partir de `origin/main` em `922f12a`, sem alterar o PR #52.
O alerta [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
afeta `braces <= 3.0.3` por exaustão da pilha em padrões profundamente aninhados.
`npm view braces version versions --json` respondeu `version: 3.0.3`, com a
lista publicada terminando em `3.0.0`, `3.0.1`, `3.0.2`, `3.0.3`.
`gh api /advisories/GHSA-vfj7-8cjw-p6xm` confirmou:

```json
{"first_patched_version":null,"package":{"ecosystem":"npm","name":"braces"},"vulnerable_version_range":"<= 3.0.3"}
```

Não há versão corrigida publicada. O `fixAvailable` do npm sugere Expo 44.0.6,
uma troca major; essa sugestão não foi aplicada.

Após `npm ci`, `npm ls braces` respondeu (omitido somente o diretório local):

```text
colete@0.0.1
└─┬ expo@57.0.18
  └─┬ @expo/cli@57.0.20
    └─┬ @expo/metro-file-map@57.0.2
      └─┬ micromatch@4.0.8
        └── braces@3.0.3
```

É dependência transitiva de **produção na classificação npm**: `expo` está em
`dependencies` e a entrada de `braces` no lockfile não tem `dev: true`.
Esse caminho serve à ferramenta de build. O export por `npm run build:web`
terminou com **1.041 módulos web**, **19 rotas estáticas** e
`entry-6804320f8678cf25db176ede12c521bd.js` de 2,2 MB. A busca foi:

```sh
rg -n -o 'node_modules/braces|npm:braces|micromatch|expanded array length exceeds range limit|encloseBrace|CHAR_LEFT_CURLY_BRACE|CHAR_ZERO_WIDTH_NOBREAK_SPACE' dist supabase/functions
```

Saída: nenhuma linha, código 1, **zero ocorrências** no PWA exportado e nas
Edge Functions. Os literais e identificadores foram conferidos no código
instalado de `braces/lib/parse.js` e `lib/expand.js`. A busca genérica pela
palavra `braces` encontrou somente uma mensagem do Helmet sobre envolver filhos
em chaves; isso não é inclusão do pacote.

Com essa prova, aplica-se a decisão humana de César Aranha de 03/10/2026,
AGENTS §8: exceção somente para esse GHSA e pacote, até o início de
**16/10/2026 UTC**, sem renovação automática. Dependências e lockfile não mudam.

### Defeito do filtro e correção autorizada

A captura do relatório de 03/10/2026 está preservada integralmente em
`scripts/fixtures/audit-high-2026-10-03.json`: **36 registros**, 16 moderados,
20 altos e zero críticos. A captura não promete reprodução byte a byte de
consultas posteriores: a revisão #53 encontrou variação de `effects` e
`fixAvailable` em dez registros, com `severity`, `via` e `nodes` idênticos. O fixture anterior de `node-forge` foi preservado.
Os altos têm dois advisories reais: `node-forge` e `braces`, com propagação por
dependências. Há ciclos no grafo Metro/React Native. Ao revisitar um pacote no
mesmo caminho, `roots` fabricava uma causa alta desconhecida. Mesmo simulando
a exceção de `braces`, restavam **36 erros** desses ciclos.

A decisão humana de 03/10/2026 autorizou a correção no mesmo PR: somente a
volta do ciclo retorna uma lista vazia. O conjunto de visitados continua local
ao caminho; os outros ramos ainda são percorridos. Pacote ausente ou com `via`
inválido continua causa alta desconhecida. Ciclo puro sem advisory real continua
reprovando por `sem causa identificável`. ID exato, pacote, validade e guarda de
exceção órfã permanecem iguais.

### Provas, contraprova e validação

`npm run test:audit`: **12 testes, 12 aprovados, zero falhas**. Os seis anteriores
permanecem, inclusive `causa desconhecida não desaparece ao lado da causa
permitida`, sem alteração. Os seis novos exercitam o mesmo CLI com npm
substituído por fixture: ciclo com advisory autorizado; mesmo ciclo sem exceção
citando GHSA; ciclo puro alto e crítico; ciclo ao lado de pacote ausente; ciclo
ao lado de pacote com `via` inválido; relatório real passando somente com as
duas exceções.

Contraprova: desfeita temporariamente apenas a correção em `roots`, executou-se:

```sh
node --test scripts/test-audit-high.mjs
```

```text
✖ ciclo A↔B com advisory real coberto por exceção passa
✖ ciclo puro sem advisory reprova por falta de causa identificável
✖ relatório real de 03/10 passa somente com as duas exceções
tests 12; pass 9; fail 3
```

Código 1. A revisão #53 mediu os três casos reprovando com `roots` antigo;
a Faxina A repetiu a suíte inteira em cópia descartável, com 9 aprovados e
3 reprovados (`faxina-a-cp11-roots-suite.log`). O código do repositório
não foi alterado nessa contraprova; os 12 testes passam com a correção.
`node scripts/verify-docs.mjs` passou com 23 arquivos; `git diff --check` passou.
Não se executou Prettier em `docs/`. Conforme o escopo autorizado desta tarefa,
não se subiu a pilha local nem se acessou contêiner, Supabase remoto, deploy ou
segredo real. A validação de banco fica para os jobs existentes da CI.

Saída de `npm run audit:high` antes da mudança (código 1):

```text
Alerta high não autorizado: @expo/cli (metro).
Alerta high não autorizado: GHSA-vfj7-8cjw-p6xm (braces).
Alerta high não autorizado: @expo/cli (metro-config).
Alerta high não autorizado: @expo/cli (metro-transform-worker).
Alerta high não autorizado: @expo/metro (metro).
Alerta high não autorizado: @expo/metro (metro-config).
Alerta high não autorizado: @expo/metro (metro-transform-worker).
Alerta high não autorizado: @expo/metro-config (metro).
Alerta high não autorizado: @expo/metro-config (metro-config).
Alerta high não autorizado: @expo/metro-config (metro-transform-worker).
Alerta high não autorizado: @react-native/community-cli-plugin (metro-config).
Alerta high não autorizado: @react-native/community-cli-plugin (metro).
Alerta high não autorizado: @react-native/metro-config (metro-config).
Alerta high não autorizado: @react-native/metro-config (metro).
Alerta high não autorizado: @react-native/virtualized-lists (metro-config).
Alerta high não autorizado: @react-native/virtualized-lists (metro).
Alerta high não autorizado: @react-native/virtualized-lists (@react-native/virtualized-lists).
Alerta high não autorizado: expo (metro).
Alerta high não autorizado: expo (metro-config).
Alerta high não autorizado: expo (metro-transform-worker).
Alerta high não autorizado: metro (metro).
Alerta high não autorizado: metro-config (metro-config).
Alerta high não autorizado: metro-config (metro).
Alerta high não autorizado: metro-transform-worker (metro).
Alerta high não autorizado: metro-transform-worker (metro-transform-worker).
Alerta high não autorizado: react-native (metro-config).
Alerta high não autorizado: react-native (metro).
Alerta high não autorizado: react-native (react-native).
Alerta high não autorizado: react-native-reanimated (metro-config).
Alerta high não autorizado: react-native-reanimated (metro).
Alerta high não autorizado: react-native-reanimated (react-native).
Alerta high não autorizado: react-native-screens (metro-config).
Alerta high não autorizado: react-native-screens (metro).
Alerta high não autorizado: react-native-screens (react-native).
Alerta high não autorizado: react-native-worklets (metro-config).
Alerta high não autorizado: react-native-worklets (metro).
Alerta high não autorizado: react-native-worklets (react-native).
```

Depois da correção e da exceção, código 0:

```text
Audit aprovado: nenhum alerta alto ou crítico fora das 2 exceções ativas.
```


### Faxina A — precisão dos registros de auditoria, 05/10/2026

A ausência de literais de braces no bundle é a evidência registrada nas buscas,
com a limitação observada na revisão #53: uma lista dos módulos do Metro seria
uma prova mais forte para exceções futuras. Não se alteraram dependências nem
as duas exceções produtivas. `test:audit` agora usa cópias sintéticas das
exceções com vencimento fixo em 2099 e data explícita/controlada; seis
execuções (15/10/2026, 16/10/2026 e 01/01/2027, com arquivo de exceções normal
e vazio em cópia descartável) aprovaram 12/12 cada. Reintroduzir relógio real
e prazo produtivo reprova 3 testes; reintroduzir a leitura do arquivo vazio
reprova 8. O prazo de `audit:high` continua inalterado.

## Segurança de dependências — decisão humana de 06/10/2026

Tarefa própria a partir de `origin/main` em `178a591`, depois da confirmação
`gh pr view 57 --json state`: `MERGED`. Branch `chore/audit-2026-10`, worktree
`~/dev/sec-audit`. César autorizou pelo AGENTS §8 patches/overrides mínimos
para pacotes corrigidos e exceção por 14 dias somente para pacotes sem patch
com ausência comprovada no PWA exportado e nas Edge Functions. Major de
qualquer dependência direta e pacote sem patch presente nesses artefatos
continuam gates humanos. Nenhum major foi aplicado.

### Relatório, caminhos e decisão por advisory

`npm audit --json` antes das mudanças: **38 registros, 23 high, 15 moderate,
zero critical** (exit 1 esperado). Os 23 registros high têm somente os quatro
advisories de origem abaixo. Os `first_patched_version` foram consultados na
API oficial `gh api /advisories/<GHSA>`, além de `npm view <pacote> versions
--json`; não foram inferidos da sugestão `fixAvailable` do npm.

| GHSA (high) | Pacote instalado → final | Caminho confirmado por `npm ls --all` | Classificação npm | first_patched_version | Decisão / validade |
| --- | --- | --- | --- | --- | --- |
| [GHSA-vc2v-76pw-4v95](https://github.com/advisories/GHSA-vc2v-76pw-4v95) | compression 1.8.1 → 1.8.2 | expo 57.0.18 → @expo/cli 57.0.20 → compression; serve 14.2.6 → compression | produção via Expo e desenvolvimento via serve | 1.8.2 | override exato 1.8.2; sem exceção |
| [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | source-map-js 1.2.1 → 1.2.2 | expo 57.0.18 → @expo/metro-config 57.0.12 → postcss 8.5.26 → source-map-js | produção no lockfile; ferramenta de build | 1.2.2 | override exato 1.2.2; sem exceção |
| [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | node-forge 1.4.0 | expo 57.0.18 → @expo/cli 57.0.20 → node-forge; também via @expo/code-signing-certificates 0.0.6 | produção no lockfile; ferramenta da CLI | null | exceção renovada até 2026-10-20 |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | braces 3.0.3 | expo 57.0.18 → @expo/cli 57.0.20 → @expo/metro-file-map 57.0.2 → micromatch 4.0.8 → braces | produção no lockfile; ferramenta de build | null | exceção renovada até 2026-10-20 |

Os outros **19 registros high**, propagados por `via` e conferidos também por
`npm ls --all`, são: `@expo/cli`, `@expo/code-signing-certificates`,
`@expo/metro`, `@expo/metro-config`, `@expo/metro-file-map`,
`@react-native/community-cli-plugin`, `@react-native/metro-config`,
`@react-native/virtualized-lists`, `expo`, `metro`, `metro-config`,
`metro-file-map`, `metro-transform-worker`, `micromatch`, `react-native`,
`react-native-reanimated`, `react-native-screens`, `react-native-worklets` e
`serve`. São a propagação das mesmas causas, inclusive ciclos Metro/React
Native; não apareceu outro GHSA high/critical. `serve` é dependência direta de
desenvolvimento; as demais cadeias têm caminho por dependência de produção.
Alertas moderados permanecem fora do limiar e do escopo desta correção.

Após cada atualização, separadamente, passaram `npm ci` limpo,
`npm run verify:app`, `npm run build:web` e `npm run build:web:smoke`.
`verify:app` mediu **197 testes unitários em 23 arquivos**, todos aprovados.
A comparação estrutural do lockfile com `origin/main` encontrou somente
`node_modules/compression` e `node_modules/source-map-js` diferentes.
Diff do lockfile: **11 linhas adicionadas, seis removidas**, em duas entradas.
Compression atualiza versão, tarball, integrity e funding, e acrescenta a
referência a `destroy: 1.2.0`, cuja entrada já existia e permanece idêntica;
source-map-js atualiza somente versão, tarball e integrity. Nenhuma outra
entrada foi criada, removida ou alterada; todas as dependências diretas
conservam suas versões.

### Ausência dos dois pacotes sem patch

`npm view` continua terminando em `node-forge 1.4.0` e `braces 3.0.3`.
Os dois advisories oficiais continuam com `first_patched_version: null`.
Não se aplicou a sugestão de downgrade major do Expo feita pelo npm.

Para complementar a busca por texto com prova do grafo real, um
`metro.config.cjs` temporário usou `getDefaultConfig(__dirname)` de
`expo/metro-config`, preservou o hook anterior e observou
`serializer.experimentalSerializerHook(graph, delta)`. Em cada chamada,
registrou `graph.transformOptions.platform`, o ambiente de transformação e
`[...graph.dependencies.keys()]`, ordenados e relativos ao repositório.
Executou-se **`npm run build:web`**, sem flag de smoke, e a configuração foi
removida imediatamente. Nenhum script de build ou código do app mudou.

As listas completas estão em
[evidence/sec-audit/metro-modules-2026-10-06.json](evidence/sec-audit/metro-modules-2026-10-06.json):
**1.049 módulos web/client e 1.102 web/node**. O segundo grafo cobre a
renderização estática, além do cliente. Em ambos, zero caminhos correspondem
à fronteira de pacote `node_modules/(node-forge|braces)/`. Esses números são
as cardinalidades do grafo, não o contador de progresso impresso pelo Metro.
Contraprova do detector em cópias das listas: acrescentar
`node_modules/node-forge/index.js` ou `node_modules/braces/index.js` produz
uma detecção em cada grafo; as quatro inclusões sintéticas foram detectadas.
Nenhuma inclusão foi feita no app ou no artefato versionado.

O export instrumentado e o export normal anterior produziram o mesmo bundle
`entry-0254db1eaf66b70e813d4800944eb7b1.js` de **2,2 MB**, com **21 rotas
estáticas**. A busca refeita em `dist` e `supabase/functions` usou:

```sh
rg -n -o 'node-forge|DigestAlgorithm|emsaPkcs1v15|digestFromOid|forge\.pki|forge\.asn1|forge\.md|_modPow|pki\.rsa|DigestInfo.DigestAlgorithm|Invalid RSAES-OAEP|Encryption block is invalid|Unknown message digest algorithm|node_modules/braces|npm:braces|micromatch|expanded array length exceeds range limit|encloseBrace|CHAR_LEFT_CURLY_BRACE|CHAR_ZERO_WIDTH_NOBREAK_SPACE' dist supabase/functions
```

Saída: **zero ocorrências, exit 1 esperado**. Uma inspeção dos imports pela
AST TypeScript, excluindo arquivos `*.test.ts`, encontrou **19 arquivos
produtivos, 52 imports e zero imports não relativos** nas Edge Functions.
Não há cadeia externa de pacote nesses imports que contradiga a busca.

Com essas provas, as duas entradas de `audit-exceptions.json` foram renovadas
pela decisão humana de 06/10/2026 para **2026-10-20**, 14 dias a partir da
data da decisão. O filtro considera a exceção vencida no início de
20/10/2026 UTC; não há tolerância nem renovação automática. As duas evidências
e o decisor foram atualizados. `scripts/test-audit-high.mjs` e seus fixtures
permaneceram byte a byte idênticos.

Após os patches, a auditoria mediu **36 registros: 20 high, 16 moderate e
zero critical**. `serve` deixou de ser high e conserva suas causas moderadas;
as únicas causas high restantes são node-forge e braces. `test:audit` passou
com **12 testes, 12 aprovados, zero falhas**; `audit:high` respondeu:
`Audit aprovado: nenhum alerta alto ou crítico fora das 2 exceções ativas.`

### Validação final desta tarefa

O banco foi recriado exclusivamente pelas **20 migrations** commitadas.
`db:test`: **1.259 asserções pgTAP, 19 arquivos, PASS**. Os dez harnesses
obrigatórios passaram: idempotency, gateway, worker, deletion, export,
invites, groups, membership, rename e members. `auth.users` estava em
**zero antes e depois** da validação. Browsers **1×**, sem retry: Auth
8 aprovados/2 skips preexistentes; privacidade 4 aprovados/4 skips preexistentes;
grupos 62 aprovados; smoke 6 aprovados. Total: **80 aprovações, seis skips
preexistentes, zero falhas**. Grupos completou em 175,165 s (tempo do comando).

Nenhum documento normativo, migration, teste, workflow ou código do app foi
alterado. O manifesto permanece intacto. Não se executou Prettier para
reescrever documentos. Nenhum projeto Supabase remoto, deploy ou serviço de
produção foi acessado. Não se alterou contêiner de outro projeto. As escaladas
foram solicitadas para comandos específicos; nenhuma aprovação foi negada
nesta retomada. Progresso e logs de execução identificados em
`~/colete-noite/progresso-sec-audit.md` e `/private/tmp/colete-*`.

Censo final adicional: **storage.objects=0 e zero papéis-sonda**. Os censos
embutidos nos dez harnesses passaram; a auditoria própria do GoTrue conserva
somente o resíduo sintético aceito pelos harnesses. Nenhum segredo, e-mail ou
OTP foi incluído no diff, na documentação ou na evidência de módulos.

AGENTS §5 completo: todos os comandos terminaram com exit 0, inclusive
`verify:app` final, `scan:docs` (23 arquivos), `scan:secrets` (271 arquivos),
`test:audit`, `audit:high` e `git diff --check`. Sem alteração no manifesto.

## Auditoria por momento — decisão humana de 07/10/2026

A decisão de César de 07/10/2026 substitui a política de 06/10/2026.
O PR #60 foi abandonado após três rodadas de revisão: não foi possível provar
com segurança tudo que chega ao app publicado, pois transformadores de build
podem injetar código sem rastro. O #60 foi fechado sem merge, conservando a branch.
Não se classifica pacote como publicado para decidir a trava.
`scripts/audit-high.mjs` permanece intacto: todo high/critical reprova, salvo
exceção datada, com as mesmas verificações de vencimento e entrada órfã.

Em PR, `scripts/audit-needed.mjs` compara base e head pela diferença de três
pontos, com detecção de renomes desabilitada para verificar os dois caminhos.
A lista protegida, ampliada pelas decisões técnicas do planejador de 08/10/2026,
vale em qualquer pasta: `package.json`, `package-lock.json`, `npm-shrinkwrap.json`,
`.npmrc`, `.nvmrc`, `.node-version`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`,
`deno.json`, `deno.jsonc`, `import_map.json`, `deno.lock`, `audit-exceptions.json`,
`scripts/audit-high.mjs`, `scripts/test-audit-high.mjs`, `scripts/audit-needed.mjs`,
`scripts/test-audit-needed.mjs`, `scripts/fixtures/audit-*`, `patches/**`,
`.github/workflows/**` e `.github/actions/**`. Os nomes valem em qualquer pasta;
os caminhos estruturados também valem sob subpastas. A extensão é conservadora,
mesmo quando a configuração atual não usa outro gerenciador ou workspace.

Base/head ausente ou inválido, base diferente de `main`, erro do git, saída
vazia/inválida, árvore do head indisponível e evento não reconhecido exigem
auditoria. A árvore Git inteira do head é lida com `ls-tree -r -z`: link protegido
herdado exige auditoria mesmo quando só um .md muda. Symlinks internos, externos
e dos diretórios protegidos exigem auditoria sem seguir seus alvos.
O workflow busca a cópia do seletor de `origin/main` e a executa fora da árvore
do PR. Se o seletor não existe na base, como neste #61, ou o git não permite
obtê-lo, o fallback escreve `required=true` sem executar o head. A base diferente
de main exige auditoria antes dessa busca. O log informa o motivo ou a dispensa;
sem `GITHUB_OUTPUT`, informa auditoria exigida e nenhuma saída gravada, coerente
com a condição do workflow (`'' != 'false'`).
`Repository guardrails` continua em todo PR, conservando os cinco jobs;
`test:audit` roda sempre. Localmente, mesmo fora da lista, o agente executa e
relata `audit:high`, mas não interrompe a fatia por esse alerta.

### Procedimento diário e rodada quinzenal

`.github/workflows/dependency-audit.yml` executa sobre `main`, diariamente
às 06:17 UTC (03:17 em America/Maceio), e por `workflow_dispatch`, com `npm ci`
e `audit:high`. Actions fixadas por SHA, somente `contents: read`, sem segredos
e sem trigger de push. Em `validation.yml`, a auditoria só roda em PR: não roda
no push em main, no agendamento semanal nem no workflow_dispatch desse workflow.
O workflow_dispatch de `dependency-audit.yml` sempre audita main.
César, dono do projeto, confere a execução diária no GitHub Actions e registra
qualquer alerta novo. Falha de consulta ou instalação é investigada como falha
de execução; não equivale a audit aprovado.

Critical novo é tratado no mesmo dia, mediante patch mínimo ou decisão humana
expressa. High novo entra na rodada quinzenal de dependências: conferir advisory,
versão corrigida, caminho por `npm ls`, prova e validade das exceções, corrigir
por patch/minor autorizado e validar a fatia. Referência da rodada: 07/10/2026;
próximas em 21/10 e 04/11. Uma exceção nunca se renova automaticamente; ausência
de patch, major ou presença no artefato exige decisão humana. As exceções desta
rodada vencem no início de 06/11/2026 UTC. César aceitou que um alerta novo não
impeça merge de trabalho que não altera dependências ou a trava.

### Alertas e lockfile conferidos em 07/10/2026

Auditoria inicial: **38 registros, 21 high, um critical e 16 moderate**.
Os quatro advisories de origem eram os esperados; nenhuma outra causa
high/critical apareceu. Após os patches: **36 registros, 20 high, zero
critical e 16 moderate**. As únicas causas high restantes são node-forge
e braces, com exceções até 2026-11-06.

| Alerta | Correção ou exceção | Validade |
| --- | --- | --- |
| GHSA-pqg4-j6r4-53mv (critical, shell-quote) | 1.10.0 → 1.11.0, override escopado a react-devtools-core 6.1.5 | corrigido; sem exceção |
| [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) (high, sharp) | dependência direta 0.35.4 → 0.35.5; advisory/API oficial confirmam primeira versão corrigida 0.35.5 | corrigido; sem exceção |
| GHSA-86w9-cpqp-85rv (high, node-forge) | 1.4.0, sem versão corrigida no registry/advisory; exceção humana datada | 2026-11-06 |
| GHSA-vfj7-8cjw-p6xm (high, braces) | 3.0.3, sem versão corrigida no registry/advisory; exceção humana datada | 2026-11-06 |

O lockfile alterou a referência de sharp na raiz e somente as **28 entradas**
abaixo. Não criou nem removeu entradas. Cada `resolved` e `integrity` foi
comparado com `npm view <pacote>@<versão> dist --json`: **28/28 conferidos**.
Os scripts publicados de sharp 0.35.4 e 0.35.5 são idênticos, sem `install`
ou `postinstall` em ambas as versões. `npm ci` limpo passou com Node 24.20.0
e npm 11.19.0. Versão/tarball/integrity são atualizados em todas as entradas;
sharp também passa a referenciar os novos binários e libvips.

| Entrada (prefixo `node_modules/`) | Antes | Depois |
| --- | --- | --- |
| `@img/sharp-darwin-arm64` | 0.35.4 | 0.35.5 |
| `@img/sharp-darwin-x64` | 0.35.4 | 0.35.5 |
| `@img/sharp-freebsd-wasm32` | 0.35.4 | 0.35.5 |
| `@img/sharp-libvips-darwin-arm64` | 1.3.3 | 1.3.4 |
| `@img/sharp-libvips-darwin-x64` | 1.3.3 | 1.3.4 |
| `@img/sharp-libvips-linux-arm` | 1.3.3 | 1.3.4 |
| `@img/sharp-libvips-linux-arm64` | 1.3.3 | 1.3.4 |
| `@img/sharp-libvips-linux-ppc64` | 1.3.3 | 1.3.4 |
| `@img/sharp-libvips-linux-riscv64` | 1.3.3 | 1.3.4 |
| `@img/sharp-libvips-linux-s390x` | 1.3.3 | 1.3.4 |
| `@img/sharp-libvips-linux-x64` | 1.3.3 | 1.3.4 |
| `@img/sharp-libvips-linuxmusl-arm64` | 1.3.3 | 1.3.4 |
| `@img/sharp-libvips-linuxmusl-x64` | 1.3.3 | 1.3.4 |
| `@img/sharp-linux-arm` | 0.35.4 | 0.35.5 |
| `@img/sharp-linux-arm64` | 0.35.4 | 0.35.5 |
| `@img/sharp-linux-ppc64` | 0.35.4 | 0.35.5 |
| `@img/sharp-linux-riscv64` | 0.35.4 | 0.35.5 |
| `@img/sharp-linux-s390x` | 0.35.4 | 0.35.5 |
| `@img/sharp-linux-x64` | 0.35.4 | 0.35.5 |
| `@img/sharp-linuxmusl-arm64` | 0.35.4 | 0.35.5 |
| `@img/sharp-linuxmusl-x64` | 0.35.4 | 0.35.5 |
| `@img/sharp-wasm32` | 0.35.4 | 0.35.5 |
| `@img/sharp-webcontainers-wasm32` | 0.35.4 | 0.35.5 |
| `@img/sharp-win32-arm64` | 0.35.4 | 0.35.5 |
| `@img/sharp-win32-ia32` | 0.35.4 | 0.35.5 |
| `@img/sharp-win32-x64` | 0.35.4 | 0.35.5 |
| `sharp` | 0.35.4 | 0.35.5 |
| `shell-quote` | 1.10.0 | 1.11.0 |

`npm ls --all` confirmou: Expo 57.0.18 → @expo/cli 57.0.20 →
node-forge 1.4.0 (também por @expo/code-signing-certificates 0.0.6);
@expo/metro-file-map 57.0.2 → micromatch 4.0.8 → braces 3.0.3.
`npm view <pacote> versions --json` não encontrou patch posterior;
a API oficial dos dois advisories retornou `first_patched_version: null`.

Após `build:web` normal, a busca abaixo em `dist` e `supabase/functions`
terminou com **zero ocorrências, exit 1 esperado**:

```sh
rg -n -o 'node-forge|DigestAlgorithm|emsaPkcs1v15|digestFromOid|forge\.pki|forge\.asn1|forge\.md|_modPow|pki\.rsa|DigestInfo.DigestAlgorithm|Invalid RSAES-OAEP|Encryption block is invalid|Unknown message digest algorithm|node_modules/braces|npm:braces|micromatch|expanded array length exceeds range limit|encloseBrace|CHAR_LEFT_CURLY_BRACE|CHAR_ZERO_WIDTH_NOBREAK_SPACE' dist supabase/functions
```

Essa busca textual é a evidência refeita para a exceção humana, não uma
classificação completa do código que transformadores podem injetar. A limitação
explica o abandono do #60; a trava conserva o limiar global e a exceção datada.
Relatórios de registry, scripts, npm ls e buscas estão em
`~/colete-noite/audit-timing-*`; nenhum resultado anterior foi usado como
medição desta rodada.

### Provas do seletor e validação final desta rodada

`test:audit`: **33 testes aprovados**, sendo 12 da trava preservada e 21 do
seletor. Cobrem app/banco/docs dispensados, cada caminho protegido exigido,
renomes para dentro/fora da lista com git real, base ausente, erro/exceção do
git, saída vazia e evento diferente de pull_request. Em cópias isoladas da
fonte final, os mutantes “dispensar sempre”, “dispensar quando git falha” e
“omitir package-lock.json” terminaram com **exit 1**, cada um.

Dois commits temporários locais, desfeitos após a prova, exercitaram o CLI,
`GITHUB_EVENT_PATH`, `GITHUB_OUTPUT` e a condição idêntica à do workflow. Não
são execuções GitHub; a CI do PR final verifica separadamente o passo exigido.
Base local comum: `8e889f0b658fd1c1bce5b2f42521f8e27007a4d7`.

| Commit temporário | Único arquivo alterado | Resultado do seletor | Passo audit:high |
| --- | --- | --- | --- |
| `6bebdbe426f6dac1432f484bf8b497018b197410` | `audit-timing-proof.md` | `required=false`, dispensa explícita no log | não invocado |
| `9a2191eac46099cef68658ffe922912d35f3fc28` | `package.json` | `required=true`, arquivo protegido no log | invocado, exit 0 |

Reset recriou somente pelas **20 migrations**, em **25,150 s**. pgTAP:
**1.259 asserções em 19 arquivos, PASS**. Passaram os dez harnesses de banco:
idempotency, gateway, worker, deletion, export, invites, groups, membership,
rename e members. `verify:app` passou em **16,425 s**, com **197 unitários em
23 arquivos**, lint, formato, tipos, build web, PWA, configuração Auth e scans.
`npm ci` limpo, `build:web`, `build:web:smoke`, `scan:docs`, `scan:secrets`,
`test:audit`, `audit:high` e `git diff --check` passaram. O manifesto recalcula
somente docs/25; AGENTS e docs/23 foram editados manualmente. Nenhum formatador
executado em docs/ ou AGENTS.

Browsers **1×**, sem retry: Auth **8 aprovados/2 skips preexistentes**;
privacidade **4 aprovados/4 skips preexistentes**; grupos **62 aprovados**;
smoke **6 aprovados**. Total: **80 aprovações, seis skips preexistentes, zero
falhas**. Grupos medidos em **171,926 s**. Nenhum trace de falha foi gerado;
o executor estava preparado para preservá-lo antes de outra suíte.

`auth.users`: **0 antes e depois**. Censo final: **54 tabelas**, somente as
cinco tabelas de configuração com linhas; **storage.objects=0 e zero
papéis-sonda**. Foram medidos e removidos, após confirmar Auth vazio, **1.764
registros de auth.audit_log_entries e dois auth.flow_state**, exclusivamente
sintéticos desta rodada após db:reset. Censos e logs em
`~/colete-noite/audit-timing-*`; contraprovas em
`~/colete-noite/audit-timing-contraprovas.md`.

Nenhum segredo, dado pessoal real, OTP, projeto Supabase remoto, deploy ou
serviço de produção foi usado. Nenhuma migration, regra de domínio, teste de
app ou parâmetro de timeout/retry foi alterado. Contêineres alheios não foram
operados. Houve rejeição automática do comando documental combinado; César
reautorizou explicitamente AGENTS §5/§8, docs/25 §8.1, docs/23 e manifesto,
exigindo separar formatação de código e vedando formatador em documentos.

## Correção da revisão independente do PR #61 — 08/10/2026

As decisões técnicas do planejador de 08/10 detalham a decisão humana de 07/10
sem alterar limiar ou exceções. A lista vale em qualquer pasta, inclui shrinkwrap,
demais lockfiles, Node/Deno, patches, actions locais e o teste do seletor.
Base diferente de main exige auditoria. O head inteiro é inspecionado para links
herdados, sem seguir alvos internos/externos. O workflow obtém o seletor de
origin/main fora da árvore do PR e só executa blob regular (100644/100755).
Sem blob disponível, ou com symlink na origem, exige sem executar o head.
No bootstrap deste PR, main ainda não tem o seletor.

A reprodução real adicionou somente npm-shrinkwrap.json a uma cópia isolada,
com package.json e package-lock.json idênticos ao PR. O shrinkwrap rebaixou
node_modules/expo/node_modules/ws de 8.21.3 para 8.17.0; resolved/integrity
foram conferidos no registry. npm ci --ignore-scripts instalou 8.17.0, e
**audit:high exit 1** citou GHSA-3h5v-q93c-6h6q e GHSA-96hv-2xvq-fx4p.
No mesmo evento, o seletor anterior dispensava; o corrigido exige. O pacote
vulnerável permaneceu exclusivamente na cópia de contraprova.

`test:audit`: **88 aprovações** (12 da trava preservada, 76 do seletor), incluindo
CLI e execução real do trecho YAML do workflow em repositórios isolados.
Cada arquivo exige também em subpasta; base não main exige; main só .md dispensa;
symlink herdado interno/externo exige; main sem seletor ou com symlink exige.
A fixture R3c adultera seletor e teste do PR, comprova que o teste do head passa,
e exige auditoria pela versão main. O teste externo continua imutável.
Sem GITHUB_OUTPUT, a CLI informa que nenhuma saída é gravada e a condição do
workflow exige auditoria, corrigindo a mensagem contraditória.

**19 mutantes reprovados com exit 1**: os 12 do revisor reconstruídos das
mutações documentadas, inclusive os seis sobreviventes, as três contraprovas
antigas e quatro adicionais para shrinkwrap, base, symlinks e teste do seletor.
R3c é exercitado pelo PR adversarial na fixture; restaurar o fluxo antigo que
executa o head reprova a asserção externa. Logs TAP, fontes e tabela com linhas
estão em ~/colete-noite/corr61-contraprovas.md e corr61-mutants/.
R2b reprova com main divergente: dois pontos exigem indevidamente por arquivo
só alterado no main; três pontos dispensam o PR que só altera .md. R2c cobre
nome vazio; R4a usa evento não PR com SHAs válidos; R4b/R4c exercitam evento e
GITHUB_OUTPUT pela CLI real. Remover cada arquivo da lista, inclusive o teste
do seletor, reprova os casos independentes de caminho na raiz/subpasta.

AGENTS §8 mantém a frase introdutória imediatamente antes da lista; o parágrafo
da auditoria foi movido após os bullets. O histórico do #60 informa fechamento
sem merge e branch preservada. Triggers documentados: validation.yml dispensa
em push, schedule e workflow_dispatch; dependency-audit.yml sempre audita main.

Validação local completa de AGENTS §5, todos os comandos exit 0. Reset pelas
**20 migrations em 26,346 s**; pgTAP **1.259 asserções em 19 arquivos**; dez
harnesses aprovados. verify:app **17,683 s**, **197 unitários em 23 arquivos**,
lint, formato, tipos, builds/PWA, configuração Auth e scans aprovados. Auditoria
do worktree exit 0; audit-high.mjs, fixtures, dependências e exceções intactos.

Browsers **1×**, **80 aprovações e seis skips preexistentes**, zero falhas:
Auth 8/2 skips; privacidade 4/4 skips; grupos 62; smoke 6. Grupos **180,381 s**.
Nenhum retry, timeout maior, sleep ou skip novo. auth.users **0 antes/depois**;
censo **54 tabelas**, Storage **0**, papéis-sonda **0**. Medidos e removidos
**1.764 audit_log_entries e dois flow_state**, somente dados sintéticos após
nosso db:reset. Nenhum objeto ou registro de teste ficou residual.

Documentos editados manualmente, sem reformatação automática; somente checksum
de docs/25 alterado no manifesto. Sem Supabase remoto, deploy, serviço de
produção ou contêiner de outro projeto. Correção em commit separado de f8a35d4;
PR permanece draft, sem merge. Progresso e validação em
~/colete-noite/progresso-corr61.md e corr61-validation*.log/json.
