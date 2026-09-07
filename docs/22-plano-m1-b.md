# Plano detalhado do M1-B — exportação e exclusão governadas

Status deste documento: **normativo para sequenciamento e critérios de saída do
M1-B**. Ele não cria requisito de produto e não substitui `10`, `11`, `13`, `14`,
`16` ou `17`; quando houver divergência, esses contratos prevalecem e a fatia
para. Este plano também não autoriza deploy nem configuração do projeto remoto.
A presente fatia cria somente este documento, seu ponteiro no roadmap e sua
entrada no manifesto: nenhuma migration, função, bucket, tela ou configuração
Supabase é criada agora.

## 1. Ponto de partida comprovado

O M1-B começa em `main` depois da `0010`, não num schema hipotético:

- a `0003` já criou `public.privacy_requests`, `public.data_exports` e
  `public.deletion_requests`, com RLS, leitura própria e máquinas de estado;
- `data_exports` já representa `queued`, `building`, `ready`, `downloaded`,
  `cleanup_pending`, `expired` e `failed`, limita `expires_at` a 24 horas depois
  de `ready_at` e só permite zerar path/digest depois de purge confirmado;
- `deletion_requests.auth_user_id` deliberadamente não tem FK e sua constraint
  exige que ele seja redigido ao concluir a saga;
- a `0004`, ajustada pela `0009`/`0010`, entrega aquisição e conclusão
  idempotentes, mas sua allowlist ainda conhece apenas as quatro operações do
  M1-A;
- a `0005` já criou `private.external_effects`, `private.job_runs` e
  `private.retention_runs`. Os kinds de que este marco precisa já existem:
  `build_data_export`, `delete_data_export`, `delete_auth_user` e
  `delete_storage_object`;
- a `0006` entrega o dispatcher/guards do caminho Edge → RPC, mas não entrega
  `request_data_export`, `delete_account`, worker, Storage ou tela;
- a `0007` entrega o expurgo idempotente, mas ainda sem wrapper, agenda ou linha
  correspondente em `job_runs`.

Há duas dívidas que o M1-B precisa fechar ao tocar essas tabelas. Primeiro, a
leitura direta de `data_exports` e `deletion_requests` expõe mais colunas do que
a projeção mínima prometida em `10` §11. Como elas deixam de ter leitor direto,
a `0012` move `deletion_requests` e a `0013` move `data_exports` para `private`,
sem RLS nem grants, remove respectivamente as policies
`deletion_requests_select_own` e `data_exports_select_own` e publica apenas
funções tipadas de projeção própria. Mantê-las em `public` com policies sem
leitor contrariaria `14` §5.2 e produziria uma prova vacuamente verde. Segundo,
`external_effects` tem campos de lease, mas não tem token de fencing nem
constraints que impeçam um worker vencido de concluir a tentativa de outro.

## 2. Mapa fatia → migration

| Ordem | Fatia | Migration | Entrega que precisa ser provável | O que destrava |
| --- | --- | --- | --- | --- |
| 1 | Fundação do primeiro worker | `0011_worker_foundation.sql` | aquisição, fencing de lease, backoff, lifecycle de `job_runs`, wrappers dos jobs de identidade já existentes e Edge Function agendada; duas instâncias não adquirem a mesma linha elegível e um worker com lease vencido não consegue concluir | a fundação executável de `external_effects`, cron observável e o runtime de job que falta ao terceiro vetor dourado; nenhum kind é adquirido até uma fatia publicar seu handler |
| 2 | Saga de exclusão | `0012_account_deletion.sql` | `delete_account`, projeção mínima do pedido, cancelamento/prioridade de exports, handlers de Storage/Auth e `finalize_deletion`; crashes em cada fronteira convergem sem restaurar autoridade | o controle **Excluir conta** da tela 13 e a prova de que `deletion_pending` bloqueia domínio antes de Auth/Storage terminarem |
| 3 | Exportação e entrega one-shot | `0013_data_export_delivery.sql` | `request_data_export`, ZIP v1, expiração/purge, bucket privado, endpoint autenticado e CAS `ready→downloaded`; concorrência dá um único vencedor e queda pós-CAS consome o arquivo | o controle **Baixar meus dados** e o encerramento técnico do M1-B |
| 4 | Controles da tela 13 | —, sem migration | estados reais da exportação e exclusão, dupla confirmação, reautenticação e testes de navegador/acessibilidade; nenhum placeholder | entrega visível do marco, somente depois de os contratos anteriores estarem verdes |

