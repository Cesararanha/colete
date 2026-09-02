# Operação e evidências do M1-A

Status deste documento: operacional. Ele não altera requisitos de produto nem
substitui as fontes normativas de `01`, `04` e `09`–`17`. Continua de
`20-operacao-m0-b.md`.

**O M1-A está em andamento.** Quatro fatias técnicas foram executadas:
`0004_idempotency_foundation.sql`, a fundação transacional de idempotência com o
endurecimento de privilégios do papel administrativo;
`0005_operational_runs.sql`, as tabelas operacionais das sagas, dos jobs e da
retenção; `0006_identity_rpcs.sql`, o catálogo de políticas, seu dispatcher
interno, os guards do caminho administrativo e as quatro RPCs de identidade; e
`0007_idempotency_retention.sql`, o expurgo do livro de idempotência nos prazos
normativos. Com isso as quatro migrations planejadas do marco em `16` §3 estão
entregues. Nenhuma Edge Function e nenhuma tela entram aqui.

## O que cada fatia entregou

### `0004_idempotency_foundation.sql`

| Objeto | Origem |
| --- | --- |
| unidade `milliseconds` em `private.app_limits` | `13` §0, regra 2 |
| limite `idempotency_wait_timeout_ms = 3000` | `13` §0, regra 2 e `16` §4 |
| `private.idempotency_records` | `10` §9 |
| `private.validate_idempotency_outcome(operation, outcome)` | `10` §9.1 |
| `private.acquire_idempotency(...)` | `13` §0, regra 2 |
| `private.complete_idempotency(...)` | `13` §0, regra 2 |
| trigger diferido `idempotency_records_must_conclude` | `13` §0, regra 2 |
| revogação de privilégios de `service_role` em `public` e `private` | `10` §11 e `14` §5.3 |

A migration estende `private.app_limits` com `alter table` em vez de reescrever a
`0002`: a tabela é append-only e um banco já aplicado precisa seguir exatamente o
mesmo caminho de uma instalação nova.

### `0005_operational_runs.sql`

| Objeto | Origem |
| --- | --- |
| `private.external_effects` | `10` §9 e `13` §7 |
| `private.job_runs` | `10` §9 e `13` §7.1 |
| `private.retention_runs` | `10` §12 e `17` §4, item 7 |
| `private.validate_job_summary(summary)` | `17` §3 |
| trigger `job_runs_validate_summary` | `17` §3 |
| censo pgTAP das colunas JSON | `17` §3 |

Nenhum worker, job, cron ou RPC entra nesta fatia. Ela cria estado e o validador
que fecha a única coluna JSON que introduz.

### `0006_identity_rpcs.sql`

| Objeto | Origem |
| --- | --- |
| `private.policy_documents` | `10` §2 e `17` §2 |
| FK composta de `public.policy_acceptances` para o catálogo | `10` §2 |
| `private.publish_policy_document(...)` | `10` §11 e `17` §2 |
| `private.is_actor_session_revoked(session_id)` | `10` §11 e `14` §5.3 |
| `private.require_actor_context(...)` | `10` §11 e `13` §0, regra 7 |
| `private.require_internal_transport(...)` | `13` §0.1 |
| `private.validate_profile_patch(...)` | `13` §5.6 |
| `private.profile_projection(...)` e `private.policy_state(...)` | `13` §5.2 e §5.6 |
| `private.require_policies_accepted(...)` | `13` §5.2 |
| `public.complete_profile(...)` | `13` §5.7 |
| `public.update_profile(...)` | `13` §5.6 |
| `public.accept_policies(...)` | `13` §5.2 |
| `public.revoke_current_session(...)` | `13` §5.5 |

Nenhuma Edge Function, nenhum rate limit produtivo e **nenhum seed de política**
entram nesta fatia. O catálogo nasce vazio: `16` §3 exige que versões fictícias
fiquem em fixture ou seed local e que outra migration publique textos e digests
efetivos antes do beta.

### `0007_idempotency_retention.sql`

| Objeto | Origem |
| --- | --- |
| `private.purge_expired_idempotency_outcomes()` | `17` §4, item 4 e `13` §0, regra 2 |
| índice `idempotency_records_outcome_expiry_idx` | caminho de acesso da fase de 30 dias |

