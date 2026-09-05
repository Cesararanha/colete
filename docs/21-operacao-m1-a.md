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
entregues. A `0010_idempotency_conclusion_context.sql` corrige o contexto de
execução do trigger diferido encontrado pela primeira integração real do
gateway. Nenhuma tela entra aqui.

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

### `0008_settle_rls_debt.sql`

| Objeto | Origem |
| --- | --- |
| `no force` + `disable row level security` em `private.app_limits` | `14` §5.2 e `16` §3, fatia 9 |
| `no force` + `disable row level security` em `private.allowed_proof_mime_types` | `14` §5.2 e `16` §3, fatia 9 |

Não é fatia do M1-A: é a dívida do M0-B, saldada aqui com a numeração `0008`
autorizada para isso. Nenhuma outra tabela é tocada, e a suíte fixa isso com um
`set_eq` — a RLS continua cobrindo exatamente as cinco tabelas de `public` que têm
leitor autorizado, e nenhuma de `private`.

### `0009_uuid_version_nibble.sql`

| Objeto | Origem |
| --- | --- |
| `idempotency_records_actor_key_namespace_check` recriado | `10` §9 |
| `private.validate_idempotency_outcome` substituída | `10` §9.1 |
| `private.acquire_idempotency` substituída | `13` §0, regra 2 |
| `private.complete_idempotency` substituída | `13` §0, regra 2 |

A `0004` exigia que o nibble de **versão** de todo UUID validado fosse 1 a 5. O
nibble de **variante** é invariante de RFC 4122; o de versão não é invariante de
nada que este projeto declare. Nenhum documento normativo diz qual versão de UUID
o GoTrue emite, e o UUID que `10` §9.1 e `13` §5.7 usam como próprio vetor de
trabalho — `01890f7e-e948-7c53-b13a-4a36e4b7d21e` — é **v7**, rejeitado por
aqueles checks. É a mesma família do defeito de `run_key` corrigido na `0005`.

O sintoma mais concreto: uma sessão cujo `session_id` fosse v7 **não conseguia se
revogar** — `revoke_current_session` falhava com `VALIDATION` ao gravar o outcome.

A `0009` é append-only: a `0004` não é reescrita. O CHECK é derrubado e recriado
porque CHECK não se altera no lugar, e a expressão nova é estritamente mais
permissiva, então nenhuma linha commitada pode reprová-la. As três funções são
byte a byte as da `0004`, exceto o regex — verificado por comparação mecânica
antes do commit. A exigência de **canônico minúsculo continua**, e continua
testada: maiúsculo, truncado e sem hífen seguem rejeitados **nos três caminhos** —
`actor_key`, `profile_id` e `session_id` —, e o namespace fechado não foi alargado.
Truncado e sem hífen são justamente as formas que um quantificador de comprimento
mal editado deixaria passar, e é esse trecho do regex que a `0009` edita.

### `0010_idempotency_conclusion_context.sql`

| Objeto | Correção |
| --- | --- |
| `private.enforce_idempotency_conclusion()` | passa de `SECURITY INVOKER` para `SECURITY DEFINER` |

O trigger é diferido e executa no commit sob o papel que chamou a RPC. Esse papel
é `service_role`, que deliberadamente não tem `usage` em `private`; por isso a
função precisa executar como seu dono `postgres`. A função já tinha
`search_path = ''` e referências qualificadas, não recebe entrada do cliente e
continua sem `EXECUTE` concedido. A `0010` não concede `usage`, `select` ou DML a
`service_role` e não reabre a fronteira da `0004`.

A regressão vive em `scripts/test-identity-gateway.mjs`, não em pgTAP. O harness
entra pela Edge, chama a RPC via PostgREST com a secret key **local** e observa a
transação depois que ela commitou de fato como `service_role`. Ele exige a linha
de idempotência em `completed`, confirma dono `postgres` e `search_path` vazio, e
confirma que `service_role` continua sem `usage` em `private` e sem DML direto no
livro. pgTAP sempre faz rollback e não pode provar essa classe de garantia.

### Fatia A — o gateway Edge de identidade