O corte é deliberado. A `0011` entrega a fundação executável de aquisição,
fencing, retry e observabilidade, mas seu loop de efeitos permanece ocioso
porque ainda não existe handler publicado. A `0012` publica os primeiros
handlers e seus produtores na mesma fatia, numa saga que não exige um bucket
novo. A `0013` cria produtor, handler, artefato, expurgo e download do export na
mesma fatia; suas instruções finais de Storage são também as últimas policies de
Storage do marco, como exige `16` §3. A fatia de interface não recebe migration
artificial porque não cria estado.

A `0011` não adquire nenhum kind: a fundação genérica é consumida já pela
`0012`, e cada produtor nasce na mesma fatia do primeiro handler capaz de
reconciliá-lo. Kinds de domínios futuros, como `purge_proof_object`, também não
são adquiridos antes de a migration daquele domínio publicar seu handler.

## 3. Fatia 1 — `0011_worker_foundation.sql`

### 3.1 Runtime e local de execução

O primeiro worker roda como uma **Supabase Edge Function em Deno 2/TypeScript**,
separada do gateway de identidade. Supabase Cron (`pg_cron`) chama a função por
`pg_net`; a chamada apenas acorda o executor, que busca trabalho no banco. A
requisição de cron não leva ID de efeito, perfil, path nem instante decisório.
O banco deriva o slot e o relógio, e o worker usa a secret key injetada no
ambiente somente para chamar RPCs nominais e as APIs Auth/Storage. Ele não faz
DML direto em `public` ou `private`.

Esta é a escolha do M1-B porque:

- mantém gateway e worker no runtime já testado pelo projeto e permite
  compartilhar tipos, normalização, sanitização e harness local;
- mantém a secret key fora de bundle, banco, URL e log;
- não acrescenta fornecedor/suboperador antes do beta;
- coloca o executor perto de Auth, Postgres e Storage, mas conserva cada efeito
  fora da transação do banco;
- permite fatias curtas: cada invocação tem deadline próprio, processa unidades
  pequenas e deixa lease/retry no banco, em vez de depender da vida do isolate.

O worker **não** usa `EdgeRuntime.waitUntil` como garantia. A plataforma limita
memória, CPU e wall clock, e o ambiente local encerra tarefas de background ao
fim da requisição se não estiver configurado para mantê-las. A função aguarda o
lote que iniciou e responde só depois de persistir a conclusão ou falha. O
deadline suave é 120 segundos; o ZIP usa geração e upload em stream, sem manter
o arquivo inteiro em memória.

Alternativas descartadas:

- **SQL/`pg_cron` puro:** não pode apagar Auth/Storage nem montar/servir ZIP e
  empurraria efeito externo para dentro de uma falsa promessa transacional;
- **GitHub Actions agendada:** não oferece a cadência de um minuto do contrato,
  pode atrasar e é CI, não infraestrutura de disponibilidade do produto;
- **processo Node persistente em um novo host:** é tecnicamente válido, mas
  acrescenta deploy, segredo e suboperador sem necessidade no beta; deve ser
  reavaliado só se métricas reais excederem os limites do isolate;
- **background disparado pela requisição do usuário:** não cobre reconciliação,
  expiração nem trabalho criado quando nenhum usuário está online.

