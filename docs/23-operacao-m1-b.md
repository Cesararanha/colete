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