Primeira linha de código produtivo do projeto. `supabase/functions/identity/` é o
gateway exclusivo por onde passam as quatro mutações de identidade — o consumidor
que faltava às RPCs da `0006`.

| Objeto | Origem |
| --- | --- |
| `supabase/functions/identity/index.ts` | `13` §0 e `14` §5.3 |
| `_shared/jcs.ts` — canonicalização RFC 8785 | `13` §0.1 |
| `_shared/hmac.ts` — HMAC versionado por chave | `13` §0.1 e `10` §9.1 |
| `_shared/bootstrap.ts` — ator bootstrap | `13` §5.7 |
| `_shared/operations.ts` — um normalizador por operação | `13` §0.1, §5.2, §5.6, §5.7 |
| `_shared/errors.ts` — catálogo estável e envelope `Result` | `13` §0 e §8 |
| `_shared/gateway.ts` — o caminho, com dependências injetadas | `13` §0.1 |
| `[functions.identity]` em `config.toml` | `14` §5.3 |

**Nenhum deploy foi feito.** Nada nesta fatia toca o projeto remoto.

#### Os dois vetores dourados, reproduzidos

| Vetor | Valor obtido |
| --- | --- |
| HMAC — chave de teste `00..1f`, `join_match` | `5974c4e8c2434e4d150f2f2199180b3228c869f80e72dabc0f25218132595ee4` |
| Ator bootstrap — `01890f7e-e948-7c53-b13a-4a36e4b7d21e` | `21409156bb1cbd9d8cadf3814edcf230153e3378c09dc03ebf5ed8940c9c4d3a` |

Ambos batem com `13` §0.1 e §5.7 na primeira execução. São a prova de que a
implementação TypeScript concorda com o que o banco espera, e é por isso que eles
são testados sem rede: o vetor é um fato sobre bytes, não sobre integração.

#### Duas camadas de teste, e por quê

**Camada 1, sem rede** (`supabase/functions/_shared/*.test.ts`, no `npm test`).
Canonicalização, HMAC, ator bootstrap e os normalizadores. Roda no Vitest, junto
com o resto da suíte de unidade, porque os módulos puros não importam nada do
Deno — a única dependência do runtime está no `index.ts`. Cobre também ordem de
chaves, unicode e escapes, ausência × `null` produzindo canônicos diferentes, o
array de `accept_policies` reordenado produzindo o mesmo HMAC, e float/`NaN`
recusados.

**Camada 2, ponta a ponta** (`scripts/test-identity-gateway.mjs`, `npm run
db:test:gateway`). A função servida pela stack local, chamada por HTTP com um JWT
real do GoTrue: o usuário é criado pela API administrativa local e o token vem do
`grant_type=password`, o que garante um `session_id` verdadeiro nas claims — o
`session_id` é o que a revogação precisa e é o que um token forjado à mão não
teria.

A escolha mais simples e confiável para CI acabou sendo **não subir um segundo
processo**: `supabase start` já serve `supabase/functions/`, então a camada 2 não
precisa de `supabase functions serve`, nem de supervisionar e derrubar um daemon.
Também não há import de terceiros na função — verificar um token e chamar uma RPC
são duas requisições HTTP, e puxar um cliente para fazê-las acrescentaria um
download em tempo de bundle a cada cold start e a cada execução de CI.

Uma observação operacional para quem for iterar: o edge runtime local **não
recarrega a quente** os módulos já importados, apesar de `policy = "per_worker"`.
Editar `_shared/` exige `supabase stop && supabase start`; reiniciar só o
container não basta.

#### Bloqueio encontrado e saldado pela `0010`

A camada 2 inicialmente não passava, e o motivo não estava no gateway. O trigger
diferido `idempotency_records_must_conclude` da `0004` executava
`private.enforce_idempotency_conclusion()`, que era `SECURITY INVOKER`. Um trigger
diferido roda **no commit, sob o papel do chamador** — e o chamador do caminho
administrativo é `service_role`, de quem a `0004` removeu deliberadamente o
`usage` no schema `private`. Resultado:

```
call   as service_role : OK
COMMIT as service_role : 42501 permission denied for schema private
call   as postgres     : OK
COMMIT as postgres     : OK
```

A chamada passa; o **commit** falha. Nenhuma das quatro mutações de identidade
consegue commitar pelo único chamador para o qual foi projetada.

Por que 606 asserções pgTAP não pegaram isso: a suíte roda como `postgres` e
**sempre faz rollback**. A asserção "the administrative role can actually execute
a gateway RPC" da `0006` troca de papel, chama a RPC e devolve o papel — mas a
transação nunca commita, então o trigger diferido nunca dispara sob
`service_role`. O gateway é a primeira coisa neste projeto que **commita** como
`service_role`, e encontrou o defeito na primeira chamada real.

O isolamento foi exato. Com
`alter function private.enforce_idempotency_conclusion() security definer`
aplicado primeiro como sonda local, as nove verificações da camada 2 passaram;
revertido para `security invoker`, a falha voltou imediatamente. A `0010` torna
essa instrução estado reproduzível por migration.

A prova commitada confirma que conceder `usage` em `private` a `service_role`
resolveria o sintoma errado e desfaria a fronteira que a `0004` construiu. A
função `security definer`, já pertencente a `postgres`, restaura a invariante sem
alargar nada.

`npm run db:test:gateway` agora passa e roda na CI depois do harness concorrente.
Para isso `npm run db:start` sobe a stack completa com `supabase start`, incluindo
Auth, PostgREST e Edge, e fornece à stack local/CI a chave **pública de teste**
`00..1f` do vetor normativo. Nenhuma chave remota é lida ou copiada.

### Fatia B1 — autenticação e camada de API

A primeira interface real do produto consome o gateway de identidade sem abrir
uma rota alternativa para as RPCs mutáveis. A fatia entrega as quatro rotas de
autenticação (`entrar`, `criar-conta`, `verificar-codigo` e
`esqueci-senha`), o gate de sessão/perfil, o cliente Supabase e a camada
`src/lib/api.ts`. Tela 13, grupos, rachas, notificações, Google OAuth, Storage,
rate limit, exportação e exclusão continuam ausentes.