Dois prazos, uma política. Aos 30 dias o payload de replay é apagado e a linha
vira `payload_expired`; a chave e o HMAC sobrevivem como tombstone até 24 meses,
para que um retry tardio responda `IDEMPOTENCY_EXPIRED` em vez de executar uma
segunda vez. Apagar o tombstone antes transformaria um replay em mutação nova —
exatamente a falha que o livro existe para impedir. A função executa as duas fases
nessa ordem, de modo que um livro não expurgado por mais de 24 meses seja
resolvido numa única execução, e grava a evidência em `private.retention_runs`.

Nenhum cron, scheduler ou wrapper de job entra nesta fatia: gravar
`private.job_runs` por execução pertence à fatia de jobs.

### Medição real da suíte pgTAP

`npm run db:test` executa **542 asserções pgTAP em sete arquivos**: 13 do M0-A,
93 da fatia 1, 105 da fatia 2, 112 da `0004`, 80 da `0005`, 105 da `0006` e
**34 novas** em `supabase/tests/database/0007_idempotency_retention.test.sql`. Os
totais anteriores foram 211 ao fim do M0-B, 321 ao fim da `0004`, 401 ao fim da
`0005` e 508 ao fim da `0006`. A `0004` subiu de 110 para 112 porque a asserção de
privilégio de rotina dela foi dividida em três, pelo motivo registrado abaixo. Os
números foram medidos nesta execução, não estimados nem copiados.

### Harness concorrente de 25 conexões

`npm run db:test:idempotency` roda `scripts/test-idempotency-concurrency.mjs`. Ele
abre 25 conexões PostgreSQL independentes — a suíte confere que os 25
`pg_backend_pid()` são distintos e que todas estão em `READ COMMITTED` — e cobre os
casos que `13` §0.2 exige:

1. **Vencedor único.** 25 chamadas simultâneas com a mesma chave e o mesmo HMAC
   produzem exatamente um efeito de negócio e um `completed`; as outras 24 recebem
   o mesmo outcome seguro depois do commit.
2. **Conflito de HMAC.** 24 concorrentes com payload divergente esperam a decisão
   da unique enquanto o vencedor está em voo, nunca tocam o domínio e recebem
   `IDEMPOTENCY_CONFLICT`.
3. **Rollback do vencedor.** O rollback libera a chave e desfaz o efeito; um
   segundo chamador vence e o efeito acontece exatamente uma vez.
4. **Timeout de espera.** Com o vencedor em voo além dos 3000 ms, os concorrentes
   recebem `IDEMPOTENCY_WAIT_TIMEOUT`, sem efeito parcial e sem takeover. O tempo
   decorrido é verificado contra o limite.
5. **Queda de conexão.** Perder a conexão do vencedor equivale a rollback: a chave
   é liberada e o retry executa exatamente uma vez.

O harness cria seu próprio schema descartável para registrar efeitos e o remove no
`finally`, junto com os registros que criou. Depois de `db:reset`,
`db:test` e `db:test:idempotency` o banco fica sem nenhum resíduo:
`private.idempotency_records` e `public.profiles` voltam a zero linhas e nem o
schema do harness nem as sondas test-only sobrevivem.

## Decisões que precisam ficar registradas

### A fronteira do `service_role` é feita de grants, não de policies

`service_role` continua com `BYPASSRLS` — isso é atributo de papel da plataforma e
esta migration não o remove. Justamente por isso RLS **não** é a fronteira
aplicável a ele: qualquer policy que se escrevesse seria ignorada. O que a `0004`
faz é remover o privilégio:

- `revoke all on schema private` — sem `usage`, `service_role` nem enxerga os
  objetos do schema de serviço;
- `revoke all on all tables/sequences` e `revoke execute on all functions` em
  `public` e `private`;
- `alter default privileges for role postgres` nos dois schemas, para que tabelas,
  sequences e funções **futuras** não restaurem o acesso.

Estado medido após `db:reset`: zero linhas em `information_schema.role_table_grants`
e em `information_schema.routine_privileges` para `service_role` nos schemas
`public` e `private`; `has_schema_privilege('service_role','private','usage')` é
falso; `rolbypassrls` continua verdadeiro.