Referências operacionais da plataforma: [agendamento de Edge
Functions](https://supabase.com/docs/guides/functions/schedule-functions),
[limites das Edge Functions](https://supabase.com/docs/guides/functions/limits)
e [tarefas em background](https://supabase.com/docs/guides/functions/background-tasks).

### 3.2 Agenda

Todos os slots são UTC e são calculados no banco. A migration versiona nomes e
expressões de cron; URL pública do projeto, publishable key e o segredo dedicado
de invocação são configuração por ambiente, nunca literais no repositório. O
segredo de invocação é diferente de qualquer chave HMAC e não autoriza RPC nem
Storage. Seu valor existe apenas no Vault da plataforma e nos secrets da Edge;
o inventário registra somente o nome. Os nomes ficam fechados como
`worker_project_url`, `worker_publishable_key` e `worker_cron_secret` no Vault e
`WORKER_CRON_SECRET` na Edge. `pg_net` envia a publishable key no header de API e
o segredo dedicado no `Authorization`; a função, configurada com
`verify_jwt=false`, compara esse segredo em tempo constante antes de abrir o
cliente administrativo. Valor ausente ou divergente falha fechado sem criar
`job_runs`.

| Job | Agenda | Entra em |
| --- | --- | --- |
| `process_external_effects` | a cada minuto | `0011` |
| `health_check_jobs` | a cada 5 minutos | `0011` |
| `purge_expired_revoked_sessions` | a cada hora, minuto 17 | `0011` |
| `purge_expired_idempotency_outcomes` | diário, 03:23 UTC | `0011` |
| `purge_completed_deletion_requests` | diário, 03:43 UTC | `0012` |
| `expire_data_exports` | a cada hora, minuto 7 | `0013` |

O endpoint de cron aceita somente o enum fechado acima e ignora corpo além dele.
A RPC calcula `run_key=cron:<job>:<slot>`, insere `job_runs(running)` por unique e
devolve no-op para uma segunda chamada do mesmo slot. A próxima execução marca
run anterior abandonado como `failed/RUN_ABANDONED`; não inventa sucesso para um
isolate morto. `job_runs.summary` mantém apenas os contadores já autorizados em
`17` §3.

### 3.3 Lease, fencing e backoff

A `0011` acrescenta `lease_token uuid` a `external_effects`, fecha a coerência
dos estados e amplia de forma append-only o check de `app_limits.unit` com a
unidade `effects`, além de semear estas calibragens iniciais em
`private.app_limits`:

| Limite | Valor inicial |
| --- | --- |
| lease | 180 s |
| deadline suave por invocação | 120 s |
| tentativas máximas | 8 |
| base de backoff | 60 s |
| teto de backoff | 3.600 s |
| máximo adquirido por invocação | 10 `effects`, um por vez |

São calibragens de piloto, não requisitos imutáveis. O lease excede o deadline
suave em 60 segundos; ele não tenta superar o limite duro da plataforma.

Aquisição ocorre numa RPC curta, em `READ COMMITTED`:

1. reclassifica `leased` com `lease_until <= now()` como
   `failed_retryable/LEASE_EXPIRED`;
2. escolhe o primeiro `pending` ou `failed_retryable` vencido por
   `next_attempt_at asc nulls first, created_at, id`, usando `for update skip
   locked` e filtrando apenas kinds para os quais o runtime já publicou handler;
   o `nulls first` é explícito porque efeito novo nasce com `next_attempt_at`
   nulo e deve preceder retry em backoff;
3. grava `leased`, incrementa `attempts`, cria `lease_token` novo e fixa
   `lease_until=now()+180s`, tudo no mesmo statement;
4. devolve somente `id`, `kind`, `resource_type`, `resource_id`, `dedupe_key`,
   `attempts`, `lease_token` e `lease_until`. Path, token, e-mail e payload nunca
   entram na fila nem no resumo do job.

Toda conclusão volta por RPC e, sob row lock, exige simultaneamente `(id,
lease_token)`, `status='leased'` e `lease_until > clock_timestamp()`. A
expiração do próprio lease é a barreira escolhida: ela rejeita o worker lento
mesmo antes de outra aquisição rotacionar o token e conserva o token vencido para
reclassificação e diagnóstico. Token antigo, status diferente ou lease vencido
recebe `CONCURRENT_CHANGE` e não altera estado. Sucesso marca
`succeeded/completed_at`; erro permanente marca `dead`; erro temporário marca
`failed_retryable` e calcula `next_attempt_at` com tempo do servidor. O atraso
bruto é `min(3600, 60 * 2^(attempts-1))`; equal jitter escolhe de 50% a 100%
por hash determinístico de `effect.id || attempts`, para ser testável sem
sincronizar todos os retries. A oitava falha termina em `dead`. Só código
normalizado entra em `last_error_code`; mensagem de provedor vai apenas para
Sentry depois da sanitização.

### 3.4 Reconciliação

A `0011` fixa as primitivas e o contrato abaixo; os handlers que o cumprem são
publicados na `0012` e na `0013`, não antecipados na fundação. Cada handler
consulta o estado externo **antes** de repetir:

- delete de Storage: objeto ausente é sucesso; objeto presente é apagado, e só
  uma consulta posterior confirmando ausência permite zerar path/digest;
- delete de Auth: `not found` é sucesso; erro temporário preserva a saga e volta
  ao backoff;
- build de export: o path é determinístico. Objeto existente só é aceito depois
  de conferir o SHA-256; divergência remove o órfão antes de reconstruir;
- delete de export: tem prioridade sobre build. Build encontra perfil
  `deletion_pending` ou export cancelado, não publica `ready` e converge para o
  purge;
- lease vencido nunca prova falha do efeito externo. A nova tentativa reconcilia
  Auth/Storage e o estado de domínio antes de agir.

Crash antes do efeito apenas libera o lease por tempo. Crash depois do efeito e
antes do commit encontra o efeito externo já realizado e conclui por
reconciliação. Crash depois do commit não repete porque o status terminal e a
`dedupe_key` permanecem.

### 3.5 Provas de saída

A fatia só termina quando testes com conexões independentes provarem: dois
workers não adquirem o mesmo efeito; conclusão depois de `lease_until` é
rejeitada mesmo sem nova aquisição; fencing rejeita token velho; lease expirado
converge; trabalho novo com `next_attempt_at` nulo precede retry vencido;
backoff/teto/oitava tentativa são exatos; falha de provedor
não vaza mensagem; `service_role` segue sem `usage`/DML em `private`; cada run
fecha `job_runs`; run abandonado não vira sucesso; os vetores dourados de
canonicalização batem também no runtime do job. O harness externo usa fakes de
Auth/Storage e relógio controlado; a integração local usa somente a stack local.

## 4. Fatia 2 — `0012_account_deletion.sql`

A migration amplia de forma append-only a allowlist do envelope para
`delete_account`. O outcome persistido contém somente
`deletion_request_id` e `logical_result='deletion_requested'`; status atual vem
de projeção fresca. A RPC recebe o mesmo contexto interno das operações do M1-A,
conquista idempotência antes dos locks e, na mesma transação:

1. trava perfil e verifica pedido anterior;
2. executa o guard de substituto financeiro. No schema do M1-B grupos e casos
   ainda não existem, portanto o conjunto é vazio; migrations futuras estendem
   a primitiva quando criarem esses domínios, sem relaxar o contrato;
3. cancela exports: `queued/building` não chegam a `ready`; todo objeto existente
   passa a `cleanup_pending` e recebe `delete_data_export:<export_id>`;
4. cria `deletion_requests`, preservando o Auth ID apenas nessa saga restrita;
5. muda o perfil para `deletion_pending`, grava a sessão atual na denylist e
   remove a autoridade de domínio no mesmo commit;
6. enfileira os deletes de Storage conhecidos; quando não resta objeto, a
   reconciliação cria uma única `delete_auth_user:<request_id>`.

O worker avança `requested → cleaning_storage → deleting_auth → finalizing`.
`finalize_deletion` roda por RPC nominal: exige Auth ausente, zera
`auth_user_id`, troca nome por rótulo aleatório não reversível, zera apelido,
foto, posição, pé e camisa, marca `deleted/deidentified_at`, redige Auth ID e
erro da saga e conclui. A linha identificável da saga é redigida/expurgada depois
de conclusão + 90 dias; `retention_runs` guarda só contagens.

A `0012` revoga a leitura direta de `deletion_requests`, remove a policy
`deletion_requests_select_own`, desliga `force`/RLS e move a tabela para
`private`, atualizando suas dependências com nomes qualificados. A projeção própria tipada expõe somente
`id`, `status`, `requested_at`, `completed_at` e um indicador booleano de falha
operacional; nunca Auth ID, tentativa, próximo retry ou código interno. O shell
`deletion_pending` pode consultar apenas essa projeção/canal de privacidade,
mesmo com a sessão colocada na denylist; nenhuma outra leitura ou RPC de domínio
recebe essa exceção. Quando Auth desaparecer, a UI conserva apenas o protocolo e
deixa de afirmar um status que já não consegue verificar.

No mesmo commit da `0012`, o bloco SQL normativo de `10` §2 — onde a declaração
está na linha 101, não no §9 — passa a dizer
`create table private.deletion_requests`. A fatia recalcula no manifesto o
checksum de todo documento normativo alterado; migration e contrato de schema
não podem divergir entre commits.

As provas mínimas incluem idempotência/conflito/rollback; bloqueio atômico sem
substituto; JWT antigo sem acesso de domínio logo após o commit; prioridade do
purge sobre build; Storage 404 e Auth not-found como sucesso reconciliado; crash
em cada fronteira; finalize recusado enquanto Auth/objeto existir; e dump sem
Auth ID, path, token ou PII em idempotência, efeitos, jobs e erros. Um papel-sonda
sem `BYPASSRLS`, com contexto de titular, precisa consultar a projeção com sucesso
e falhar ao tentar `select` direto em `private.deletion_requests`; outra identidade
não vê a linha. Assim a ausência de acesso direto não passa por falta total de um
leitor funcional.

## 5. Fatia 3 — `0013_data_export_delivery.sql`

### 5.1 RPC e artefato

`request_data_export` amplia o envelope de forma append-only. O outcome guarda
somente `export_id` e `logical_result='data_export_requested'`; `queued` é a
projeção fresca inicial, não estado congelado no livro. Sob idempotência e lock
do perfil, a RPC cria `privacy_requests(kind='access')`,
`data_exports(queued)` e `build_data_export:<export_id>` no mesmo commit; o efeito
novo conserva `next_attempt_at` nulo e é servido pelo `nulls first` da aquisição.
Um índice parcial garante no máximo um export ativo por perfil; pedido novo durante
`queued|building|ready|downloaded com path|cleanup_pending` retorna
`EXPORT_ALREADY_PENDING`.

O ZIP é determinístico e usa schema `colete-export-v1`. Entradas têm nomes
fixos, ordem lexical, JSON UTF-8/JCS, timestamps UTC e ZIP `store` sem compressão,
mtime constante e sem extra fields variáveis. Isso permite reconstruir e
comparar bytes depois de crash. `manifest.json` enumera versão, instante do
snapshot, arquivos, tamanho e SHA-256 de cada entrada; o SHA-256 do ZIP inteiro
vai para `data_exports.content_digest`.

No estado existente do M1-B, a allowlist é:

- `profile.json`: ID técnico, nome, apelido, posição, pé, camisa, status e
  criação;
- `auth.json`: e-mail verificado e nomes dos provedores vinculados; sem senha,
  hash, token, session ID, refresh token ou segredo;
- `policy-acceptances.json`: tipo, versão, fonte e instante;
- `privacy-requests.json`: tipo, status, resposta e instantes do próprio
  titular;
- `data-exports.json`: IDs, status e instantes dos exports próprios, sem path ou
  digest;
- `manifest.json` e `LEIA-ME.txt`, que explicam escopo, one-shot e exclusões.

Cada marco futuro que criar categoria do inventário precisa ampliar essa
allowlist e seus testes na mesma migration. Nunca entram credencial; Pix; prova
ou fingerprint; HMAC/digest secreto; push; path/URL/token; log técnico; payload
privado; binário; conteúdo integral de política; nem PII de terceiro além do
mínimo contextual que uma categoria futura definir em `17`. `data-exports` não
é JSON em tabela nem cache offline.

### 5.2 Bucket e policies

O bucket `data-exports` nasce privado, com limite inicial de 50 MiB e MIME único
`application/zip`. O path interno é
`exports/<profile_id>/<export_id>.zip`, é imutável e nunca chega ao cliente. O
worker envia com overwrite desabilitado, `Cache-Control: no-store` e digest
conferido antes de publicar `ready`. O teto coincide com o limite local de
Storage já versionado e é conservador porque o ZIP exclui todos os binários;
excesso vira falha operacional normalizada e o valor é recalibrado com métricas
do piloto, sem aceitar arquivo parcial.

As policies de cliente são **zero**: `anon` e `authenticated` não selecionam,
inserem, atualizam ou apagam `storage.objects` desse bucket. Criar policy para
`service_role` seria decorativa, porque a secret key ignora RLS; o controle real
é que somente as Edge Functions nomeadas recebem a chave e elas chamam APIs/RPCs
estreitas. A suíte prova bucket privado, MIME/limite, ausência de policy cliente,
ausência de signed URL e impossibilidade de acesso direto mesmo pelo dono.

O bucket fica fora de backup. `14` §5.1 e `17` §5 proíbem restaurar export
temporário; restore recria bucket/policies vazios pelas migrations e reaplica
purges antes de liberar tráfego.

Download passa pela Edge autenticada porque uma signed URL sobrevive até o
próprio prazo, não reconsulta denylist/deletion status, não faz CAS one-shot e
expõe uma capacidade reutilizável fora do controle do app. A Edge revalida cada
requisição, esconde o path, grava o consumo e faz stream direto, sem redirect e
sem cache.

### 5.3 `GET /data-exports/:id/content`

A rota valida assinatura/audience do JWT, `auth_user_id`, `session_id`, denylist
e titularidade. Como decisão nova deste plano, e não regra herdada dos documentos
anteriores, reautenticação é provada pelo timestamp de método em `amr`, nunca por
`iat`: refresh de token não é nova autenticação. A janela aprovada é de 300
segundos. Ausência de método elegível ou idade acima dessa janela retorna
`RECENT_REAUTH_REQUIRED` antes de tocar o export.

Depois, uma RPC interna nominal executa uma transação curta:

1. resolve o perfil pelo Auth ID e trava `data_exports` por ID;
2. exige dono correto, `status='ready'` e `now()<expires_at`;
3. faz o compare-and-set `ready→downloaded`, grava `downloaded_at=now()` e
   commita;
4. devolve path e digest **somente à Edge**, nunca no envelope HTTP do cliente.

Só depois desse commit a Edge abre o objeto e inicia o stream com
`Content-Type: application/zip`, `Content-Disposition: attachment` e
`Cache-Control: private, no-store`; não há redirect. Uma segunda chamada,
inclusive concorrente, recebe `EXPORT_EXPIRED`.

O stream envolve conclusão, cancelamento e erro. Nos três casos a Edge tenta
enfileirar `delete_data_export:<export_id>` depois de fechar o leitor. Se a
função ou conexão morrer antes desse enqueue, `expire_data_exports` também
varre todo `downloaded` ainda com path e cria a mesma `dedupe_key`. O worker
confirma ausência do objeto antes de zerar path/digest e marcar `purged_at`.

Queda depois do CAS consome o one-shot mesmo que zero bytes cheguem ao aparelho.
O cliente não retoma, não recebe nova URL e não reabre o arquivo: mostra que a
tentativa foi consumida e oferece **Gerar novo export** depois do purge. Essa
assimetria é intencional; tentar inferir pelo socket se a pessoa recebeu todos os
bytes produziria dois downloads possíveis.

Antes de criar a projeção tipada, a `0013` revoga a leitura direta de
`data_exports`, remove a policy `data_exports_select_own`, desliga `force`/RLS e
move a tabela para `private`, atualizando dependências e referências
qualificadas. A projeção não expõe path nem digest.

No mesmo commit da `0013`, o bloco SQL normativo de `10` §2 — onde a declaração
está na linha 118, não no §9 — passa a dizer
`create table private.data_exports`. A fatia recalcula no manifesto o checksum
de todo documento normativo alterado, pela mesma regra de atomicidade entre
migration e contrato de schema.

O logout não remove nem enfileira purge do artefato. A enumeração de `16` §4
define fluxos de teste separados e uma invariante comum — nenhum permite segundo
download —, não um efeito de remoção compartilhado por todos. Conforme `13`
§5.3, o endpoint exige sessão não revogada e reautenticação recente; depois de
`revoke_current_session`, a denylist criada na `0003` faz a mesma sessão falhar
antes do CAS ou do stream. O artefato permanece até download, exclusão ou
expiração convergir para purge, preservando `13` §5.5 sem efeito externo.

### 5.4 Provas de saída

Além de pgTAP de grants, constraints, projeções e policies, o harness abre
requisições concorrentes reais e prova um único CAS vencedor. Prova também JWT
revogado, outro titular, export vencido, reauth velha/ausente, stream sem cache
nem redirect, queda pós-CAS, purge após abort, reconciliação sem callback,
Storage inacessível diretamente e ausência de path/digest no cliente. Fixtures
do ZIP verificam byte a byte a ordem, o manifesto, todos os SHA-256 e a
allowlist negativa. Contraprovas injetam campo proibido e signed URL e precisam
falhar. Um papel-sonda sem `BYPASSRLS`, com contexto de titular, precisa ler a
projeção com sucesso, falhar no `select` direto em `private.data_exports` e não
ver linha de outro titular; a prova não pode rodar apenas como `postgres`. O
harness também prepara um export `ready`, conclui `revoke_current_session` e
tenta baixá-lo com o mesmo JWT: o endpoint precisa recusar antes do CAS e não
alterar nem apagar o artefato. A contraprova executa a mesma jornada com a
checagem de sessão revogada removida e precisa falhar ao observar que o download
seria aceito; uma asserção que só confira o estado intacto do arquivo não prova a
denylist.

## 6. Fatia 4 — controles da tela 13

Os controles entram juntos, somente depois das três migrations e dos endpoints.
Não existe botão escondido ou desabilitado antes disso.

Os estados abaixo estendem explicitamente o contrato de apresentação de `11`
§3, tela 13. `downloaded|cleanup_pending` não pode ser mostrado como `expirado`,
porque a tentativa única foi consumida, e `failed` não pode ser escondido como
`preparando`; distinguir ambos é necessário para a tela não prometer uma ação
incorreta sobre estados que o schema já representa.

### Baixar meus dados

| Estado de banco | O que a tela mostra | Ação |
| --- | --- | --- |
| `queued` ou `building` | **Preparando seus dados**, explicação do conteúdo/exclusões e atualização não otimista | atualizar status; nenhum download |
| `ready` e ainda válido | **Pronto para baixar**, validade em horário absoluto e aviso de tentativa única | **Baixar agora**; se necessário, conduz à reautenticação e volta à mesma intenção |
| `expired` | **Export expirado** | **Gerar novo export**, com novo `request_id` |
| `downloaded` ou `cleanup_pending` | **Download já consumido**, inclusive se a conexão caiu | aguarda purge e então oferece novo export |
| `failed` | erro honesto sem detalhe interno | tentar gerar novamente quando o pedido deixar de estar ativo; suporte se repetir |

O pedido inicial conserva `request_id` em retry de transporte. A ação consciente
de gerar outro export cria outro ID. O arquivo não entra em cache offline,
histórico do service worker ou armazenamento local.

### Excluir conta

O primeiro passo explica anonimização, perda de acesso imediata, limpeza
assíncrona e bloqueios de titularidade/caso. A primeira confirmação abre um
resumo final; a segunda exige checkbox explícito e botão destrutivo com rótulo
**Excluir minha conta**. Erro `FINANCIAL_SUBSTITUTE_REQUIRED` mostra a ação
normativa de transferir titularidade/caso; não oferece contorno.

Depois do sucesso, a área autenticada vira o shell restrito do pedido: mostra
protocolo e estados `requested|cleaning_storage|deleting_auth|finalizing` como
**Exclusão em andamento**, `failed_retryable` como atraso com canal de suporte e
`completed` como concluído. Nenhuma navegação de domínio permanece. Se Auth for
apagado antes da próxima consulta, a tela conserva o protocolo localmente, deixa
de alegar status verificável e encaminha ao canal de suporte; não recria sessão.

As duas jornadas recebem estados de carregamento/erro/tentar novamente, foco
gerenciado, live region, alvos de 44 px, tema/reflow e passada automatizada axe.
Teste de navegador inspeciona requests para provar que body nunca contém
Auth/profile/session/HMAC/path e que queda após iniciar o download não dispara
retry automático.

## 7. O que fica fora do M1-B

- textos/digests legais efetivos e interface de aceite: dependem da validação
  jurídica pré-beta já registrada;
- Google OAuth, vínculo/desvínculo e bucket `avatars`/`photo_url`: são contratos
  independentes e não podem ser puxados pelo export;
- rate limit produtivo do gateway: dívida própria do M1-A, com armazenamento de
  contadores ainda por decidir;
- grupos, ownership real, casos financeiros e suas transferências: M2/M5
  estendem a primitiva de exclusão quando suas tabelas nascerem;
- comprovantes, Pix, notas, sorteio, notificações, legal holds e as retenções
  correspondentes: pertencem aos marcos de domínio;
- handlers/agendas de `purge_proof_object`, reconciliação de rachas,
  notificações e demais jobs futuros: a `0011` não adquire kind sem consumidor;
- execução do runbook remoto, deploy, secrets reais, criação de projeto,
  publicação ou leitura do Supabase remoto: esta sequência produz código e
  testes locais; cada ação externa exige autorização própria;
- app nativo, Apple Sign In e push: estão fora do caminho crítico do beta PWA.

## 8. Decisões e gates humanos

Duas decisões antes abertas estão fechadas para a implementação:

- a janela de reautenticação recente para exportar é **300 segundos**. Este plano
  escolhe `amr`, nunca `iat`, como decisão nova do M1-B, porque refresh de token
  não comprova nova autenticação;
- a operação aceita formalmente **RPO de 24 horas e RTO de 24 horas**. Continuam
  pendentes os passos técnicos do gate de `16` §2: implementar o export diário
  por allowlist e aprovar o primeiro restore isolado.

Permanecem abertas somente estas perguntas, que **não podem ser preenchidas pela
implementação**:

1. A validação jurídica aprova os papéis controlador/operador, bases legais,
   prazos candidatos — inclusive aceite/pedido por cinco anos — e a allowlist de
   campos do `colete-export-v1`? Sem aprovação, o sistema pode ser testado, mas
   não convidar o beta.
2. Quem é o responsável operacional e qual é o canal real de suporte/alerta para
   `dead`, `RUN_ABANDONED`, exclusão atrasada e pedido bloqueado? Sentry é o
   transporte técnico, não uma definição de plantão nem um canal ao titular.

Nenhuma dessas respostas muda a numeração. Se uma decisão exigir contrariar
`13`, `14`, `16` ou `17`, o trabalho para antes de qualquer migration.

## 9. Manifesto de especificação

Este plano entra em `docs/spec-manifest.sha256`. Diferente de `19`, `20` e `21`,
ele não relata uma execução passada: fixa a numeração `0011`–`0013`, a ordem, a
fronteira do worker, o protocolo de lease, a política do bucket e os critérios de
saída que as próximas fatias precisam obedecer. Portanto é especificação de
implementação e precisa falhar por drift. Com sua inclusão, a baseline passa de
22 para 23 entradas. O documento operacional do M1-B, quando existir, ficará
fora do manifesto pelo mesmo precedente dos três marcos anteriores.