O cliente usa somente `EXPO_PUBLIC_SUPABASE_URL` e
`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. O exemplo versionado contém apenas um
valor local e um valor inequivocamente falso; a secret key não entra em variável
`EXPO_PUBLIC`, bundle, URL nem log da aplicação. `src/lib/database.types.ts` é
saída real de `supabase gen types typescript --local`, e
`npm run generate:db-types` regenera o arquivo a partir da stack descartável.

`lib/api.ts` fixa quatro invariantes na fronteira cliente→Edge:

- cada chamada de construção cria um `request_id` e devolve uma intenção que o
  conserva em `execute`/`retry`; o body é serializado uma única vez na construção,
  portanto nem uma referência mutada pelo chamador altera a intenção; uma nova construção
  é uma nova intenção;
- `input_hmac`, versões internas, ator, `auth_user_id`, `profile_id` e
  `session_id` são recusados recursivamente antes do transporte;
- envelopes de erro só viram `AppError` se o código pertencer aos 111 valores
  gerados de `13` §8; a UI decide pelo código e conserva a mensagem como fallback;
- erro de negócio nunca recebe retry automático. Falha de transporte ou resposta
  5xx sem envelope normativo recebe até duas novas tentativas com o mesmo body.
  `IDEMPOTENCY_WAIT_TIMEOUT` é erro de negócio retryable e o botão consciente usa
  a mesma intenção, portanto o mesmo `request_id`.

TanStack Query guarda exclusivamente sessão/perfil e coordena invalidação após a
mutação. `react-hook-form` e Zod compartilham os schemas usados por tela e
payload; a validação começa no blur, passa a responder à digitação depois do
primeiro erro e o submit sempre focável envia o foco ao primeiro campo inválido.
Zustand guarda nome/e-mail pendentes somente em memória entre cadastro e OTP —
sem persistência e sem PII em query string. Não há atualização otimista.

Os componentes compartilhados fornecem esqueleto para carregamento, erro de rede
com retry honesto e, onde há dados consultados, vazio com explicação/ação. Campos e
erros têm nome acessível, `aria-describedby`, `aria-invalid` e live region; controles
têm alvo mínimo de 44 px; foco global continua visível; o layout reflui em 390 px e
ganha coluna contextual acima de 768 px. O harness roda axe nas quatro rotas, nos dois
temas e nos dois viewports; mede botões, links e campos, exercita anúncio e revalidação
em cadastro e recuperação, e afirma separadamente que erro, força da senha e tema têm
texto ou semântica além da cor. Essa automação não substitui a passada manual com leitor
de tela prevista em `15` §3.

#### Prova ponta a ponta

`npm run test:auth:web` estende o Playwright existente. Contra a stack local ele:

1. cria a conta pela tela, com e-mail único;
2. consulta a API do Mailpit/Inbucket em `127.0.0.1:54324` e extrai o OTP de seis
   dígitos do template local que usa `{{ .Token }}`;
3. digita o código pela interface, obtém uma sessão GoTrue real e chama
   `complete_profile` pela Edge;
4. exige a tela autenticada e prova no PostgreSQL uma única linha de perfil e a
   idempotência `completed`;
5. abre uma segunda sessão real, encerra a primeira com escopo local e prova que a
   segunda continua válida; também intercepta transporte nas etapas OTP e nova senha da
   recuperação e exige retry explícito;
6. exige zero aceites fictícios e remove, no `finally`, e-mail do Mailpit,
   idempotência, revogação, perfil, usuário e as entradas de auditoria do Auth
   correlacionadas exclusivamente ao usuário sintético; ao fim confirma zero resíduo
   em todas essas tabelas, além de identidades, sessões e refresh tokens.

`auth.audit_log_entries` é schema gerenciado e código produtivo nunca escreve nele. O
GoTrue local preserva suas entradas mesmo após apagar o usuário, então o harness — como
`postgres`, somente na stack descartável — remove apenas as entradas cujo `actor_id` ou
`actor_username` corresponde ao usuário sintético único. Isso evita reset global que
apagaria evidência de outra execução concorrente e mantém a limpeza impossível de alcançar
em produção pelo cliente.

Na execução local final após o review, o comando de build autenticado levou 8,8 s e os
sete testes efetivos do Playwright, nos dois viewports, levaram 6,6 s; o oitavo caso é
ignorado no desktop para não criar uma segunda conta. No primeiro runner do
GitHub da fatia, instalar o Chromium levou 34 s, exportar o build autenticado
levou 65 s e executar o navegador levou 26 s: **2 min 05 s incrementais**. O job
`Database security` completo fechou em 6 min 00 s. O isolamento foi mantido no
mesmo job da stack descartável; compartilhar um artefato do job PWA export não
serviria, porque aquele build deliberadamente não recebe a configuração pública
da stack local.

#### Fronteiras autorizadas das telas de autenticação

**Aceite LGPD.** O catálogo entregue está vazio, `accept_policies` falha fechado e
nenhum texto legal existe. A fronteira agora registrada em `16` §5 coloca o bloco de
aceite junto da migration pré-beta que publica os dois textos/digests reais; no mesmo
trabalho, a tela busca o catálogo, renderiza links verdadeiros e chama
`accept_policies`. Até lá, a interface não afirma ter recolhido aceite e o teste exige
zero linha em `policy_acceptances`.

**Google OAuth.** Provedor e redirects remotos continuam pendentes e esta fatia não
toca o remoto. A fronteira de `16` §5 coloca o Google na fatia operacional que configura
e verifica provedor/redirects nos três alvos; somente depois o botão entra com E2E real e
fallback obrigatório para completar nome ausente. Nenhum botão inerte, oculto ou
desabilitado promete esse trabalho futuro.

### Medição real da suíte pgTAP

A `0010` não acrescenta asserção pgTAP: o total continua em 606, porque a prova
que importa precisa commitar de verdade.
O que ela acrescenta é a camada 1 do gateway, no `npm test`, que vai de **8
testes de unidade em 2 arquivos para 37 em 6** — 29 novos, entre eles os dois
vetores dourados. A camada 2 tem nove verificações e todas passaram nesta
execução, incluindo o commit real sob `service_role`.

`npm run db:test` executa **606 asserções pgTAP em nove arquivos**: 13 do M0-A,
94 da fatia 1, 105 da fatia 2, **113 da `0004`**, 80 da `0005`, 113 da `0006`, 34
da `0007`, 23 da `0008` e **31 novas** em
`supabase/tests/database/0009_uuid_version_nibble.test.sql`. Os totais anteriores
foram 211 ao fim do M0-B, 321 ao fim da `0004`, 401 ao fim da `0005`, 508 ao fim
da `0006`, 542 ao fim da `0007`, 566 ao fim da `0008` e 574 ao fim do portão de
catálogo. A `0004` subiu de 110 para 113: 112 pela divisão da asserção de
privilégio de rotina em três, e 113 porque a `0009` acrescentou lá a metade que
faltava — nada naquele arquivo fixava o nibble de versão, e é por isso que o
defeito sobreviveu. Os números foram medidos nesta execução, não estimados nem copiados.

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
`update_profile` passa. A implementação segue o texto literal.

Isso deixou de ser leitura da implementação e virou **decisão registrada** em `13`
§5.2: fechar o portão antes da migration pré-beta deixaria o app inutilizável, sem
existir aceite possível que o destravasse. A assimetria é segura porque as duas
metades erram para lados opostos. O estado proibido é o **catálogo pela metade**, e
`16` §2 transforma o catálogo povoado em gate de convite ao beta. A suíte da `0006`
afirma a invariante nas duas pontas — vazio como entregue e completo — e recusa o
parcial.

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

## Decisões fechadas: não reabrir

As três abaixo já foram levantadas, avaliadas e decididas. Estão aqui porque a
ausência de registro fez com que fossem reabertas — a primeira, em três sessões
consecutivas. Reabrir qualquer uma exige argumento novo, não a mesma observação.

### O nibble de variante `[89ab]` continua fixado, de propósito

A `0009` relaxou o nibble de **versão** em cinco lugares porque ele não é
invariante de nada que este projeto declare: nenhum documento diz qual versão de
UUID o GoTrue emite, e o vetor de trabalho de `10` §9.1 e `13` §5.7 é um v7. O
nibble de **variante** é caso diferente e continua exigindo `[89ab]` nos mesmos
cinco lugares.

O motivo é que ele **não varia entre geradores reais**. A variante RFC 4122 é
`10xx` binário para todo UUID produzido por v1, v4, v6 ou v7 — `gen_random_uuid()`
do PostgreSQL, o GoTrue e qualquer biblioteca conforme caem todos nela. Relaxá-la
trocaria uma checagem que não custa nada por checagem nenhuma: não destravaria
entrada legítima alguma, e deixaria passar as formas degeneradas — o UUID nulo,
por exemplo, cuja variante é `0`.

A assimetria é deliberada, e é a diferença entre uma forma **estreita demais para
o contrato** e uma forma **exatamente do tamanho dele**.

### `content_sha256` não é conferido contra arquivo, e não pode ser hoje

`17` §2 exige que o build futuro confira arquivo × digest do catálogo de
políticas. Nada faz isso hoje, e isso não é uma lacuna que esta fatia possa
fechar: o catálogo **nasce vazio**, por decisão registrada em `13` §5.2, e a suíte
da `0006` afirma que nenhuma migration semeia versão. Não existe par arquivo ×
digest para conferir enquanto não existir arquivo.

A verificação pertence à **migration pré-beta** que publica textos e digests
efetivos — é lá que o par passa a existir, e é lá que a conferência tem o que
comparar. O gate de convite ao beta de `16` §2 já aponta para esse momento, e a
invariante de coerência do catálogo, afirmada nas duas pontas pela suíte da
`0006`, garante que o estado intermediário perigoso — um tipo obrigatório e o
outro não — não passe despercebido até lá.

### O conjunto gerenciado pelo Expo sai do feed do Dependabot

`.github/dependabot.yml` ignora `expo`, `expo-*`, `react`, `react-dom`,
`react-native`, `react-native-*`, `@expo/*` e `eslint-config-expo`. Os dezesseis
pacotes de produção mais esse config são versionados pelo Expo SDK 57, que fixa um
conjunto compatível **inteiro ou não é**; a CI deste repositório faz build web e
smoke em navegador, nunca build nativo, e por isso não consegue reprovar um membro
movido sozinho.

Não é teoria: subir `react-native` 0.86.3 → 0.87.1 isolado derrubou o export
`./rn-get-polyfills` que a toolchain do SDK 57 ainda requer, e o bundling falhou.

O caminho de atualização é `expo install --check`, que resolve as versões que o
SDK instalado espera, ou um upgrade de SDK movendo o conjunto junto. Dois limites
acompanham a mesma configuração e **têm condição de saída**, registrada no
arquivo: `@types/node` não passa do major do runtime enquanto Node estiver preso
em 24, e `typescript` não sobe de major enquanto a toolchain do Expo não suportar
TS 7.

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
- **Telas, `lib/api.ts`, rate limit produtivo, seed de políticas,
  `link_google_identity`, export, exclusão, Storage e deploy.** Nada disso entra
  na Fatia A. O gateway existe para provar que a fronteira externa→interna
  funciona contra o banco real, e nada além disso.
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

## Inventário de configuração

Exigido por `14` §5.3. A região e os nomes de secrets foram observados por duas
consultas somente-leitura ao projeto remoto; nenhum valor ou digest foi
registrado. O que não é exposto por essas consultas continua marcado como
pendente em vez de inventado.

| Item | Valor | Fonte |
| --- | --- | --- |
| Projeto linkado | `prdzunponemldfvtcxkr`, organização `yfyabyaoladrpwmevxjx` | `supabase/.temp/`, estado local do CLI |
| Região | `sa-east-1` | `npx supabase projects list`, consulta somente-leitura em 02/09/2026 |
| Extensions | `pgcrypto`, `uuid-ossp`, `pg_stat_statements` em `extensions`; `supabase_vault` em `vault`; `plpgsql` | banco local recriado pelas migrations |
| Schemas expostos pela Data API | `public`, `graphql_public` | `config.toml` `[api].schemas` |
| Auth — provedores | e-mail/senha habilitado; Google **não** habilitado localmente | `config.toml` `[auth]` |
| Auth — `site_url` | `http://127.0.0.1:8081` | `config.toml`, valor local |
| Auth — redirects adicionais | `http://127.0.0.1:4173`, `http://localhost:8081` | `config.toml`, valores locais |
| Auth — `jwt_expiry` | `3600` s | `config.toml` |
| Auth — vida máxima de sessão | `7776000` s, espelhada em `private.app_limits` | `verify:auth-config` |
| Edge Functions | uma: `identity`, `verify_jwt = false` | `config.toml` `[functions.identity]` |
| Secrets — **nomes**, nunca valores | `IDEMPOTENCY_HMAC_KEY_V1`; e as injetadas pela plataforma `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_ANON_KEY`, `SUPABASE_SECRET_KEY`/`SUPABASE_SERVICE_ROLE_KEY` | `config.toml` e `index.ts` |
| Auth/redirects **do projeto remoto** | **pendente** | divergem dos locais e só são legíveis no remoto |
| Secrets efetivamente publicados no remoto — **nomes apenas** | `IDEMPOTENCY_HMAC_KEY_V1` | `npx supabase secrets list`, consulta somente-leitura em 02/09/2026; valores e digests não registrados |
| Cron, buckets, publications | nenhum nesta fatia | — |

Os valores de Auth acima são os **locais**, declarados em `config.toml`. Os do
projeto remoto podem divergir e não foram lidos.

## Comandos locais

Pré-requisitos: Node/npm nas versões fixadas em `19-operacao-m0-a.md` e Docker
Desktop em execução.

```sh
npm run db:start
npm run db:reset
npm run db:test
npm run db:test:idempotency
npm run db:test:gateway
npm run verify:app
npm run audit:high
npm run db:stop
```

`npm run db:reset` recria o banco somente pelas migrations `0001`–`0010`, sem seed
de domínio e sem seed de política.

## CI

O job `Database security` do workflow `Colete validation` passou a rodar
`npm run db:test:idempotency` depois de `db:test`, seguido de
`npm run db:test:gateway`, e só então `db:stop`. O primeiro harness prova
concorrência com 25 conexões; o segundo prova a fronteira HTTP e o commit real
como `service_role`.

Os gatilhos não são uniformes, e isso é deliberado: minutos de Actions em
repositório privado são limitados. Todos os jobs rodam em `pull_request`, que é
onde a mudança é revisada. Só `Repository guardrails` roda também em push para
`main` e num agendamento semanal, porque é o único job cujo resultado muda sem
que o código mude — ele varre advisories de dependência recém-publicados e drift
da baseline normativa. `.github/dependabot.yml` cobre o outro lado do mesmo
problema: o workflow fixa cada action por SHA, e nada no repositório avisa quando
um pin envelhece.

O harness descobre a URL do banco por `supabase status -o env`, ou por
`COLETE_TEST_DATABASE_URL` quando ela existir; ele não recebe nenhuma credencial
de projeto remoto.

## Dívidas em aberto ao fim desta fatia

1. ~~**Bloqueante: `private.enforce_idempotency_conclusion()` era `SECURITY
   INVOKER`.**~~ **Saldada pela `0010`.** O trigger agora é `SECURITY DEFINER`
   de `postgres`, com `search_path` vazio; o harness HTTP commitou como
   `service_role` e confirmou que nenhum privilégio em `private` foi concedido.
2. **Rate limit produtivo.** `14` §5.2 o atribui à Edge e `16` o mantém como item
   futuro próprio. A Fatia A **não** o implementa e deliberadamente **não deixa
   placeholder**: um limitador que não limita é pior que a sua ausência, porque
   parece cobertura. Entra como fatia própria, com o armazenamento de contadores
   decidido junto.
3. ~~`private.app_limits` e `private.allowed_proof_mime_types` com `force row
   level security` e zero policies.~~ **Saldada pela `0008`.** As duas nasceram na
   `0002`, antes da regra de `14` §5.2. A `0008` remove `force` e desliga RLS de
   forma append-only, e a suíte prova camada por camada o que realmente protege
   essas tabelas: sem `usage` no schema, o schema nega; com `usage` e sem grant,
   o privilégio de tabela nega; com os dois, a leitura funciona. Antes da `0008`
   esse último passo devolvia **zero linhas** em vez das sete reais — para uma
   tabela lida como configuração, um limite silenciosamente ausente.
4. **`private.job_runs.match_id` sem foreign key** até a migration que criar
   `public.matches`.
5. **As RPCs `security definer` dependem de `BYPASSRLS` do dono.** Elas escrevem
   em `public.profiles`, que tem `force row level security` e nenhuma policy de
   escrita. Funcionam porque o dono, `postgres`, tem `rolbypassrls`. `14` §5.2
   avisa que depender desse atributo é depender de algo que nenhum teste cobre por
   padrão — então a suíte passou a cobrir: há asserção explícita de que o dono das
   RPCs tem `BYPASSRLS`. Aqui a perda do atributo falharia **fechada** (escrita
   negada), não aberta, mas quebraria a funcionalidade em silêncio. Vale decidir,
   fora desta fatia, se a fronteira de escrita de `profiles` deve continuar
   apoiada nesse atributo.
6. **Calibragem** de `idempotency_wait_timeout_ms`, junto dos seis valores do
   M0-B, a revisar com dados do piloto.
7. **Vetores dourados de canonicalização em três runtimes** (`13` §0.2, item 8).
   Dois dos três agora existem: o SQL, pelas suítes `0004`/`0009`, e o TypeScript,
   pela camada 1 da Fatia A, que reproduz os dois vetores publicados. Falta o
   runtime de job, que chega com a fatia de jobs.
8. **Teste em aparelho físico** e **validação jurídica**, ambos herdados do M0-B e
   ainda abertos.