A suíte pgTAP prova o efeito trocando de papel com `set local role service_role` e
exigindo `42501` em `SELECT`, `INSERT`, `UPDATE` e `DELETE` diretos, em
`nextval()` de uma sequence de aplicação, na chamada dos helpers privados de
idempotência e na tentativa de desabilitar o trigger diferido. Uma sonda
test-only, criada e destruída dentro da própria transação da suíte, mostra o
caminho autorizado: uma função `security definer` estreita só se torna chamável
**depois** de um `grant execute` nominal, e esse grant continua não dando DML
direto em tabela nenhuma.

**Limite explícito desta garantia:** ela vale para o banco da aplicação — os
schemas `public` e `private`. A secret key continua sendo credencial elevada para
Auth, Storage e para a plataforma Supabase, e nada nesta fatia muda isso. O
tratamento correto dela permanece o de `14` §5, tabela de chaves de API: só na
Edge/worker, nunca em bundle, browser, app, URL ou log.

### `complete_profile` é exclusivo do namespace `bootstrap:`

Defeito encontrado na revisão desta fatia e corrigido antes do commit. O `check`
normativo de `10` §9 fecha as três formas de `actor_key` de modo que `profile:` e
`system:` só valem para `operation <> 'complete_profile'`. A versão anterior da
migration permitia `complete_profile` sob qualquer um dos três namespaces, o que
abriria um caminho para registrar a criação de perfil sem derivar a chave
bootstrap de `13` §5.7. A constraint da tabela e os dois helpers passaram a
recusar essa combinação, e três asserções novas provam a recusa: pela função e
pela própria tabela.

### A migration é uma transação explícita

Segundo defeito corrigido: a `0004` não tinha `begin;`/`commit;`, ao contrário de
`0001`–`0003`. Uma migration parcialmente aplicada é exatamente o estado que o
critério "banco sobe do zero somente pelas migrations" de `16` §3 proíbe.

### Versões de canonicalização entram como `integer`

`canonical_version` e `hash_key_version` são armazenados como `smallint`, mas os
parâmetros dos helpers são `integer`. Clientes PostgreSQL inferem literais
numéricos como `integer`; expor `smallint` na assinatura obrigaria todo chamador a
fazer cast explícito para encontrar a função. O armazenamento continua compacto e
a conversão, com validação de faixa (`1..32767`), é interna.

### Nenhuma chave HMAC existe no banco

`request_hash` guarda o HMAC-SHA-256 canônico calculado pela Edge, em hexadecimal
minúsculo, e a constraint exige exatamente esse formato. **A chave não está no
banco**: não há coluna, tabela, `app_limits`, parâmetro de configuração nem função
que a contenha, e a `0004` deliberadamente não cria
`private.compute_idempotency_hash`. É o que `10` §9.1 e `13` §0.1 exigem — sem
chamador produtivo, o helper produtivo não existe. Os helpers desta fatia validam
formato e versão e comparam o valor persistido no replay; eles não calculam nem
autenticam nada.

O que a tabela pode guardar é fechado por `private.validate_idempotency_outcome`:
somente as quatro formas de identidade de `10` §9.1, com chaves exatas, tipos
exatos, enums fechados, lista de aceites ordenada por bytes e sem duplicata. Chave
desconhecida é rejeitada, inclusive aninhada. Não há espaço para Pix, token,
caminho, nota, prova, fingerprint ou campo de perfil.

### O timeout de 3000 ms é calibragem de piloto

`idempotency_wait_timeout_ms = 3000`, unidade `milliseconds`, entra com a mesma
ressalva dos seis valores do M0-B: é calibragem inicial, a revisar com dados do
piloto, exatamente como `13` §0 e `16` §4 registram. Ele é aplicado como
`lock_timeout` local da espera pela unique — **não** é lease e não autoriza
takeover. Espera excedida retorna `IDEMPOTENCY_WAIT_TIMEOUT`, retryable e sem
efeito, e o retry conserva o mesmo `request_id`.

### `job_runs.match_id` nasce sem foreign key

`public.matches` ainda não existe, então a coluna nasce nullable e **sem FK**. É a
ordem de implantação que `10` §9 declara explicitamente, não relaxamento
permanente: a migration que criar `matches` adiciona e testa a constraint. A
suíte fixa isso por asserção — conta zero foreign keys sobre `match_id`, confirma
o tipo `uuid` e confirma que a coluna é nullable —, para que a dívida seja
visível em vez de silenciosa.

