# Operação e evidências do M1-B

Status deste documento: operacional. Ele não altera requisitos nem substitui
as fontes normativas `10`, `13`, `14`, `16`, `17` e `22`. Continua de
`21-operacao-m1-a.md`.

O M1-B está em andamento. Esta seção registra somente a Fatia 1,
`0011_worker_foundation.sql`; a saga de exclusão, a exportação governada e os
controles da tela 13 continuam nas fatias seguintes.

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
npm run verify:app
npm run scan:docs
npm run scan:secrets
npm run audit:high
git diff --check
```

O job `Database security` da CI executa o harness do worker depois do gateway.
Os cinco nomes de job continuam `App quality`, `PWA export`,
`Database security`, `Repository guardrails` e `PWA smoke`.
