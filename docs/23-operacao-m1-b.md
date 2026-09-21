# Operação e evidências do M1-B

Status deste documento: operacional. Ele não altera requisitos nem substitui
as fontes normativas `10`, `13`, `14`, `16`, `17` e `22`. Continua de
`21-operacao-m1-a.md`.

O M1-B está em andamento. Este documento registra as Fatias 1, 2 e 3; os
controles da tela 13 continuam na fatia seguinte.

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
- A RPC sempre devolve e persiste a saga em `requested`. Quando não existe
  objeto de Storage conhecido, ela ainda cria na mesma transação o efeito
  `delete_auth_user:<request_id>`; o worker é quem chama a reconciliação ao
  adquirir o primeiro efeito e avança `requested → cleaning_storage` ou
  `requested → deleting_auth`.
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
npm run scan:docs
npm run scan:secrets
npm run audit:high
git diff --check
```

O job `Database security` da CI executa o harness do worker depois do gateway.
Os cinco nomes de job continuam `App quality`, `PWA export`,
`Database security`, `Repository guardrails` e `PWA smoke`.