### O censo de colunas JSON entra com a segunda coluna JSON

`17` §3 exige que uma migration inclua o teste que varre
`information_schema.columns` atrás de toda coluna `json|jsonb` dos schemas da
aplicação e exige correspondência 1:1 com o mapa e com um validador registrado.
Enquanto existia uma única coluna JSON, o censo não distinguia nada. Com
`job_runs.summary` ele passa a valer: hoje o conjunto autorizado é exatamente
`private.idempotency_records.outcome` e `private.job_runs.summary`, cada uma com
seu validador. **Uma coluna JSON nova em qualquer schema da aplicação quebra o
CI** até ser classificada em `17` §3 e ganhar validador.

`validate_job_summary` fecha a forma: os seis contadores são obrigatórios,
`cursor` é a única chave opcional, contadores são inteiros não negativos
verificados no texto do literal — `jsonb_typeof` diz `number` tanto para `1.5`
quanto para `1e400` — e o cursor é string opaca de no máximo 200 caracteres.
Chave desconhecida é rejeitada, o que é o ponto: `summary` nunca carrega lista de
identificadores pessoais.

### O caminho administrativo não pode reutilizar o guard do M0-B

`private.require_domain_authority()`, da `0003`, resolve o ator por `auth.uid()`.
Ele é correto para uma projeção que roda sob o JWT do usuário e **errado** aqui:
neste caminho `auth.uid()` é o cliente administrativo, ou nulo. Por isso a `0006`
traz `private.require_actor_context(auth_user_id, session_id, ...)`, que recebe o
contexto que a Edge extraiu das claims verificadas e revalida tudo no banco —
sessão na denylist, `deletion_pending`/`deleted`, `suspended`/`banned`. A confiança
na origem do contexto vem da Edge autenticada e do grant exclusivo; a autorização
continua no banco.

`private.is_actor_session_revoked(null)` devolve **verdadeiro**. Um contexto sem
identificador de sessão é um contexto cuja revogação não pode ser verificada, e
isso é negação — a mesma regra fail-closed que `is_session_revoked()` já aplicava.

### Duas exceções deliberadas ao guard, e por quê

`revoke_current_session` aceita uma sessão **já revogada**. `13` §5.5 é explícito:
um `request_id` novo sobre sessão já revogada também é sucesso, e a inserção
`on conflict do nothing` preserva o `expires_at` original para que a segunda
chamada não encurte a negação. Ela também aceita conta `suspended`/`banned`,
porque é ação de segurança do titular, não mutação de domínio. Um `session_id`
nulo continua sendo `UNAUTHENTICATED` nos dois casos.

`update_profile` consulta a idempotência **antes** do portão de políticas. A ordem
importa: uma versão obrigatória publicada depois do commit original não pode
transformar uma mutação já commitada em erro no retry. O replay reproduz o outcome
gravado; uma mutação nova espera o novo aceite. As duas metades estão fixadas por
asserção.

### O portão de políticas não fecha sobre catálogo vazio

`13` §5.2 aplica a regra fail-closed a `accept_policies`: ela falha se o catálogo
não tiver exatamente uma versão obrigatória de `terms` e uma de `privacy`. O portão
das mutações comuns está escrito em outros termos — "enquanto houver versão
obrigatória pendente" —, então com catálogo vazio nada está pendente e
`update_profile` passa. A implementação segue o texto literal. É o comportamento
necessário hoje, porque o catálogo só recebe conteúdo na migration pré-beta; se a
intenção normativa for fechar também esse portão, é decisão de `13`, não desta
fatia.

### A chave bootstrap é derivada no próprio banco

`complete_profile` deriva `bootstrap:<sha256>` antes de perguntar se o perfil
existe, conforme `13` §5.7. Isso é possível porque o digest de bootstrap é
SHA-256 **sem chave** — diferente do HMAC de idempotência, que continua sendo
calculado pela Edge com a chave do cofre. Nada nesta fatia precisa dessa chave, e
ela continua fora do banco. A suíte fixa a derivação contra o vetor publicado:
`01890f7e-e948-7c53-b13a-4a36e4b7d21e` produz
`21409156bb1cbd9d8cadf3814edcf230153e3378c09dc03ebf5ed8940c9c4d3a`.

