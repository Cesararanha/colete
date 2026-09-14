# Operação e evidências do M1-B

Status deste documento: operacional. Ele não altera requisitos nem substitui
as fontes normativas `10`, `13`, `14`, `16`, `17` e `22`. Continua de
`21-operacao-m1-a.md`.

O M1-B está em andamento. Este documento registra as Fatias 1 e 2; a exportação
governada e os controles da tela 13 continuam nas fatias seguintes.

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
npm run verify:app
npm run scan:docs
npm run scan:secrets
npm run audit:high
git diff --check
```

O job `Database security` da CI executa o harness do worker depois do gateway.
Os cinco nomes de job continuam `App quality`, `PWA export`,
`Database security`, `Repository guardrails` e `PWA smoke`.