### O grant nominal é a única exceção à revogação da `0004`

`10` §11 e `13` §0.1 exigem exatamente isto: `public`, `anon` e `authenticated`
não recebem `EXECUTE` em RPC mutável, e só o papel administrativo do caminho
secreto recebe grant nominal. A `0006` concede `EXECUTE` a `service_role` nas
quatro RPCs e em mais nada. Como consequência, a asserção da `0004` que exigia
zero privilégios de rotina virou duas: zero em `private`, e em `public` exatamente
a allowlist nominal, nomeada. Uma migration futura que amplie a superfície
administrativa precisa alterar essa asserção de propósito — é o mesmo princípio do
censo de colunas JSON.

Os testes continuam provando, com `set local role service_role`, que o grant
nominal **não** devolve DML direto: `update` em `profiles`, `insert` em
`policy_acceptances` e `select` no catálogo continuam retornando `42501`.

### A FK composta que faltava desde a `0003`

`10` §2 declara `policy_acceptances` com FK composta para
`private.policy_documents(document_type, version)`. A `0003` não pôde criá-la
porque o catálogo não existia. A `0006` a adiciona — migration commitada é
imutável, estado novo entra na próxima. A fixture da suíte da `0003` passou a
publicar as versões que ela aceita; as regras de aceite testadas lá não mudaram.

### O expurgo não aceita relógio de quem chama

`purge_expired_idempotency_outcomes()` tem **zero parâmetros**, e a suíte afirma
isso por asserção sobre `pg_proc.pronargs`. Um expurgo que aceitasse um instante
"agora" seria um caminho para apagar payload antes do prazo. O tempo é o do
servidor, como exige `13` §0, regra 6. Para testar o envelhecimento sem falsear o
relógio, a fixture **backdata `created_at`**: as constraints da `0004` amarram
`outcome_expires_at` e `record_expires_at` a `created_at`, então uma linha
backdatada é exatamente uma linha que envelheceu.

A evidência em `retention_runs` guarda política, janela, contagens e duração — e a
suíte afirma que o texto da linha não contém nenhum identificador do que foi
expurgado, porque isso recriaria o dado que o expurgo removeu.

### `pg@8.16.3` como devDependency

O harness de 25 conexões precisa de conexões PostgreSQL de verdade, independentes
e sob controle do teste: `supabase test db` roda tudo em uma sessão e uma
transação, então não consegue observar espera concorrente, rollback do vencedor
nem queda de conexão. `pg` entra em versão exata, apenas como `devDependency`,
usado somente por `scripts/test-idempotency-concurrency.mjs`. Nenhum código de
aplicação o importa e ele não vai para o bundle.

## O que ficou de fora, e por quê

- **O agendamento do expurgo.** A `0007` cria a política; o cron que a executa
  todo dia, o wrapper que grava `private.job_runs` por execução e o alarme de
  atraso de 24 h de `17` §4, item 7, pertencem à fatia de jobs.
- **A Edge Function do gateway.** `14` §5.3 define o caminho administrativo
  exclusivo. As RPCs internas existem; a Edge que valida o JWT, extrai as claims,
  aplica rate limit, canonicaliza a entrada por JCS e calcula o HMAC **não**.
  Enquanto ela não existir, nenhum cliente alcança essas RPCs: `anon` e
  `authenticated` não têm `EXECUTE`.
- **Seed de políticas.** O catálogo nasce vazio e a migration que publica textos
  e digests efetivos é pré-beta, conforme `16` §3.
- **`request_data_export`, `delete_account` e as operações administrativas de
  `13` §5.3 e §5.4.** Pertencem ao M1-B e às fatias administrativas.
- **Workers, cron e jobs.** A `0005` cria as tabelas que `reconcile_due_matches`,
  `process_external_effects`, `apply_retention` e os demais jobs de `13` §7 vão
  usar. Nenhum desses jobs existe, nem o agendamento deles.
- **`legal_holds`.** Aparece no mesmo bloco SQL de `10` §9, mas a linha
  fatia→migration da `0005` nomeia apenas as três tabelas privadas. Fica para a
  fatia que a nomear.
- **Gateway Edge executável.** `14` §5.3 define o caminho administrativo
  exclusivo; esta fatia não cria Edge Function, rota, rate limit produtivo nem
  cliente administrativo.
- **RPCs.** `complete_profile`, `update_profile`, `accept_policies` e
  `revoke_current_session` não existem. Os helpers da `0004` são
  `security invoker` de propósito: são blocos de composição de uma RPC
  `security definer` futura, que precisará compartilhar a mesma transação com a
  mutação de domínio e com `complete_idempotency`.
- **Nenhuma mutação de produto foi exposta.** Não há caminho pelo qual um cliente
  — `anon`, `authenticated` ou o papel administrativo — produza efeito de negócio
  com o que esta migration entrega. Os helpers não têm grant para papel nenhum.
- **`policy_documents`, textos legais e seeds fictícios.** São da fatia de
  catálogo/RPC do M1-A.
- **Expurgo dos 30 dias e dos 24 meses.** As colunas
  `outcome_expires_at`/`record_expires_at` e o estado `payload_expired` já existem
  e são testados, mas o job que executa a retenção é a `0007`.
- **Auditoria tipada, outbox, `external_effects`, `transition_markers` e
  `job_runs`.** Permanecem nas fatias indicadas por `16` §3.
- **Exportação, exclusão, Storage e projeto Supabase remoto.** Fora do M1-A ou do
  escopo desta fatia; nenhum serviço remoto foi acessado.

## Comandos locais

Pré-requisitos: Node/npm nas versões fixadas em `19-operacao-m0-a.md` e Docker
Desktop em execução.

```sh
npm run db:start
npm run db:reset
npm run db:test
npm run db:test:idempotency
npm run verify:app
npm run audit:high
npm run db:stop
```

`npm run db:reset` recria o banco somente pelas migrations `0001`–`0008`, sem seed
de domínio e sem seed de política.

## CI

O job `Database security` do workflow `Colete validation` passou a rodar
`npm run db:test:idempotency` depois de `db:test` e antes de `db:stop`. O harness
descobre a URL do banco por `supabase status -o env`, ou por
`COLETE_TEST_DATABASE_URL` quando ela existir; ele não recebe nenhuma credencial
de projeto remoto.

## Dívidas em aberto ao fim desta fatia

1. ~~`private.app_limits` e `private.allowed_proof_mime_types` com `force row
   level security` e zero policies.~~ **Saldada pela `0008`.** As duas nasceram na
   `0002`, antes da regra de `14` §5.2. A `0008` remove `force` e desliga RLS de
   forma append-only, e a suíte prova camada por camada o que realmente protege
   essas tabelas: sem `usage` no schema, o schema nega; com `usage` e sem grant,
   o privilégio de tabela nega; com os dois, a leitura funciona. Antes da `0008`
   esse último passo devolvia **zero linhas** em vez das sete reais — para uma
   tabela lida como configuração, um limite silenciosamente ausente.
2. **`private.job_runs.match_id` sem foreign key** até a migration que criar
   `public.matches`.
3. **As RPCs `security definer` dependem de `BYPASSRLS` do dono.** Elas escrevem
   em `public.profiles`, que tem `force row level security` e nenhuma policy de
   escrita. Funcionam porque o dono, `postgres`, tem `rolbypassrls`. `14` §5.2
   avisa que depender desse atributo é depender de algo que nenhum teste cobre por
   padrão — então a suíte passou a cobrir: há asserção explícita de que o dono das
   RPCs tem `BYPASSRLS`. Aqui a perda do atributo falharia **fechada** (escrita
   negada), não aberta, mas quebraria a funcionalidade em silêncio. Vale decidir,
   fora desta fatia, se a fronteira de escrita de `profiles` deve continuar
   apoiada nesse atributo.
4. **Calibragem** de `idempotency_wait_timeout_ms`, junto dos seis valores do
   M0-B, a revisar com dados do piloto.
5. **Vetores dourados de canonicalização** JCS/HMAC nos três runtimes (`13` §0.2,
   item 8) — dependem da Edge que calcula o HMAC, e por isso chegam com a fatia
   do gateway.
6. **Teste em aparelho físico** e **validação jurídica**, ambos herdados do M0-B e
   ainda abertos.
