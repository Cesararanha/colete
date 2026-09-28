# Plano detalhado do M2 — grupos, reentrada, papéis e convites

Status deste documento: **normativo para sequenciamento e critérios de saída do
M2**. Ele não cria requisito de produto e não substitui `09`, `10`, `11`, `13`,
`14`, `15`, `16` ou `17`; quando houver divergência, esses contratos prevalecem
e a fatia para, ressalvadas as pendências com prazo expressamente decididas no
§8. Este plano também não autoriza deploy, configuração do projeto
remoto nem criação de segredo real. A fatia que o criou trouxe somente este
documento, seu ponteiro no roadmap e sua entrada no manifesto. A emenda de
2026-09-25 aplica as decisões humanas M2-D1 a M2-D3 do §8 e, por elas, altera
também `01`, `11` §6, `16` §3 e `AGENTS.md`. A emenda de 2026-09-26 aplica as
decisões humanas M2-D4 a M2-D7 do §8 e os achados A1 a A16 da terceira revisão
independente e, por elas, altera também `10` §11, `11` §6, `13` §5, `16` §3 e
§8 e `AGENTS.md`. A terceira emenda, também de 2026-09-26, aplica as decisões
humanas M2-D8 a M2-D11 do §8 e corrige a prova de vaga liberada da `0015` no
§3.3; ela altera somente este documento. A quarta emenda, também de
2026-09-26, delimita o que a `0016` prova sobre remoção (§2 e §4.3), declara no
§4.2 que as regras de reentrada são executadas pelo resgate da `0017`, dá a cada
uma prova própria no §5.4 e registra no §8.2 os comportamentos que elas deixam
indefinidos; ela também altera somente este documento. A quinta emenda, também
de 2026-09-26, aplica a decisão humana M2-D12 do §8, que fixa a semeadura do
cenário “último uso” da UI-A no §6.3, e os achados R1, R3, R4 e R5 da revisão
curta das emendas 2 a 4; ela também altera somente este documento. A sexta
emenda, de 2026-09-27, aplica a decisão humana M2-D13 do §8, que fixa no §2 o
modo de lock das travas de domínio e o par cruzado que o prova, a partir do achado
P1 da revisão do PR #36, e corrige no §3.3 a descrição da prova do guard; por ela,
altera também `10` §10. A sétima emenda, também de 2026-09-27, aplica a decisão
humana M2-D14 do §8, que corrige no §2 a nota sobre o M1-B e manda a `0015`
redefinir as funções que gravam idempotência e travam o perfil do próprio ator;
ela altera somente este documento. A oitava emenda, também de 2026-09-27, aplica
a decisão humana M2-D15 do §8, que registra no §8.2, com prazo, as nove travas
`FOR UPDATE` do M1-B fora da regra da M2-D13, e substitui no §3.3 a descrição da
prova do guard pelas duas provas que a fatia entrega, a partir da segunda
revisão do PR #36; ela também altera somente este documento. A nona emenda, de
2026-09-28, aplica as decisões humanas M2-D16 a M2-D18 do §8, que fixam a recusa
em `approve_member`, o erro de `set_role` e `set_monthly` sobre alvo sem
membership `active` e o destino do `reason` de `remove_member`, e retira do §8.2
os três indefinidos correspondentes; por elas, altera também `13` §5. Ela chega
no mesmo commit da `0016`. A décima emenda, também de 2026-09-28, registra
as decisões humanas M2-D19 e M2-D20 do §8: os quatro comportamentos aceitos na
primeira revisão do PR #40 e a mesma autoridade atual no replay e na chamada
nova. Por elas, emenda também `13` §0 e §5. A correção ocorre no commit único
da `0016`, ainda em draft. A décima primeira emenda, também de 2026-09-28,
aplica a M2-D20 emendada e a M2-D21: todo replay conserva o desfecho, com
`current` somente se autorizado agora; a autorrevogação da exclusão tem exceção
própria, e o replay do export é divergência com prazo na mesma migration da
M2-D15. Por elas, emenda também `13` §0, §5 e §5.3 no commit único da `0016`.
O ajuste de segurança de 28/09 à M2-D20 distingue autenticação de autoridade
no grupo: replay sem autenticação devolve o erro normal, sem desfecho; a
exceção de `delete_account` permanece. Ele alinha §4.1 e a pendência do §8.2
ao ajuste registrado no §8.1, sem corrigir RPC fora da `0016`.
As emendas documentais não criam migration, função,
bucket, tela ou configuração Supabase por si mesmas.

## 1. Ponto de partida comprovado

O M2 começa em `main` depois da `0014`, não num schema hipotético:

- `public.profiles` já fornece identidade interna, estado da conta e o lock-pai
  da cota pessoal. `deletion_pending|deleted` já remove autoridade de domínio;
- a `0004`, ajustada pelas migrations posteriores, entrega o envelope
  idempotente transacional e o trigger diferido que precisa ser provado por um
  commit real sob `service_role`;
- a `0006` entrega o dispatcher, os guards do caminho Edge → RPC e o grant
  nominal. `service_role` continua sem DML direto e com `BYPASSRLS`, razão pela
  qual sua fronteira é feita por privilégios, não por policies;
- a `0011` entrega `private.external_effects`, lease, fencing, backoff, runtime
  do worker, jobs observáveis e a allowlist fechada de kinds publicados;
- a `0012` entrega `delete_account` e chama
  `private.require_financial_deletion_substitute(profile_id)` antes de remover
  autoridade. O helper ainda valida somente o perfil porque grupos e casos não
  existiam;
- a `0013` entrega `private.deletion_has_pending_storage(request_id)`, usada
  tanto pela reconciliação quanto pelo gate que impede `delete_auth_user`. A
  lista fechada atual conhece apenas `build_data_export`, `delete_data_export`
  e `delete_storage_object`, e este último somente com
  `resource_type='profile_avatar'`;
- a `0013` também fixou a ordem real perfil → export e trouxe, com duas conexões,
  evidência com espera temporizada de que build concorrendo com exclusão não
  produz `SQLSTATE 40P01`; a `0015` refaz a prova com a barreira do §2;
- a `0014` unificou os slots UTC do worker e fez efeito Auth vencido convergir
  depois de a saga já estar concluída.

Ainda não existem `groups`, `group_members`, `group_invites`, policies de grupo,
RPCs de membership, material de convite, rota Edge de convite nem as telas 10,
11, 12, 16, 17, 24 e 25.
Consequentemente, o guard de substituto opera sobre conjunto vazio e nenhuma
foto de grupo participa do fence de Storage da exclusão. Essas não são exceções
permanentes: são os dois pontos de extensão obrigatórios da primeira fatia.

## 2. Mapa fatia → migration

| Ordem | Fatia | Migration | Entrega que precisa ser provável | O que destrava | Revisão independente esperada |
| --- | --- | --- | --- | --- | --- |
| 1 | Fundação, isolamento e extensão da exclusão | `0015_group_foundation.sql` | tabelas/constraints, RLS default-deny, owner derivado, trigger diferido, limites canônicos, extensão da exclusão (§3.3), fence de Storage da foto de grupo por `delete_storage_object` com `resource_type='group_photo'` e extensão do `colete-export-v1` com `groups.json` | um domínio de grupos seguro para as RPCs; a saga não pode apagar Auth deixando ownership, membership ou foto de grupo para trás | **4 rodadas:** schema/constraints; RLS e privilégios com papel-sonda; saga/Storage/export e crashes; locks/commit real/privacidade |
| 2 | Membership, papéis e titularidade | `0016_group_membership_rpcs.sql` | `approve_member`, `remove_member`, `set_role`, `set_monthly`, `set_ratings_visibility`, `transfer_ownership` e `leave_group`, **sem `create_group`**, operando sobre grupos de fixture; quinta/sexta membership serializada pelo perfil; a recontagem de capacidade em `approve_member` é defesa, sem corrida própria; suspensão fail-closed | administração transacional do grupo sem convite e extensão segura futura para rachas/finanças | **5 rodadas:** envelope e grants; concorrência/cota; owner/remoção e estado `removed`/suspensão; exclusão × membership e retenção; caminho HTTP real e contraprovas |
| 3 | Convites, reentrada, HMAC e criação | `0017_group_invites.sql` | material, cofre, código, link, compartilhamento, revogação, expiração, esgotamento, rotação, resgate e `create_group` com convite inicial | entrada pendente, reentrada explícita, criação real de grupo e critério de saída criptográfico do M2 | **6 rodadas:** formato/vetores; cofre/rotação/instrumentos de vazamento; locks/capacidade; HTTP/log/referrer/rate limit; RLS/projeções/preview e abuso; `create_group` e convite inicial |
| 4 | UI-A (entrada e convite) | —, sem migration | telas 10 (lista), 11 (detalhe), 12 (entrar por código/link), 16 (criar) e 24 (convite), com navegação Grupos/Perfil | criação, convite, preview e entrada pendente visíveis sobre contratos reais, somente com estados alcançáveis sem depender das telas da UI-B; o estado que exige aprovação é preparado pela Edge real (M2-D12) | **5 rodadas:** estados/requests e ausência de controle sem RPC; lista integral de `15` §1 e reflow; passada manual com leitor de tela e teclado; E2E pelo gateway produtivo, resgate/preview e segurança de link/token; regressões M0–M1 e privacidade |
| 5 | UI-B (decisão e titularidade) | —, sem migration | telas 17 (aprovar e gerir) e 25 (configurações e transferência) | aprovação, gestão de membros e titularidade visíveis sobre contratos reais | **5 rodadas:** estados/requests e ausência de controle sem RPC; lista integral de `15` §1 e reflow; passada manual com leitor de tela e teclado; E2E de aprovação/remoção/transferência e segurança de token; regressões M0–M1, UI-A e privacidade |

Depois da fatia 5, o M2 só fecha após **uma rodada integral pós-marco**,
equivalente à que produziu o PR #30 no M1-B: revisão independente do marco
inteiro, com achados corrigidos e suíte completa verde antes do fechamento.

O corte é deliberado. A `0015` cria juntas as três tabelas porque as FKs, o
owner derivado, a capacidade e o isolamento precisam ser provados como um grafo;
na mesma migration ela salda as extensões que a existência de `groups` torna
obrigatórias. A `0016` usa esse grafo sem misturar segredo ou parsing de token e
concentra as corridas de membership/titularidade sobre grupos criados por
fixture. A `0017` só então adiciona a fronteira criptográfica, o consumo de
convites e a criação de grupo, permitindo revisar HMAC, URL e logs sem esconder
defeito de capacidade dentro do mesmo diff. A interface vem por último, em duas
fatias, e não recebe migration artificial. A divisão entre elas segue a
alcançabilidade do estado de domínio (M2-D5): a UI-A (entrada e convite) só
exercita estados alcançáveis sem depender das telas da UI-B — dono sozinho,
`OWNER_MUST_TRANSFER`, preview e pedido próprio pendente —; o estado que exige
aprovação é preparado pela Edge real (M2-D11, M2-D12), e a UI-B (decisão e
titularidade) reúne as provas que exercitam a aprovação pela interface.

`create_group` mora na `0017`, não na `0016`: `13` §5 obriga a função a devolver
`{ group_id, invite_id }` e `group_invites.token_digest` é `not null` em `10` §3.
A função não existe sem criar o convite inicial, e o convite não existe sem o
digest HMAC, cuja chave e cujo formato nascem na `0017`. Uma `create_group` na
`0016` teria de inventar digest provisório ou devolver saída diferente do
contrato. Nenhuma tela usa adaptador, estado ou botão sem RPC atrás.

O orçamento é uma expectativa mínima, não autorização para merge por contagem.
Cada rodada deve ter revisor independente, contraprova que falhe com o defeito e
registro do que cobriu. Achado que cruza duas áreas reabre ambas; uma fatia só
fecha quando todos os achados estão corrigidos e a suíte completa volta a verde.

### Ordem global de locks do M2 em diante

A ordem normativa passa a ser, sem retirar nenhum nível de `09` D37, `10` §1 ou
`13` §0:

```text
idempotência → perfis → grupos → memberships → recorrências → rachas → convites
→ participantes/claims → ciclos → sessões/provas
→ resoluções/estornos/contestações/casos → exports
→ pedidos de exclusão
```

Perfis, grupos, memberships e demais UUIDs do mesmo nível são travados pelos
bytes crescentes. A leitura necessária apenas para descobrir a chave do pai não
trava o filho: por exemplo, `join_by_invite` lê o `group_id`, trava perfil e
grupo, trava a membership e só então trava/revalida o convite. `delete_account`
resolve sem lock, entre a idempotência e o primeiro lock de perfil, os
organizadores candidatos à transferência (§3.3); trava em bytes crescentes o
perfil do titular e os dos candidatos, depois todos os grupos próprios e os
grupos das demais memberships `pending|active` do titular em ordem crescente,
suas memberships, e somente então exports, pedido e efeitos. Elegibilidade e
titularidade são revalidadas sob lock.

Handlers do worker podem travar a própria linha de efeito antes do domínio,
desde que nenhum caminho trave uma linha de efeito já existente depois de
perfil/grupo/export/pedido, exceto aquisição com `SKIP LOCKED`, que nunca espera,
e `insert … on conflict do nothing` de chave nova. `external_effects` fica fora
da ordem total por essa assimetria, e todo handler novo prova isso com harness
nas duas ordens. O precedente é `worker_get_data_export_build_target` na `0013` (linhas 988–999),
que trava o efeito `for update` e só depois o perfil. Aquisição e conclusão do
lease continuam transações curtas.

Essa extensão preserva perfil → export, já provado no M1-B, e coloca todo o novo
domínio de grupos antes dele. Harness com conexões independentes executa, nas
duas ordens, exclusão × transferência, exclusão do dono × exclusão do
organizador escolhido, exclusão × criação/entrada, rotação × resgate e aprovação
× saída; `40P01` reprova a fatia, não é retry normal.

**Modo de lock (M2-D13).** Travas de domínio usam `FOR NO KEY UPDATE`, como
`10` §10 exige. `FOR UPDATE` só é usado quando a transação apaga a linha ou altera
a chave dela, o que o domínio do M2 não faz: perfis são desidentificados e grupos
são arquivados. O motivo é um lock implícito anterior à ordem acima. Todo registro
de idempotência tem FK `actor_id → profiles` (`0004`, linha 28), e inseri-lo trava
o perfil do ator em `FOR KEY SHARE` até o commit, **antes** dos locks ordenados
desta seção. `FOR UPDATE` conflita com `FOR KEY SHARE`: se cada uma de duas
transações trava o perfil da outra, cada uma espera pelo `KEY SHARE` que a outra
tomou na idempotência, e o ciclo termina em `40P01`, como o achado P1 da revisão
do PR #36 reproduziu em `delete_account`. `FOR NO KEY UPDATE` não conflita com
`FOR KEY SHARE`, mas conflita consigo mesmo, com `FOR UPDATE` e com `UPDATE`;
por isso a serialização entre transações de domínio continua.

O ciclo não precisa de dois perfis alheios por transação: basta um. Em
`approve_member`, A aprova o pedido de B no grupo G1 enquanto B aprova o pedido de
A no grupo G2; cada transação segura o `KEY SHARE` do próprio perfil e pede o
perfil da outra, e com `FOR UPDATE` isso já produz `40P01`.

Toda operação cuja ordem de locks (§3.3, §4.1, §5) inclui o perfil de uma pessoa
diferente do ator prova, pela barreira abaixo, um par cruzado em que cada
transação trava o perfil da outra, nas duas ordens, sem `40P01`. O detentor
segura `FOR NO KEY UPDATE` no perfil alheio que A trava: A fica em espera, e a
idempotência de B, que toma `FOR KEY SHARE` nesse mesmo perfil, não é
bloqueada. A contraprova troca o modo por `FOR UPDATE` e precisa reproduzir o
`40P01`. Conferidas na ordem de locks deste plano, enquadram-se:

- `0015`: `delete_account`, que trava os perfis dos organizadores candidatos
  (§3.3);
- `0016`: `approve_member`, `remove_member` e `set_role`, que travam o perfil
  alvo; `set_monthly`, quando o alvo não é o ator; e `transfer_ownership`, que
  trava o perfil do novo owner (§4.1). `set_ratings_visibility` e `leave_group`
  travam somente o perfil do ator e ficam fora;
- `0017`: nenhuma pela ordem declarada no §5. `create_group`, `join_by_code` e
  `join_by_invite` travam somente o perfil do ator, e a rotação trava somente
  convites. `get_invite_share_link`, revogar e regenerar ainda não têm ordem
  fixada no §5.2; entram na regra se a ordem deles vier a incluir perfil de outra
  pessoa.

Os pares do parágrafo anterior entre duas operações enquadradas, como exclusão ×
transferência, também rodam na forma cruzada quando a topologia permite.

**Mesmo ator (M2-D14).** `FOR UPDATE` no perfil do próprio ator também fecha
ciclo. Duas chamadas concorrentes da mesma pessoa com `request_id` diferentes
(dois cliques, duas abas) inserem cada uma o próprio registro de idempotência e
seguram, pela FK, `FOR KEY SHARE` no mesmo perfil. Quando as duas pedem
`FOR UPDATE` nesse perfil, cada uma espera o `FOR KEY SHARE` da outra: é um
upgrade que nenhuma consegue completar, e o ciclo termina em `40P01`. A
serialização que `FOR UPDATE` oferece só existe entre transações que ainda não
seguram lock na linha; para o mesmo ator, depois da idempotência, ela não existe.

Por isso a `0015` redefine com `FOR NO KEY UPDATE`, além de `delete_account`,
toda função do M1-B que grava idempotência e depois trava o perfil do próprio
ator: `update_profile` (`0006`, linha 613) e `request_data_export` (`0013`,
linha 823). A auditoria pelo banco vivo depois do `db:reset` não encontrou outra:
`accept_policies`, `complete_profile` e `revoke_current_session` gravam
idempotência sem travar o perfil. A `0015` também redefine, pela extensão da
exclusão e do export, `worker_get_deletion_effect_target`,
`worker_confirm_deletion_effect` e `worker_get_data_export_build_target`, e
aplica a regra às travas delas; `worker_confirm_deletion_effect` mantém
`FOR UPDATE` no export porque zera `storage_path`, coluna única. Do M1-B,
continua em `FOR UPDATE` no perfil somente `finalize_deletion` (`0013`, linha
1132, que substituiu o corpo da `0012`, linha 785): é do worker, não grava
idempotência e altera a chave do perfil ao zerar `auth_user_id`, o caso em que a
regra manda `FOR UPDATE`. As demais travas `FOR UPDATE` do M1-B recaem sobre
efeitos, exports, pedidos de exclusão e execuções de job, não sobre perfil, e
passam à regra quando alguma migration as reescrever.

Cada função redefinida pela M2-D14 prova, no harness do seu domínio, o par do
mesmo ator com `request_id` diferentes pela barreira abaixo, nas duas ordens,
com a contraprova em `FOR UPDATE` reproduzindo o `40P01`, e uma repetição de 20
pares sem barreira que reprova com qualquer `40P01`. O resultado exigido é o do
contrato: em `request_data_export`, um pedido vence e o outro recebe
`EXPORT_ALREADY_PENDING`; em `update_profile`, as duas chamadas são serializadas
e as duas mutações sobrevivem. No par do mesmo ator, o detentor segura o perfil
em `FOR NO KEY UPDATE`, compatível com os dois `FOR KEY SHARE`; como cada
transação já segura lock na linha, o PostgreSQL não enfileira a segunda atrás da
primeira, e o detentor esperado da espera de B é o próprio detentor.

**Barreira de concorrência, obrigatória em toda fatia.** Cada par roda em duas
conexões dedicadas, com `application_name` distinto, nas ordens A→B e B→A. A
segunda só é liberada depois de o harness OBSERVAR `wait_event_type='Lock'` do
backend concorrente em `pg_stat_activity`, e a asserção falha se a espera não
for observada. Nas provas N-way, o harness afirma que ao menos N−1 transações
esperaram lock. `setTimeout` não é barreira.

Toda promessa de competidor recebe tratador na mesma instrução síncrona que a
cria, antes de qualquer `await` (`Promise.allSettled` sobre o conjunto ou
`.then(valor, erro)`), e a asserção sobre o resultado vem depois, explícita. A
espera pela barreira é um laço com prazo que, a cada volta, consulta
`pg_stat_activity` e o estado das promessas: competidor que termina antes de a
espera ser observada reprova a prova com a causa, sem derrubar o processo; prazo
excedido reprova com o retrato de `pg_stat_activity`. A espera observada é a do
`pid` do competidor e precisa ter o `pid` do detentor esperado em
`pg_blocking_pids`. Para provar ausência de `40P01`, o detentor segura o segundo
recurso da transação A, de modo que A fique parada entre duas aquisições, e só
então B começa. As conexões fecham em `finally` com `Promise.allSettled`, e o
harness registra `process.on('unhandledRejection')` que falha o teste. O
tratador existe para reprovar com a causa, nunca para engolir a rejeição.
Engolir continua proibido. Provas de concorrência chamam a RPC interna em
conexões dedicadas, sob `set local role service_role` e com commit real; o
caminho HTTP pela Edge é provado em harness separado.

## 3. Fatia 1 — `0015_group_foundation.sql`

### 3.1 Tabelas, limites e invariantes

A migration cria `public.groups`, `public.group_members` e
`public.group_invites` conforme `10` §3. Todas nascem com RLS ligada e forçada,
privilégios revogados antes das policies e sem escrita direta de `anon`,
`authenticated` ou `service_role`.

Os limites vivem em dois lugares complementares, testados para não divergir:

- `private.app_limits` recebe `max_active_groups_per_profile=5`,
  `max_group_capacity=100` e `group_invite_default_max_uses=100`, com unidades
  tipadas. São valores normativos, alteráveis somente por migration que também
  atualize o contrato; não são calibragem livre de painel;
- as constraints preservam `max_uses > 0`, `0 <= used_count <= max_uses`,
  `removal_count >= 0` e o default literal `max_uses=100`. RPCs leem os limites
  sob o lock-pai e a suíte exige que o default e a configuração coincidam.

O limite pessoal conta memberships `active` em grupos não arquivados; grupo
próprio conta e pedido `pending` não. O limite de capacidade do grupo conta
`pending + active`. Assim uma pessoa com cinco memberships ativas não ganha a
sexta: `create_group` e `approve_member` serializam pelo perfil. Um resgate pode
criar `pending` somente se o grupo ainda tiver capacidade; se o perfil já tem
cinco ativas, retorna `GROUP_LIMIT` em vez de criar um pedido sabidamente
inaprovável. Pedidos pendentes anteriores não consomem cota pessoal, e aprová-los
reconta a cota sob lock.

`groups.owner_id` é a única fonte de titularidade. `group_members.role` admite
somente `organizer|player`; não existe `owner`. Trigger constraint diferido
exige no commit que todo grupo não arquivado tenha uma membership `active` para
`owner_id`. Grupo arquivado preserva o vínculo histórico sem conferir autoridade
ativa. A prova usa commit real sob o papel relevante; rollback automático de
pgTAP não basta. O trigger é `DEFERRABLE INITIALLY DEFERRED`, dispara em
`groups` (insert e update de `owner_id` e `archived_at`) e em `group_members`
(update de `status` e delete), e relê o estado corrente pelo `group_id`.
Contraprova: commit real que só altera `group_members` para retirar o dono de
grupo não arquivado precisa ser recusado.

Índices cobrem `owner_id`, memberships por perfil/status e contagens de
`pending|active`; índice não substitui os locks. `group_invites.token_digest` é
único, `public_nonce` tem exatamente 16 bytes e `token_version > 0`.

### 3.2 Isolamento tabela por tabela

As policies são fechadas e testadas com um papel-sonda sem `BYPASSRLS`:

| Tabela | Leitura autorizada | Prova negativa obrigatória |
| --- | --- | --- |
| `groups` | membership própria `active` no grupo; grupo arquivado somente por projeção histórica autorizada, não por enumeração | membro ativo de A não lê a linha de B; `pending` e `removed` não leem a linha do grupo |
| `group_members` | membro ativo lê as memberships do próprio grupo; `pending` lê somente a própria linha/pedido | membro de A não lê membership de B; pendente não enumera membros nem outro pedido |
| `group_invites` | owner ou organizer com membership `active` no momento da leitura lê somente a projeção administrativa allowlisted; `created_by` é histórico, não autoridade | membro comum, pendente, organizador de outro grupo e criador removido ou rebaixado não leem; ninguém cliente recebe `token_digest` ou material bruto |

RLS filtra linhas, não colunas. Por isso grants diretos de `group_invites` não
incluem `token_digest` nem `public_nonce`; a listagem usa projeção tipada com
`id`, `group_id`, `expires_at`, `revoked_at`, `max_uses`, `used_count` e
`created_at`. O link compartilhável é outra projeção, exclusiva da Edge e
definida na fatia 3. `groups` e `group_members` também recebem grants somente
nas colunas necessárias às telas 10, 11, 17 e 25. O pendente continua sem a linha
de `groups`: o nome do grupo lhe chega somente pelas projeções do §5.3 (preview
antes do resgate e pedido próprio depois dele), cuja entrada em `13` é gate do §8.

A suíte cria dois grupos, membro ativo, pendente e identidade alheia, afirma o
caminho positivo de cada leitor e só depois as negações cruzadas. Ela prova
explicitamente `rolbypassrls=false` do papel-sonda, ausência de policy de escrita,
zero DML direto de `service_role` e grants futuros cobertos pelos defaults da
`0004`.

### 3.3 Extensão obrigatória da exclusão e de Storage

Na mesma migration que cria `groups`,
`private.require_financial_deletion_substitute(profile_id)` deixa de operar
sobre conjunto vazio:

1. `delete_account`, e não o guard, resolve sem lock os candidatos e trava em
   bytes crescentes os perfis do titular e dos candidatos antes do primeiro
   grupo (§2); o guard recebe os grupos já travados. Sob lock, a escolha do caso
   2 é feita pelo critério da M2-D8 somente entre os candidatos travados. Se a
   revalidação encontra candidato inelegível, organizador elegível fora do
   conjunto resolvido ou grupo próprio que não estava no conjunto resolvido, a
   transação aborta com `CONCURRENT_CHANGE`, nunca trava perfil depois de grupo
   e nunca deixa o trigger decidir;
2. grupo com organizador ativo elegível: a transação inicial o escolhe e
   transfere `groups.owner_id` antes de desidentificar, como `13` §2.11
   descreve; a membership do antigo owner passa a `removed` no mesmo commit.
   Com mais de um organizador ativo elegível, escolhe o de `joined_at` mais
   antigo e, em empate, o de menor `profile_id` em bytes crescentes (M2-D8). É
   a mesma ordem determinística que `10` §6 (linhas 788–791) usa para a
   autoridade financeira, menor `(joined_at, profile_id_bytes)`. Como `10` §3
   (linhas 263–264) preserva `joined_at` na reentrada, quem saiu e voltou
   conserva a antiguidade da primeira entrada. A transferência por exclusão é
   permitida em grupo suspenso, e o grupo continua suspenso depois dela
   (M2-D10): exclusão de conta é direito LGPD do titular, e a suspensão do grupo
   não está sob o controle dele. No M2 essa transferência não emite N28 nem
   trilha, porque auditoria e outbox ainda não existem (M2-D7, §8.1);
3. grupo com outro membro ativo, mas sem organizador ativo elegível, retorna
   `FINANCIAL_SUBSTITUTE_REQUIRED` sem iniciar a saga; o dono promove alguém ou
   transfere à mão antes de repetir o pedido;
4. grupo sem outro membro ativo e sem caso financeiro é solo para o M2, ainda
   que tenha pedidos pendentes: é arquivado no mesmo commit, e no mesmo commit
   cada pedido pendente passa a `removed`, com `removed_at` preenchido e
   `removal_count` inalterado, e a membership do owner passa a `removed`. O
   contador não muda porque, por `10` §3, ele só aumenta na reentrada; não há
   estado novo nem mudança em `10` (M2-D9). Membro pendente não impede o
   arquivamento (M2-D2);
5. a extensão futura do M5 consulta casos financeiros antes do arquivamento e
   conserva a mesma chamada em `delete_account`.

Além dos grupos próprios, `delete_account` passa a `removed` TODA membership
não-dona do titular (`pending` ou `active`) no mesmo commit. `10` §3 conta
`pending + active` na capacidade; sem esse passo a vaga ficaria ocupada para
sempre por um perfil desidentificado. A `0015` não tem resgate: a entrada só
existe na `0017`. Por isso a prova desta fatia mede diretamente no banco, depois
do commit real, que a exclusão passou a membership não-dona do titular a
`removed` e que a contagem `pending + active` do grupo caiu exatamente em um. A
prova de que a vaga liberada aceita exatamente uma entrada pertence ao §5.4.

O guard nunca promove `pending` nem `player` e nunca transfere a quem não é
organizador ativo elegível. O critério de escolha entre vários organizadores
elegíveis é o da M2-D8 (caso 2). Exceção Admin usa o contrato já definido em
`13` §5.4.

`private.require_financial_deletion_substitute` é hoje `stable` (`0012`, linha
430). Em função não-volátil o plpgsql executa por SPI em modo read-only, e
`select … for update` e `update` ABORTAM em execução. O guard da `0015` escreve e
trava: transfere `groups.owner_id` no caso 2, arquiva o grupo no caso 4, passa
memberships a `removed` nos dois casos e trava de novo, antes de revalidá-los, os
grupos que recebe. Por isso a `0015` muda a função para `volatile`, e a
contraprova de volatilidade continua: com a função `stable`, a exclusão precisa
reprovar com `SQLSTATE 0A000`.

A aquisição de grupos do próprio guard não é observável pelo caminho de `delete_account`:
`delete_account` travou os mesmos grupos antes de chamá-lo, e a nova aquisição, na mesma
transação, não espera. Por isso a fatia prova as duas aquisições separadamente, cada uma com a
contraprova que a reprova e que declara o que remove, no padrão do §4.3:

1. **Lock de grupos de `delete_account`.** Com o grupo seguro pelo detentor, a exclusão fica em
   `wait_event_type='Lock'` pela barreira do §2, com o `pid` do detentor em `pg_blocking_pids`, e a
   prova fixa em que passo ela espera: o perfil do titular já está travado e a membership do dono
   ainda está livre, as duas sondadas com `for no key update skip locked`. A contraprova retira
   somente a aquisição de grupos de `delete_account`: a espera passa a acontecer dentro do guard,
   com a membership já travada, e a prova reprova.
2. **Lock do próprio guard.** O guard é chamado diretamente, em conexão dedicada, sobre um grupo do
   caso 3, que não faz `UPDATE`, enquanto o detentor segura o grupo; a prova exige a espera pela
   barreira do §2, com o `pid` do detentor em `pg_blocking_pids`, e depois
   `FINANCIAL_SUBSTITUTE_REQUIRED`. A contraprova retira somente a aquisição de grupos do guard: a
   chamada responde sem esperar, e a prova reprova.

`groups.photo_url` representa objeto de Storage e, portanto, nasce já coberto
pela regra geral: **toda fatia que introduzir um novo objeto de Storage acrescenta
seu tipo à lista fechada de `private.deletion_has_pending_storage` na mesma
migration**. O bucket `group-photos` nasce privado e sem policy de cliente;
`photo_url` guarda somente o localizador interno e não recebe grant de leitura.
Nenhum path ou signed URL chega ao cliente, e o M2 não publica rota de leitura
da foto (§7).

A foto de grupo não ganha kind novo: usa `delete_storage_object` com
`resource_type='group_photo'` e `resource_id=group_id`. `docs/10` não muda: o
kind já está no CHECK de `0005` (linha 27) e de `10` §9 (linha 1092), e
`resource_type` já tem o CHECK `^[a-z][a-z0-9_]{0,62}$` na `0005` (linha 30). A
`0015` estende
simultaneamente, em todo ponto que hoje despacha `delete_storage_object` por
`resource_type='profile_avatar'`:

- o alvo e o confirmador fenced do handler no worker;
- o relacionamento `group_photo → group → owner/deletion_request`;
- `deletion_has_pending_storage`, para que `pending|leased|failed_retryable`
  bloqueiem `delete_auth_user`;
- a reconciliação de `dead`, com marcador operacional durável e path mantido
  somente na fronteira privada quando ausência não foi confirmada.

Ao arquivar grupo solo com foto, `delete_account` enfileira
`delete_storage_object` com chave
`delete_storage_object:group_photo:<group_id>:<deletion_request_id>`. A chave é
por ocasião da saga, como a de `delete_data_export` na `0012` (linha 574). Ela
não segue o avatar: a chave do avatar não tem `request_id` (`0012`, linha 582),
e a frase “chave por ocasião como no M1-B” não vale para ele. O path não entra
em idempotência, efeito, job, erro ou log. O Auth só fica adquirível depois de o
objeto estar ausente ou a política terminal explícita registrar falha
operacional; crash antes/depois do delete e antes/depois da confirmação converge
por observação do Storage.

Nenhum upload de foto, rota de leitura nem UI de edição entra por existir a
coluna. Quando uma fatia futura publicar o produtor do objeto, ela reutiliza o
`resource_type`, publica a rota de leitura depois de registrá-la em `13` e prova
o caminho HTTP real; não pode criar uma segunda lista nem outro fence paralelo.
No M2 o fence é exercitado com objeto de fixture no bucket local.

### 3.4 Extensão do `colete-export-v1`

`22` §5.1 (linhas 328–329) obriga todo marco que crie categoria do inventário a
ampliar a allowlist do export e seus testes na mesma migration. A `0015` acrescenta
`groups.json`, com uma entrada por membership própria do titular: `group_id`,
nome do grupo, papel, status, mensalista, `joined_at`, `removed_at` e
`removal_count`. Nunca entram membros terceiros, digest, nonce, token nem
localizador de foto: `17` §2 diz que digests nunca retornam. As fixtures byte a
byte e a allowlist negativa são atualizadas na mesma migration.

O schema continua `colete-export-v1`: a extensão só acrescenta uma entrada de nome
fixo, enumerada no `manifest.json`, sem mudar forma nem semântica das entradas
existentes, que é exatamente a ampliação que `22` §5.1 prevê dentro da v1.

### 3.5 Provas de saída e orçamento

Além das quatro rodadas da tabela do §2, a fatia só fecha quando provar: banco
do zero; constraints e FKs; trigger de owner em commit real; RLS positiva e
cruzada por tabela; zero DML administrativo; transferência automática ao
organizador elegível; com vários organizadores elegíveis, escolha do de
`joined_at` mais antigo, em fixture na qual ele foi inserido por último e tem o
maior `profile_id`, para que escolha por ordem física ou só por `profile_id`
reprove, e, com `joined_at` empatado, escolha do menor `profile_id` em bytes, em
fixture inserida na ordem inversa dos bytes (M2-D8); transferência por exclusão
em grupo suspenso, com `suspended_at` inalterado depois do commit (M2-D10);
`FINANCIAL_SUBSTITUTE_REQUIRED` sem organizador elegível; grupo solo com
pendente arquivado e cada pedido pendente em `removed`, com `removed_at`
preenchido e `removal_count` inalterado (M2-D9); memberships não-donas do
titular em `removed` e contagem `pending + active` do grupo caindo exatamente em
um, medida no banco (§3.3); guard `volatile`, com a contraprova `stable` →
`0A000`, e espera observada pelo lock de grupo de `delete_account`, com a
contraprova do §3.3; o par cruzado da M2-D13 (§2): exclusão de dois donos, cada
um organizador ativo elegível no grupo do outro, nas duas ordens, sem `40P01`, e
uma repetição sem barreira que reprova com qualquer `40P01`, com a contraprova
em `FOR UPDATE` reproduzindo o `40P01`; foto pendente impedindo Auth; crash e
retry do `delete_storage_object` de `group_photo`; `groups.json` byte a byte e
allowlist negativa; censo pgTAP por valor de path/token/PII de fixture em todas
as tabelas novas e nos livros de idempotência e efeito, no padrão do teste da
`0012` (linha 496 em diante); e ausência de linha ou objeto residual no fim dos
harnesses. Todo par concorrente usa a barreira do §2: duas conexões dedicadas
com `application_name` distinto, ordens A→B e B→A, liberação somente depois de
observar `wait_event_type='Lock'`; `setTimeout` não é barreira. A capacidade sob
25 conexões **não** é prova desta fatia: os limites vivem nas RPCs, que ainda
não existem, e a prova passaria por SQL do próprio harness, verde pela razão
errada. Ela pertence à `0017` (§5.4); na `0016`, as 25 conexões provam somente a
cota pessoal (quinta e sexta membership).

## 4. Fatia 2 — `0016_group_membership_rpcs.sql`

### 4.1 Envelope, locks e operações

Cada mutação amplia de forma append-only as allowlists de operação, outcome e
resource do livro de idempotência, recebe o contexto interno do gateway e
conquista a chave antes de qualquer lock de domínio. Outcomes contêm apenas IDs
estáveis e `logical_result`; papel, capacidade, status, contagem e autoridade
atuais vêm de projeção fresca. `create_group` não está nesta fatia: ela mora na
`0017` pelas razões do §2 e é descrita no §5.2. Os grupos desta fatia nascem por
fixture, criada como `postgres` somente no setup do harness.

| Operação | Locks e invariantes | Erros específicos |
| --- | --- | --- |
| `approve_member` | perfil alvo → grupo → membership; owner/organizer ativo, capacidade e cota recontadas; recusa não fabrica outra linha | `MEMBERSHIP_ALREADY_DECIDED`, `GROUP_LIMIT`, `GROUP_FULL` |
| `remove_member` | perfis afetados em ordem → grupo → memberships; owner é recusado; no M2 o conjunto de rachas/provas é vazio e a primitiva fica preparada para extensão atômica no M3/M5 | `IS_OWNER`, `PROOFS_PENDING` |
| `set_role` | perfil alvo → grupo → membership; somente owner; owner continua derivado de `owner_id` | `OWNER_ONLY` |
| `set_monthly` | perfil alvo → grupo → membership; somente autoridade permitida; `is_monthly=true` exige `monthly_enabled`, que no M2 só nasce ligado por fixture: o setter e o toggle da tela 25 entram no M3 (M2-D6) | `MONTHLY_DISABLED` |
| `set_ratings_visibility` | perfil ator → grupo; confirmação explícita para `members`; owner only | `OWNER_ONLY`, `VISIBILITY_CONFIRMATION_REQUIRED` |
| `transfer_ownership` | perfis antigo/novo por bytes → grupo → memberships; novo owner precisa estar ativo; altera somente `groups.owner_id` | `NOT_ACTIVE_MEMBER` |
| `leave_group` | perfil → grupo → própria membership; owner recebe erro antes de qualquer efeito; membership muda por último | `OWNER_MUST_TRANSFER`, `PROOFS_PENDING` |

Os erros específicos da tabela são exatamente os de `13` §5. `set_role` e
`set_monthly` sobre alvo sem membership `active` devolvem `NOT_ACTIVE_MEMBER`, o
mesmo código de `transfer_ownership` (M2-D17), e `13` §5 foi emendado para isso.
A recusa em `approve_member` faz `pending → removed` (M2-D16), e o `reason` de
`remove_member` é validado e não é persistido no M2 (M2-D18); as duas regras
também estão em `13` §5. As quatro escolhas da M2-D19 e a regra de replay da
M2-D20 emendada estão registradas no §8.1 e em `13` §0 e §5. Transferir para si mesmo
conclui o registro idempotente sem executar `UPDATE` em `groups`.

O replay das sete RPCs adquire os mesmos locks e executa as mesmas verificações
de autenticação e de autoridade no grupo da chamada nova. Autenticação negada
propaga o erro normal antes do ramo de replay, sem desfecho. Com autenticação
válida, perda de autoridade no grupo devolve sucesso com o outcome gravado e
`current` ausente; autoridade válida combina esse outcome com a projeção fresca. A chamada nova conserva o erro normal. A revalidação não repete a mutação nem as condições do alvo já
decidido: por exemplo, a aprovação gravada pode ser relida pelo organizador
atual mesmo depois de o alvo deixar de estar `pending`.

As operações revalidam `account_status`, aceite pendente, sessão revogada,
membership e `suspended_at` depois dos locks. Grupo arquivado retorna
`GROUP_ARCHIVED`. Grupo suspenso retorna `GROUP_SUSPENDED` para criação/entrada,
aprovação, papel, mensalista, visibilidade, transferência comum e qualquer edição.
Esse bloqueio vale somente para a transferência comum por `transfer_ownership`:
a transferência por exclusão de `delete_account` (§3.3, caso 2) é permitida em
grupo suspenso, e o grupo continua suspenso (M2-D10). A allowlist mínima
continua disponível: leitura própria, privacidade/exportação, `leave_group` de
não-owner e, nos marcos futuros, cancelamento seguro e resolução financeira pela
autoridade substituta. O M2 não implementa RPC Admin:
`set_group_suspension` e `admin_transfer_ownership` continuam no caminho Admin de
`13` §5.4 e ficam para a fatia que os publicar, com razão obrigatória e grants
separados. `suspended_at` é preparado por fixture como `postgres` somente no
setup; a verificação do comportamento de grupo suspenso passa pela Edge real.

Transferência e saída geram as trilhas/notificações somente quando os objetos
de auditoria/outbox chegarem na fatia B2 correspondente; o M2 não inventa uma
tabela parcial para antecipá-los. A ausência atual desses objetos não autoriza
log livre nem resposta com PII, e mutações de grupo sem trilha e sem as
notificações de `13` §5 não chegam ao beta (M2-D7, §8.1).

A fatia também publica `purge_removed_memberships`, o job de `17` §4 que aplica
a retenção de 12 meses de `17` §2 à membership removida, com prova de expurgo no
prazo, de preservação antes dele e de ausência de efeito em membership ativa ou
pendente. O agendamento segue o mesmo estado dos demais jobs em `16` §3.

### 4.2 Reentrada e `removal_count`

A `0016` só prepara o estado `removed`: `remove_member` e `leave_group` fazem
`active → removed`, e nenhuma RPC desta fatia reativa a membership nem a devolve
a `pending`. As regras de reentrada abaixo são executadas pelo resgate da
`0017` e provadas no §5.4; esta seção as fixa aqui porque definem o estado que a
`0016` precisa deixar pronto.

Remoção não é banimento. A linha `(group_id, profile_id)` nunca é substituída
para apagar o histórico:

- `active → removed` marca `removed_at`, desliga `is_monthly` e retira
  autoridade; não existe RPC de reativação direta. Esta é a única regra da
  seção executada pela `0016`;
- somente resgate válido da fatia 3 faz `removed → pending`, atualiza
  `last_requested_at`, zera `removed_at`, força `role='player'` e
  `is_monthly=false`, e exige nova aprovação;
- `removal_count` aumenta exatamente uma vez nessa reentrada, dentro da mesma
  transação que consome o convite. Replay idempotente não aumenta de novo;
- o contador serve a histórico, retenção e sinal de abuso. Na v1 ele **não**
  autoriza aprovação, não promove papel, não reduz capacidade, não bloqueia
  reentrada e não cria banimento implícito. Rate limit é a barreira de abuso.

Pendente repetindo o mesmo pedido recebe projeção corrente sem nova membership
nem consumo duplicado. Membership ativa nunca é rebaixada por resgate; a resposta
não revela a terceiros se o perfil já pertence ao grupo. Estas duas regras
também são executadas pelo resgate da `0017`. Se o resgate repetido com
`request_id` novo, de quem já está `pending` ou `active`, consome uso do convite,
e qual resposta recebe, são indefinidos do §8.2, antes da `0017`.

### 4.3 Provas de saída e orçamento

As cinco rodadas cobrem: envelope/grants; concorrência/cota;
titularidade/remoção e estado `removed`/suspensão; exclusão × membership e
retenção; e HTTP real com contraprovas. A parte “remoção e estado `removed`” da
terceira rodada prova que `active → removed`, por `remove_member` e por
`leave_group`, grava `removed_at`, desliga `is_monthly` e retira autoridade: RLS
e chamada nova à RPC negam já na chamada seguinte do perfil removido; replay
concluído conserva somente o desfecho, sem `current` (M2-D20 emendada). Prova também que nenhuma
RPC da `0016` reativa a membership nem a devolve a `pending`, e que a linha
continua existindo depois da remoção. A transição `removed → pending` e o
incremento de `removal_count` não são provas desta fatia: dependem do resgate e
pertencem à `0017` (§5.4). O harness de 25 conexões prova duas aprovações
contra a quinta e a sexta membership do mesmo perfil, transferência × saída,
exclusão × transferência e exclusão do dono × exclusão do organizador escolhido,
sempre nas duas ordens. O par cruzado da M2-D13 (§2) roda para cada operação
enquadrada desta fatia, nas duas ordens, sem `40P01` e com a contraprova em
`FOR UPDATE` reproduzindo o `40P01`: em `approve_member`, A aprova o pedido de B
em G1 enquanto B aprova o pedido de A em G2, caso em que um único perfil alheio
por transação basta para o ciclo; em `remove_member`, `set_role`, `set_monthly`
e `transfer_ownership`, o par análogo, em que cada ator alcança o perfil do outro
em grupos distintos; e exclusão × transferência na forma cruzada, em que A exclui
a conta com B entre os candidatos enquanto B transfere a A outro grupo. Criação
contra a quinta vaga pertence à `0017`, onde
`create_group` existe. Todo par concorrente usa a barreira do §2: duas conexões
dedicadas com `application_name` distinto, ordens A→B e B→A, liberação somente
depois de observar `wait_event_type='Lock'` em `pg_stat_activity`; nas provas
N-way, ao menos N−1 transações esperaram lock. `setTimeout` não é barreira.

Contraprovas removem cada lock-pai e precisam produzir sexta membership ou
estado de owner inválido. A corrida de capacidade 99º/100º/101º é prova da
`0017`, onde o resgate cria `pending` (§5.4). A contraprova de estado de owner
inválido declara o que remove, porque o trigger diferido a barra: sem o
lock-pai, o trigger precisa recusar o commit; sem o trigger, o lock precisa
serializar; somente sem os dois o estado inválido aparece, e só essa terceira
execução prova que o harness enxerga o defeito. Toda rota Edge é chamada por
HTTP real com JWT GoTrue; o harness não possui switch/adaptador próprio
diferente do gateway produtivo. O commit como `service_role` prova o trigger
diferido e a idempotência concluída.

## 5. Fatia 3 — `0017_group_invites.sql`

### 5.1 Material, cofre e formato

A chave HMAC vive somente nos secrets da Edge/worker, com nomes versionados
`INVITE_HMAC_KEY_V<n>` e uma versão ativa configurada por ambiente. Valor,
digest de chave e URL real não entram no banco, migration, bundle ou log. O
repositório contém apenas nomes e chaves públicas de teste inequivocamente
sintéticas. Versões antigas permanecem no keyring até não existir convite vivo
na versão, mais a janela operacional de expurgo; remoção antes disso é gate
humano recusado pela checagem pré-deploy.

O token de link contém exatamente
`invite_id(16)||token_version(u16 BE)||public_nonce(16)||mac(32)`, base64url sem
padding. O MAC é
`HMAC-SHA-256(key_v, "colete/invite/v1\0" || bytes_anteriores)`. Vetores dourados
literais rodam em TypeScript e SQL de teste; produção nunca calcula MAC no banco.
Código humano usa alfabeto sem caracteres ambíguos, entropia mínima versionada e
digest HMAC separado. `10` §3 exige entropia mínima versionada, mas nenhum
normativo fixa o número: alfabeto, comprimento e piso de entropia são o gate 13
do §8.2, e a derivação e a entrega do código são o gate 14. Token e código
completos chegam à Edge, são
normalizados e viram apenas IDs, versão e digest na chamada interna: **o token
nunca chega ao PostgreSQL**.

Versão, regeneração e colunas, declarados antes da migration:

- **(a)** `token_version` nomeia a versão da chave do cofre. `10` §3 (linhas
  267–270) define o MAC como `HMAC-SHA-256(key_v, …)` e o token carrega
  `token_version(u16 BE)` nos próprios bytes: é por esse campo que o verificador
  escolhe a chave. Não existe coluna separada de versão de chave. A rotação
  global incrementa a versão, gera nonce, recalcula digest e revoga o material
  anterior, como `10` §3 (linha 269) descreve;
- **(b)** “regenerar” da tela 24 gera nonce e digest novos **sem** mudar a
  versão e revoga o material anterior da mesma linha. Regenerar não é rotação:
  não depende de chave nova nem toca outro convite;
- **(c)** falta uma coluna, não duas: `code_digest text unique` em
  `group_invites`, para o código humano. `10` §3 (linha 270) exige digest do
  código com segredo do servidor, e `join_by_code(code)` precisa de lookup por
  ele. A emenda ao bloco SQL de `10` §3 entra no mesmo commit da `0017` (M2-D3),
  pelo precedente de `22` §4 (linhas 278–282);
- **(d)** o parser rejeita `token_version` acima de 32767, porque a coluna é
  `smallint` e o campo do token é u16. A suíte tem vetor de teste em 32768, que
  precisa ser recusado antes de qualquer chamada ao banco, além do vetor em 0.

O link usa fragmento, nunca query. A página troca o fragmento por POST, remove-o
com `history.replaceState` antes de analytics/observabilidade e envia
`Referrer-Policy: no-referrer`. Token não entra em Sentry, título, cache,
localStorage, histórico de requests ou erro. A rota recusa redirect e resposta
cacheável.

### 5.2 Criação, compartilhamento e rotação

`create_group(name, request_id)` nasce nesta fatia e devolve `{ group_id,
invite_id }`, como `13` §5 exige. Trava perfil → novo grupo → membership →
convite; reconta as memberships ativas sob o perfil e recusa a sexta com
`GROUP_LIMIT`; cria `owner_id` = criador, membership `organizer/active` e o
convite inicial com `max_uses=100`. Como o MAC nunca é calculado no banco e o
`invite_id` faz parte dos bytes autenticados, a Edge gera identificador, nonce e
digests com a chave ativa e os entrega à chamada interna; o banco só persiste.
Replay idempotente devolve o mesmo outcome e não persiste material novo. A
validade do convite inicial (`expires_at` é `not null`) é gate do §8.

A fatia publica as operações internas necessárias para revogar, regenerar e
para a rotação operacional de versão. Se a tela 24 oferecer revogar e regenerar
no M2, os contratos cliente dessas operações precisam estar em `13` antes da
`0017` (gate do §8); sem eles, a tela não renderiza os controles.

A autoridade de convite é **owner ou organizer com membership `active` no
momento da chamada**. `created_by` é histórico, não autoridade. Prova negativa:
criador removido ou rebaixado a `player` não gera, não regenera, não revoga nem
compartilha link.

Rotação é global e explícita: após provisionar a próxima chave, lotes em UUID
crescente trocam `token_version`, nonce e digest de cada convite vivo; o material
anterior deixa de validar no mesmo commit da linha. Lote interrompido é retomável,
versionado e nunca aceita duas versões simultâneas da mesma linha. Convite
revogado, expirado ou esgotado não é ressuscitado pela rotação; criar outro
convite é uma nova ocasião. A rotação nunca trava `groups`: trava somente linhas
de convite, em UUID crescente.

`get_invite_share_link(invite_id)` é a projeção sensível externa da Edge. Somente
a autoridade de convite acima, no mesmo grupo, a recebe. A função declara sua
ordem de lock, compatível com o §2, e a prova a executa contra rotação,
regeneração e revogação nas duas ordens. O banco devolve
à Edge, por RPC nominal, apenas o material necessário e revalida autoridade,
revogação, expiração e `used_count < max_uses` sob a linha corrente. A Edge
recalcula o MAC, confere o digest persistido e devolve ao cliente somente:
`invite_id`, `expires_at`, `remaining_uses` e `share_url` com token no fragmento.
Não devolve `token_digest`, chave, versão de chave, nonce separado ou URL de
ambiente em coluna. Revogado retorna `INVITE_REVOKED`, expirado
`INVITE_EXPIRED` e esgotado `INVITE_USED`; nenhuma dessas condições produz link.

Recompartilhar não consome uso nem gira material. Rotação invalida o link antigo
e exige novo compartilhamento. Um dump do banco contém nonce público, versão e
digest, mas sem o keyring não produz MAC válido; a prova roda sobre a saída real
de `pg_dump --data-only` (instrumento (b) do §5.4), e a contraprova com chave
errada precisa falhar.

### 5.3 Resgate, capacidade e reentrada

`join_by_code` e `join_by_invite` compartilham uma única primitiva transacional.
Depois da idempotência, a Edge fornece a identidade do convite já autenticada,
nunca ator ou HMAC vindo do body. A RPC:

1. resolve as chaves sem lock e adquire perfil → grupo → membership → convite;
2. revalida digest, versão, `revoked_at`, `expires_at`, `used_count < max_uses`,
   grupo não arquivado/suspenso e rate-limit aprovado pelo gateway;
3. reconta capacidade `pending+active` sob o lock do grupo e a cota ativa sob o
   lock do perfil;
4. incrementa condicionalmente `used_count` e exige uma linha afetada;
5. cria `pending` ou aplica exatamente a reentrada do §4.2; nunca cria `active`;
6. conclui idempotência com `{status:'pending', reentry}` e projeção fresca.

Convite revogado, expirado ou esgotado não consome uso e não toca membership.
O 100º uso pode vencer; o 101º recebe `INVITE_USED`. O 100º membro
`pending|active` pode entrar; o 101º recebe `GROUP_FULL`, ainda que outro convite
tenha usos. Reentrada consome novo uso porque é novo resgate válido. Reprovação
ou remoção anterior não dá desconto de capacidade nem uso.

O gateway aplica rate limit por perfil e IP com estado e limites decididos na
mesma fatia; mensagens externas não distinguem “já pertence” de material
inválido. IP bruto não entra no banco de domínio, idempotência, jobs ou logs; a
implementação usa derivado rotacionado e retenção classificada antes de produção.
O valor inicial e o armazenamento efetivo do rate limit são gate humano do §8,
não número a ser inventado pelo implementador. O código de erro da recusa por
rate limit ainda não existe em `13` §8 e precisa ser registrado lá **antes** da
`0017`; a prova mostra que a tentativa N+1 é recusada pela Edge sem tocar o
banco.

**Nome do grupo antes da aprovação.** As telas 10 e 12 mostram o grupo pendente
e confirmam a entrada antes do resgate (“Entrar no Racha da Firma?”, `11` §3),
mas o §3.2 nega a linha de `groups` ao pendente e `13` não tem projeção de
preview. O M2 escolhe **a projeção de preview**, não a confirmação depois do
resgate. Razão: `10` §3 conta `pending + active` na capacidade e uso de convite
não volta; confirmar depois do resgate faria um código digitado errado ou uma
desistência consumir uso e vaga do grupo alheio até alguém recusar, e mudaria o
fluxo de `11` §3. A projeção de preview recebe o mesmo material do resgate, está
sob o mesmo rate limit, devolve somente o nome do grupo, não consome uso, não
cria linha, não devolve foto, membros, dono nem contagem e, pela regra do
parágrafo seguinte, responde com um único erro genérico a tudo que não seja
resgatável agora, sem revelar membership prévia. O pedido próprio pendente de
tela 10 recebe pela projeção de memberships do titular somente `group_id`, nome
do grupo e status. As duas exigem emenda a `13` antes da `0017` (§8).

O preview e o resgate debitam **o mesmo orçamento de falhas** por perfil e por IP
derivado; falha de preview conta como falha de resgate. O preview **não
distingue** código inexistente de código revogado, expirado, esgotado, de grupo
arquivado, suspenso ou cheio, nem de limite pessoal: toda resposta que não seja
'resgatável agora' é um único erro genérico, e as mensagens específicas da tela
12 só aparecem no resgate. A taxa global de falhas de preview e resgate tem
alarme operacional.

A fatia também publica o expurgo de convite de `17` §2 — revogação ou expiração
mais 30 dias —, com prova de expurgo no prazo, preservação antes dele e
ausência de efeito em convite vivo. O agendamento segue o mesmo estado dos
demais jobs em `16` §3.

### 5.4 Provas de saída e orçamento

As seis rodadas cobrem criptografia, segredo/instrumentos de vazamento,
concorrência, HTTP/log/rate limit, isolamento/preview e `create_group`. Provas
mínimas: nonce de 16 bytes; u16 big-endian; `token_version` 32768 recusado;
base64url sem padding; domínio exato; vetor nos runtimes; MAC inválido; versão
desconhecida; fragmento removido; compartilhamento autorizado; outro grupo
negado; criador removido ou rebaixado negado; revogado, expirado e esgotado;
rotação invalidando o anterior; regeneração invalidando o anterior sem mudar a
versão; 25 resgates no último uso; 99º/100º/101º membro; vaga liberada por
exclusão de conta (§3.3), em que o grupo em 100 `pending + active` perde um
membro por `delete_account` e aceita exatamente uma entrada, com a seguinte
recebendo `GROUP_FULL`; criação × aprovação e duas criações contra a quinta
vaga; `create_group` devolvendo `{ group_id, invite_id }` com convite inicial
válido; as provas de reentrada do parágrafo seguinte; preview sem consumo nem
linha; tentativa N+1 recusada pela Edge sem tocar o banco; expurgo de convite no
prazo; e objeto/linha residual zero. Todo par concorrente usa a barreira do §2:
duas conexões dedicadas com `application_name` distinto, ordens A→B e B→A,
liberação somente depois de observar `wait_event_type='Lock'`; nas provas N-way,
ao menos N−1 transações esperaram lock. `setTimeout` não é barreira. Pela ordem
de locks do §5, nenhuma operação desta fatia trava perfil de outra pessoa, e o
par cruzado da M2-D13 (§2) não tem caso aqui. Se `get_invite_share_link`,
revogar ou regenerar declararem ordem que inclua perfil de outra pessoa, o par
cruzado e sua contraprova em `FOR UPDATE` entram nesta lista.

As regras de reentrada do §4.2 são executadas por esta fatia e têm, cada uma,
prova própria. O ponto de partida é a membership `removed` que a `0016` deixa
pronta:

- **mesma linha:** o resgate válido de perfil `removed` atualiza a linha
  `(group_id, profile_id)` existente, sem `delete` nem `insert` em
  `group_members`, e `joined_at` fica preservado, como `10` §3 exige;
- **`removed → pending`:** depois do resgate, a linha está `pending`, com
  `last_requested_at` atualizado, `removed_at` nulo, `role='player'` e
  `is_monthly=false`, inclusive quando o perfil era organizador antes da
  remoção. A linha continua sem autoridade e sem leitura de `groups` até nova
  aprovação por `approve_member`;
- **incremento único:** `removal_count` aumenta exatamente em um na reentrada, e
  o replay idempotente com o mesmo `request_id` devolve o mesmo outcome sem novo
  incremento e sem novo consumo de uso;
- **mesma transação que o consumo:** reentrada recusada depois do lock, por
  `GROUP_FULL`, `GROUP_LIMIT` ou convite que deixou de ser resgatável, deixa
  `used_count`, `removal_count` e a linha `removed` inalterados; nunca há
  consumo sem incremento nem incremento sem consumo;
- **o contador não decide nada:** perfil com `removal_count >= 2` reentra, ocupa
  exatamente uma vaga de `pending + active`, continua `player` e `pending` até
  aprovação e é aprovado pelo mesmo caminho de qualquer pendente, sem bloqueio,
  desconto de capacidade nem banimento;
- **pendente repetindo o pedido:** perfil já `pending` que resgata de novo não
  gera nova membership. A chave primária `(group_id, profile_id)` já impede a
  segunda linha, e por isso contar linhas passaria também com o defeito. A
  prova afirma o que o defeito quebraria: o resgate repetido não falha por
  violação de chave, não aplica a transição de reentrada e deixa `status`,
  `role`, `joined_at`, `removed_at` e `removal_count` inalterados. O consumo de
  uso, `last_requested_at` e a resposta desse resgate repetido com `request_id`
  novo são indefinidos do §8.2; a prova deles fica pendente dessa resposta;
- **ativa nunca rebaixada:** perfil `active` que resgata convite do próprio
  grupo mantém `status`, `role`, `is_monthly`, `joined_at` e `removal_count`
  inalterados, e o resgate não falha por violação de chave nem por erro
  interno, que também deixariam a linha intacta. A resposta, e se esse resgate
  consome uso, são indefinidos do §8.2;
- **nada revelado a terceiros:** outcome, projeção devolvida, erro e log do
  resgate contêm somente dados do próprio chamador, sem ID, status ou
  existência de membership de outro perfil.

“Nenhum token em banco, log, Sentry ou cache” depende de três **instrumentos
novos desta fatia**, sem os quais o critério não fecha. Hoje nenhum deles existe:
o precedente é o censo pgTAP de tabelas escolhidas (teste da `0012`, linha 496 em
diante), não um dump.

- **(a)** captura do stdout do edge runtime local durante o harness, com busca
  literal pelos tokens de fixture;
- **(b)** `pg_dump --data-only` depois do harness, com busca por tokens, MACs e
  paths de fixture;
- **(c)** Sentry fake com transporte em memória, cuja contraprova injeta o token
  e precisa falhar.

Toda rota passa pela Edge real. O teste importa o mesmo parser, provider e
dispatcher de produção; um `case` ausente no gateway ou um status real
divergente reprova o critério de saída.

## 6. Fatias 4 e 5 — interface (UI-A e UI-B)

A interface entra somente depois de `0015`–`0017`, sem migration e sem botão
oculto/desabilitado antes do contrato. A área autenticada passa a ter Grupos e
Perfil; Rachas continua ausente até o M3, e com ela a tela 5 (M2-D1). Em tela
larga a mesma navegação vira lateral, conforme `11` §0. Cada tela renderiza
somente os controles que têm RPC publicada atrás; o que `11` descreve e ainda não
tem contrato em `13` fica ausente, não desabilitado, até a fatia que o publicar.

### 6.1 UI-A — telas 10, 11, 12, 16 e 24

- **Tela 10 — Grupos:** carregamento por esqueleto, erro honesto com retry,
  vazio com ação, lista de memberships autorizadas, pedido próprio pendente pela
  projeção do §5.3 e selo do próprio papel derivado da projeção; o selo
  mensalista fica fora da interface do M2 (M2-D6). “Criar grupo” leva à tela 16
  e “Entrar com código” leva à tela 12, entregue na mesma fatia;
- **Tela 11 — Detalhe:** nome pela projeção segura, membros e papéis conforme
  RLS, sem selo mensalista (M2-D6), e saída por `leave_group` com
  `OWNER_MUST_TRANSFER` explicada como “transfira a titularidade primeiro”. Sem
  produtor nem rota de leitura no M2, não há foto de grupo a exibir. Histórico de
  rachas e notas não são placeholders: entram nos marcos que criam esses
  contratos. Blocos de organizador aparecem somente para telas já entregues;
- **Tela 12 — Código/link:** somente convite de grupo; convite avulso de racha
  fica ausente até seu contrato. Código e fragmento nunca se confundem; a tela
  confirma o grupo pela projeção de preview do §5.3, chama a Edge uma vez e
  mostra `pending` como **aguardando aprovação**. Revogado, expirado, esgotado,
  arquivado, suspenso, cheio, limite pessoal e rate limit têm mensagens estáveis
  no resgate, sem revelar membership prévia; o preview responde com o erro
  genérico do §5.3. Sem a projeção de preview registrada em `13`, a UI-A não
  começa;
- **Tela 16 — Criar grupo:** somente nome, porque não há produtor de foto no M2.
  Usa `create_group` pelo gateway, conserva o mesmo `request_id` em retry, mostra
  `GROUP_LIMIT` com mensagem clara e abre a tela 24 com o convite inicial. Não
  escreve tabela nem cria token no cliente;
- **Tela 24 — Convites:** código para copiar e link para compartilhar por
  `get_invite_share_link`, somente para a autoridade de convite do §5.2. De onde
  a tela obtém o código é o gate 14 do §8.2; sem ele, o código não é exibido.
  Revogar e regenerar aparecem apenas se seus contratos entrarem em `13` (§8).
  Link de convidado avulso por racha fica ausente até o marco que cria rachas. O
  link não é persistido no cliente, em cache ou em histórico.

### 6.2 UI-B — telas 17 e 25

- **Tela 17 — Gestão de membros:** pendentes com aprovar/recusar por
  `approve_member`; membros com promover/rebaixar por `set_role` (somente o dono);
  expulsar por `remove_member`, com confirmação cujo aviso descreve apenas efeitos
  que existem no M2. O selo mensalista por `set_monthly` fica fora da interface
  do M2 (M2-D6): a RPC existe na `0016` e é provada no banco com
  `monthly_enabled` preparado por fixture. Convidados avulsos ficam ausentes até
  o marco de rachas;
- **Tela 25 — Configurações:** visibilidade das notas por
  `set_ratings_visibility`, com a confirmação explicada que o contrato exige, e
  transferência de titularidade por `transfer_ownership`, com dupla confirmação,
  ambas somente para o dono. Nome/foto e arquivar grupo não têm contrato em `13`
  e ficam ausentes (§8); o toggle de mensalista entra no M3 com o setter de
  `monthly_enabled` (M2-D6, §7).

### 6.3 Acessibilidade e E2E das duas fatias

Cada fatia aplica **a lista integral de `15-acessibilidade.md` §1**, não um
resumo: contrastes nos dois temas, componentes 3:1, **nenhuma informação só por
cor**, texto 200%, **nada de texto em imagem**, 44×44, teclado, foco,
rótulos/estados, **desabilitado com motivo**, associação e anúncio de erros,
**imagens decorativas ocultas e fotos com o nome como alternativa**,
headings/título por rota, validação no blur e em tempo real depois do primeiro
erro, botão **sempre habilitado** e, com erro, foco no primeiro campo inválido,
mensagem que diz **o que fazer**, não o que está errado, redução de movimento,
nenhuma informação importante que desapareça sozinha, horários absolutos,
linguagem simples, prevenção de erro, passada manual de `15` §3 e as exceções
declaradas. Axe é camada adicional, não substitui leitor de tela. O formato de
evidência da passada manual com leitor de tela ainda não está definido e é gate
do §8: sem ele, nenhuma das duas fatias fecha.

O E2E usa Auth, Edge e Postgres locais reais. Inspeciona URL, corpo, headers,
Cache API, storage persistente e Sentry fake para provar ausência de token/HMAC/
ator. Estado de domínio do E2E nasce pela UI da própria fatia ou de fatia
anterior, ou pela Edge real por HTTP, com usuários criados pela API admin local
de Auth; nenhum `insert` como `postgres` no E2E, exceto `suspended_at`,
declarado teste a teste (M2-D11). Semear pela Edge real não é adaptador: a
chamada passa pelo envelope, pela capacidade e pela cota de produção. A UI-A
exercita criação no limite, convite inicial, compartilhamento por autoridade,
`OWNER_MUST_TRANSFER` do dono sozinho, preview sem consumo, resgate com pedido
próprio pendente, membro de outro grupo, grupo cheio e último uso, todos
alcançáveis sem depender das telas da UI-B; o estado que exige aprovação é
preparado pela Edge real (M2-D12). Os usuários semeados são criados pela API
admin local de Auth, e cada resgate, aprovação ou remoção semeada é uma chamada
HTTP à Edge real com o JWT de quem age; a convivência dessa semeadura com o
rate limit é o gate 1 do §8.2.

“Grupo cheio” e “último uso” são cenários distintos. O dono ocupa uma das 100
vagas de `pending + active` e o convite inicial tem `max_uses=100`; por isso 99
resgates enchem o grupo com `used_count=99`, e o 100º uso não acontece sem
liberar vaga, porque o passo 3 do §5.3 reconta a capacidade antes do incremento
do passo 4. A vaga é liberada aprovando e removendo um pendente semeado, não pela
recusa, cujo estado resultante é indefinido do §8.2. Partindo do grupo criado
pelo dono D, com o convite inicial C:

- **grupo cheio:** 99 usuários semeados resgatam C pela Edge, e o grupo fica
  com D `active` e 99 `pending`, com `used_count=99`. A tentativa pela tela 12
  recebe `GROUP_FULL`, embora C ainda tenha um uso;
- **último uso, (a) sucesso:** depois do mesmo preparo de 99 resgates, D aprova
  pela Edge um pendente semeado com `approve_member` e o remove com
  `remove_member`. O grupo cai para 99 `pending + active`, e `used_count`
  continua 99. A tentativa pela tela 12 consome o 100º uso e mostra o pedido
  como **aguardando aprovação**; o grupo volta a 100, e `used_count` chega a 100;
- **último uso, (b) `INVITE_USED`:** D aprova e remove pela Edge outro pendente
  semeado, e o grupo volta a ter uma vaga livre, com `used_count=100`. A
  tentativa seguinte pela tela 12 recebe `INVITE_USED`. Para chegar a esse erro
  a vaga não é necessária, porque o passo 2 do §5.3 revalida
  `used_count < max_uses` antes da recontagem do passo 3. Ela é liberada para
  que a recusa só possa ser atribuída ao convite esgotado, e não à capacidade:
  a prova mostra que o 101º uso é recusado mesmo com vaga no grupo.

A UI-B exercita aprovação e
recusa, lista com mais de um ativo, saída de jogador, reentrada, negação a
criador rebaixado, transferência antes da saída e grupo suspenso. Nenhum harness
implementa parser, classificador de erro ou adapter próprio: importa o mesmo
código produtivo.

## 7. O que fica fora do M2

- rachas, recorrências, Pix, participantes, claims e capacidade de jogo: M3–M5;
  a tela 5 (Rachas — vazio) vai para o M3 (M2-D1);
- provas, ciclos, ledger, estornos, contestações e casos financeiros: M5 estende
  o guard de exclusão e as primitivas de remoção sem reescrever o M2;
- notas, histórico de rachas, sorteio e composição: M6; as telas não exibem
  placeholder nem dado sintético;
- auditoria tipada, outbox N1–N28 e entrega de notificações: permanecem nas
  fatias B2 correspondentes; o M2 não cria log livre substituto;
- painel amplo de Admin e qualquer RPC Admin: operações sem painel continuam no
  caminho administrativo estreito já contratado em `13` §5.4;
- upload/edição de foto de grupo e a rota de leitura da foto: a fundação cobre
  path existente e o fence de exclusão, mas não inventa produtor nem rota sem
  contrato em `13`; a futura fatia de upload publica os dois e estende export,
  backup e testes HTTP no mesmo commit;
- controles das telas 11, 24 e 25 sem contrato em `13` (§6);
- mensalista na interface: o selo das telas 10 e 11, `set_monthly` na tela 17, o
  setter de `monthly_enabled` e o toggle da tela 25 entram no M3, junto com os
  rachas (M2-D6). A RPC `set_monthly` continua na `0016`, provada no banco com
  `monthly_enabled` preparado por fixture;
- textos/digests legais, Google OAuth, rate limit geral do gateway, deploy,
  secrets reais, projeto Supabase remoto, app nativo, Apple Sign In e push;
- mudança em `09`, `10`, `11`, `13`, `14`, `15`, `17`, `18` ou `22` além das
  emendas decididas no §8 (M2-D1 em `11` §6; M2-D2 em `01`; M2-D3 em `10` §3 no
  commit da `0017`; M2-D4 em `13` §5 (linha 611) e `10` §11 (linha 1542);
  M2-D13 em `10` §10 (linhas 1363–1365); M2-D16 a M2-D19 em `13` §5 e M2-D20 emendada em `13` §0 e §5; M2-D21 em `13` §0 e §5.3) e das
  emendas a `13` que o §8 exige antes da `0017`.
  Divergência com qualquer um deles é bloqueio, salvo a pendência temporária
  de `request_data_export` expressamente aceita pela M2-D21 e registrada com
  prazo no §8.2. A exceção de `delete_account` está escrita em `13` §0 e §5.3;
  não é divergência nem autorização para o plano prevalecer.

## 8. Decisões e gates humanos

### 8.1 Decisões humanas tomadas

Os rótulos M2-D* não se confundem com as decisões D1–D62 de `09`.

- **M2-D1 (decidida em 2026-09-25).** O M2 entrega as oito telas de `11` §6,
  exceto a tela 5. A tela 5 (Rachas) vai para o M3: o domínio de rachas não existe
  no M2, e `16` §5 (“Fronteira da área autenticada no M1-A”) põe Rachas no M3.
  `11` §6 foi emendado somente para mover a tela 5.
- **M2-D2 (decidida em 2026-09-25).** Exclusão da conta do dono segue `13` §2.11:
  a transação inicial escolhe organizador ativo elegível e transfere;
  `FINANCIAL_SUBSTITUTE_REQUIRED` só quando não existe organizador ativo
  elegível, caso em que o dono promove alguém ou transfere à mão antes de repetir
  o pedido. Membro pendente não impede o arquivamento do grupo solo: o grupo é
  arquivado e os pedidos pendentes são cancelados no mesmo commit. `01` §3.1
  (linhas 110–114) foi emendado para essa semântica. Razão: pela letra anterior,
  dono + 1 pendente não era “solo” e não havia para quem transferir, então a
  exclusão travaria para sempre — a mesma classe de defeito que o M1-B eliminou,
  direito bloqueado por condição transitória.
- **M2-D3 (decidida em 2026-09-25).** `10` §3 é emendado no mesmo commit da
  `0017`, pelo precedente de `22` §4 (linhas 278–282). A emenda é somente
  `code_digest text unique` (§5.1 (c)).
- **M2-D4 (decidida em 2026-09-26).** A autoridade de convite é somente do dono ou
  do organizador com membership `active` no momento da chamada; `created_by` é
  registro histórico, sem autoridade. `13` §5 (linha 611, `get_invite_share_link`)
  foi emendado para essa autoridade. Em `10` §11 (linha 1542), a linha que reunia
  `group_invites` e `match_invites` foi separada: `group_invites` segue a M2-D4, e
  `match_invites` fica como estava até o marco que a criar. A M2-D4 não conflita
  com a M2-D3: esta trata da coluna `code_digest` em `10` §3, que continua para o
  commit da `0017`; a M2-D4 emenda `10` §11.
- **M2-D5 (decidida em 2026-09-26).** A interface se divide pela alcançabilidade
  do estado de domínio: UI-A (entrada e convite) = telas 10, 11, 12, 16 e 24;
  UI-B (decisão e titularidade) = telas 17 e 25. Estado de domínio do E2E nasce
  pela UI da própria fatia ou de fatia anterior, ou pela Edge real por HTTP, com
  usuários criados pela API admin local de Auth; nenhum `insert` como `postgres`
  no E2E, exceto `suspended_at`, declarado teste a teste. A regra está na
  redação ajustada pela M2-D11; a original não admitia a Edge real. O gate 8
  passa a bloquear a UI-A. `16` §3 (linha da tabela do M2) e §8 foram
  emendados para a nova divisão. Razão: a divisão anterior deixava na UI-A provas que só a UI-B
  produzia — o pedido próprio pendente exige a tela 12, e a lista com mais de um
  ativo e a negação a criador rebaixado exigem as telas 17 e 25.
- **M2-D6 (decidida em 2026-09-26).** Mensalista fica fora da interface do M2: o
  selo das telas 10 e 11 e `set_monthly` na tela 17 saem do §6. A RPC
  `set_monthly` continua na `0016`, provada no banco com `monthly_enabled`
  preparado por fixture. O setter de `monthly_enabled` e o toggle da tela 25
  entram no M3, junto com os rachas (§7).
- **M2-D7 (decidida em 2026-09-26).** Aceite do antigo item 10 do §8.2:
  mutações de grupo sem trilha e sem N16/N17/N19/N24/N25 — e sem N28 na
  transferência por exclusão, `13` §2.11 — não chegam ao beta. `13` §0 (linha 42)
  e §5 as exigem na mesma transação, e este plano as adia para as fatias B2 de
  auditoria e outbox. A `0015` faz a transferência de titularidade por exclusão
  sem N28 e sem trilha, porque auditoria e outbox ainda não existem; o M2 roda
  localmente, mas não convida o beta antes das fatias B2 de auditoria e outbox.
  Com este aceite, a pré-condição da `0015` apontada pela terceira revisão
  independente (achado A8) está satisfeita: a `0015` pode começar.
- **M2-D8 (decidida em 2026-09-26).** Com mais de um organizador ativo elegível,
  a transferência por exclusão (§3.3, caso 2) escolhe o de `joined_at` mais
  antigo; empate pelo `profile_id` em bytes crescentes. Citação confirmada: `10`
  §6 (linhas 788–791) define a seleção automática da autoridade financeira como
  “dono elegível; senão menor `(joined_at, profile_id_bytes)`”, que é a mesma
  ordem; na exclusão o dono é quem sai, então vale somente a segunda parte. Fato
  consciente: `10` §3 (linhas 263–264) preserva `joined_at` na reentrada, e
  portanto um organizador que saiu e voltou concorre com a antiguidade da
  primeira entrada, não com a da reentrada. Resolve o antigo item 11 do §8.2.
- **M2-D9 (decidida em 2026-09-26).** Pedido pendente de grupo arquivado por
  exclusão do dono (§3.3, caso 4) passa a `removed`, com `removed_at` preenchido
  e `removal_count` inalterado, porque por `10` §3 o contador só aumenta na
  reentrada. Não há estado novo nem mudança em `10`. Resolve o indefinido do
  §8.2 sobre o estado resultante desse cancelamento, retirado de lá.
- **M2-D10 (decidida em 2026-09-26).** A transferência por exclusão (§3.3, caso
  2) é permitida em grupo suspenso, e o grupo continua suspenso. Razão: exclusão
  de conta é direito LGPD do titular, e a suspensão do grupo não está sob o
  controle dele. O bloqueio de transferência do §4.1 vale somente para a
  transferência comum por `transfer_ownership`. Resolve o indefinido do §8.2
  sobre a transferência por exclusão em grupo suspenso, retirado de lá.
- **M2-D11 (decidida em 2026-09-26).** A regra de E2E da M2-D5 passa a ser:
  “Estado de domínio do E2E nasce pela UI da própria fatia ou de fatia anterior,
  ou pela Edge real por HTTP, com usuários criados pela API admin local de Auth;
  nenhum insert como postgres no E2E, exceto suspended_at, declarado teste a
  teste.” Os cenários “grupo cheio” e “último uso” da UI-A semeiam as entradas
  dessa forma (§6.3) e são alcançáveis sem depender das telas da UI-B; o estado
  que exige aprovação é preparado pela Edge real (M2-D12). Semear pela Edge real
  não é adaptador: a chamada passa pelo envelope, pela capacidade e pela cota de
  produção.
- **M2-D12 (decidida em 2026-09-26).** O cenário “último uso” fica na UI-A. O
  estado que exige aprovação é preparado pela Edge real por HTTP, chamando
  `approve_member` e `remove_member`, que existem desde a `0016`; isso é
  permitido pela M2-D11. Como o dono ocupa uma vaga e o convite inicial tem 100
  usos, 99 resgates enchem o grupo antes de esgotar o convite. A semeadura libera
  uma vaga, aprovando e removendo um pendente pela Edge, antes de cada uma das
  duas tentativas: a do último uso bem-sucedido e a seguinte, que recebe
  `INVITE_USED`. A sequência exata está no §6.3, que também deixa explícito que
  “grupo cheio” e “último uso” são cenários distintos.
- **M2-D13 (decidida em 2026-09-27).** Travas de domínio usam
  `FOR NO KEY UPDATE`; `FOR UPDATE` somente quando a transação apaga a linha ou
  altera sua chave, o que o domínio do M2 não faz: perfis são desidentificados e
  grupos são arquivados. `10` §10 (linhas 1363–1365) foi emendado para esse modo,
  e `25` §2 registra a regra, o motivo, as operações enquadradas da `0015`, da
  `0016` e da `0017`, o par cruzado que as prova e a nota sobre o M1-B. Razão: o
  registro de idempotência tem FK `actor_id → profiles` (`0004`, linha 28), e
  inseri-lo trava o perfil do ator em `FOR KEY SHARE` antes dos locks ordenados
  do §2. Com `FOR UPDATE`, duas transações que travam o perfil uma da outra fecham
  um ciclo e terminam em `40P01`. O achado P1 da revisão do PR #36 reproduziu o
  ciclo em `delete_account`, com dois donos organizadores um no grupo do outro, e
  o obteve em 18 de 20 disparos simultâneos. `FOR NO KEY UPDATE` não conflita com
  `FOR KEY SHARE` e continua conflitando consigo mesmo, com `FOR UPDATE` e com
  `UPDATE`, então a serialização se mantém.
- **M2-D14 (decidida em 2026-09-27).** A `0015` redefine também, com
  `FOR NO KEY UPDATE`, toda função do M1-B que grava idempotência e depois trava
  com `FOR UPDATE` o perfil do próprio ator: `update_profile` (`0006`, linha 613)
  e `request_data_export` (`0013`, linha 823), as duas únicas que a auditoria
  pelo banco vivo encontrou. Razão: duas chamadas concorrentes da mesma pessoa
  seguram cada uma o `FOR KEY SHARE` da FK da idempotência e pedem `FOR UPDATE`
  no mesmo perfil, deadlock por upgrade. A nota da M2-D13 sobre o M1-B, segundo
  a qual a serialização continuava, era falsa para o mesmo ator e foi reescrita
  no §2. Medido antes da correção, em três execuções de 20 pares simultâneos do
  mesmo ator: 8, 12 e 9 pares com `40P01` em `request_data_export` e 20 nas três
  em `update_profile`.
- **M2-D15 (decidida em 2026-09-27).** As nove travas `FOR UPDATE` do M1-B que a
  segunda revisão independente do PR #36 encontrou fora da regra da M2-D13, em
  funções que a `0015` não redefine, não são corrigidas na `0015`. Ficam
  registradas no §8.2 com prazo: uma migration própria as alinha à M2-D13 antes
  de o M2 fechar. Nenhuma recai sobre tabela referenciada por chave estrangeira:
  nenhuma FK aponta para `deletion_requests`, `data_exports`, `external_effects`
  ou `job_runs`, então o deadlock por upgrade que a M2-D13 corrige, causado pelo
  `FOR KEY SHARE` que a verificação de FK toma, não se aplica a elas.
- **M2-D16 (decidida em 2026-09-28).** A recusa em `approve_member` faz
  `pending → removed`, com `removed_at = now()` e `removal_count` inalterado. Um
  novo resgate válido da `0017` incrementa o contador como qualquer reentrada.
  Não há mudança de schema. É coerente com a M2-D9, que dá o mesmo estado ao
  pedido pendente de grupo arquivado por exclusão do dono. `13` §5 (linha de
  `approve_member`) foi emendado. Resolve o indefinido do §8.2 sobre o estado
  resultante da recusa e seu efeito em `removal_count`, retirado de lá.
- **M2-D17 (decidida em 2026-09-28).** `set_role` e `set_monthly` sobre alvo sem
  membership `active` devolvem `NOT_ACTIVE_MEMBER`, o mesmo código de
  `transfer_ownership`. `13` §5 (linhas de `set_role` e `set_monthly`) foi
  emendado. Resolve o indefinido do §8.2 sobre esse erro, retirado de lá.
- **M2-D18 (decidida em 2026-09-28).** O `reason` de `remove_member` é
  obrigatório e validado: não vazio depois de trim e com no máximo 500
  caracteres, pelo precedente da nota privada de `13` §3.3. Fora disso, a
  chamada devolve `VALIDATION`, o código que `13` §8 já usa para entrada
  inválida. O motivo não é persistido no M2: não vai para tabela, log, erro nem
  outcome. Ele passa a ser persistido quando a trilha do grupo chegar (B2). `13`
  §5 (linha de `remove_member`) foi emendado. Resolve o indefinido do §8.2 sobre
  o destino do `reason`, retirado de lá.

- **M2-D19 (decidida em 2026-09-28).** Aceitas as quatro escolhas da `0016`
  apontadas na primeira revisão do PR #40: (1) `approve_member` sobre perfil
  sem pedido devolve `NOT_FOUND`; (2) `remove_member` sobre alvo sem membership
  `active` devolve `NOT_ACTIVE_MEMBER`; (3) `transfer_ownership` exige membership
  `active` e conta `active` do novo dono; (4) transferir para si mesmo conclui
  sem efeito: o registro idempotente é concluído, sem `UPDATE` em `groups` e sem
  disparo de gatilho de atualização. `13` §5 foi emendado nas três linhas.
- **M2-D20 (emendada em 2026-09-28).** Com autenticação válida, o replay
  devolve o desfecho gravado, somente com IDs estáveis e `logical_result`.
  Depois dos locks e antes de qualquer projeção, executa a mesma checagem de
  autoridade no grupo da chamada nova: membership, papel e titularidade atuais.
  `current` fresco só acompanha a resposta se ela autorizar agora. Se negar, a resposta é HTTP 200 com
  `{ data: { outcome }, request_id }`, com `current` ausente e nenhum dado atual
  de grupo, membro ou perfil. Ausência distingue falta de autorização de uma
  projeção autorizada com valor `null`. A chamada nova conserva o erro normal.
  Nas sete RPCs da `0016`, isso também permite repetir `leave_group` concluído
  e `transfer_ownership` pelo antigo dono, sem projeção e sem repetir o efeito.
  `13` §0 e as sete linhas de §5 foram emendados no commit único da `0016`.
  **Ajuste humano de 28/09, complemento de segurança do PR #40:** perda de
  autenticação — sessão revogada, `account_status` diferente de `active` ou
  aceite obrigatório pendente — devolve o mesmo erro normal da chamada nova,
  inclusive no replay, sem desfecho nem projeção. Nas sete RPCs da `0016`, a
  checagem de autenticação ocorre depois dos locks, antes do ramo de replay e
  fora do tratamento da perda de autoridade no grupo. Membership, papel e
  titularidade perdidos continuam devolvendo o desfecho gravado sem `current`.
  A única exceção permanece `delete_account` (M2-D21), sem alteração nesta
  rodada.
- **M2-D21 (decidida em 2026-09-28).** A regra de `13` §0 vale para todas as
  mutações, com uma exceção escrita: o replay de `delete_account` depois da
  própria autorrevogação devolve os campos da própria exclusão, o canal de nova
  tentativa de `13` §5.3, `14` §5 (linhas 56–72) e `0012` (linhas 67–68).
  `current` fica limitado a `id`, `status`, `requested_at`, `completed_at` e
  `has_operational_failure`, sem restaurar autoridade de domínio. O replay de
  `request_data_export` com sessão revogada ainda devolve `current` e fica como
  divergência temporária no §8.2, com prazo **antes de fechar o M2**, na mesma
  migration da M2-D15. Nenhuma dessas duas RPCs é corrigida nesta fatia.

### 8.2 Gates humanos

A implementação não pode preencher estas respostas:

1. Qual armazenamento e quais limites iniciais aprovados serão usados para o
   rate limit por perfil/IP dos resgates? A escolha precisa de retenção,
   privacidade e comportamento de fallback definidos antes da `0017`. A decisão
   também precisa dizer como o E2E local semeia os resgates e as aprovações pela
   Edge a partir do mesmo IP (§6.3, M2-D12) sem desligar o limite do código
   produtivo, por exemplo com valor por ambiente.
2. Quem executa a cerimônia de rotação, guarda as versões antigas e aprova sua
   remoção? A CI pode provar nomes e cobertura, mas não custódia operacional.
   Precisa estar decidido antes do primeiro deploy.
3. Qual é a origem pública por ambiente usada no link compartilhável? A migration
   não grava domínio de produção e a Edge não inventa URL a partir de header não
   confiável. O mecanismo entra na `0017`; o valor precisa estar decidido antes
   do deploy.
4. A validação jurídica aprova papéis, bases legais e retenção de memberships,
   convites, IP derivado e fotos? Sem aprovação, o M2 pode ser testado localmente,
   mas não convidar o beta.
5. Quem é o responsável operacional e o canal para abuso de convite, efeito
   `dead`, grupo suspenso e exclusão bloqueada? Sentry não define plantão.
   Precisa estar decidido antes do beta.
6. Qual é a validade do convite inicial de `create_group`? `expires_at` é
   `not null` e nenhum normativo fixa o valor. Precisa estar decidida antes da
   `0017`.
7. Qual código de erro estável recusa a tentativa acima do rate limit? `13` §8
   ainda não o tem, e ele precisa ser registrado lá **antes** da `0017`, com a
   prova do §5.3.
8. A projeção de preview do nome do grupo e o nome do grupo na projeção do
   pedido próprio pendente (§5.3) exigem emenda a `13` antes da `0017`. Sem ela, a
   UI-A não começa (M2-D5), e a UI-B, que vem depois dela, também não.
9. Os contratos cliente de revogar e regenerar convite (tela 24) e de nome/foto e
   arquivamento (tela 25) não existem em `13`. Enquanto não forem registrados, as
   telas não renderizam esses controles; revogar e regenerar só entram na tela 24
   do M2 se forem registrados antes da `0017`. O setter de mensalista habilitado
   da tela 25 saiu deste gate: entra no M3 (M2-D6).
10. Decidido como M2-D7 (§8.1). O número fica reservado para que as referências
    aos demais itens não mudem.
11. Decidido como M2-D8 (§8.1). O número fica reservado para que as referências
    aos demais itens não mudem.
12. Qual é o formato de evidência da passada manual com leitor de tela de `15`
    §3? Sem ele, UI-A e UI-B não fecham.
13. Alfabeto, comprimento e piso de entropia do código humano, com o cálculo que
    os justifica a partir do rate limit do item 1 e do número esperado de
    convites vivos. Precisa estar decidido antes da `0017`. `10` §3 exige entropia
    mínima versionada, mas não fixa o número. Recomendação da revisão: nenhum piso
    abaixo de 40 bits.
14. Derivação e entrega do código humano: de onde a tela 24 obtém o código
    (emenda a `13`, projeção da autoridade de convite), e o efeito de rotação e
    regeneração sobre `code_digest`. Precisa estar decidido antes da `0017`.
    Recomendação da revisão: código derivado de
    `HMAC(key_v, "colete/invite-code/v1\0" || invite_id || public_nonce)`,
    truncado ao formato do item 13; `code_digest` recalculado na rotação e na
    regeneração; nonce refeito em caso de colisão do `unique`.

Decisões de escopo do plano, sem gate humano:

- **Admin:** o M2 não implementa RPC Admin. `suspended_at` é preparado por
  fixture como `postgres` somente no setup, e a verificação passa pela Edge real
  (§4.1).
- **Retenção de `17` §2:** `purge_removed_memberships` (12 meses) entra na
  `0016` e o expurgo de convite em revogação ou expiração + 30 dias entra na
  `0017`, cada um com prova. O agendamento segue o estado dos demais jobs.

Pendências registradas, com prazo:

- **Travas do M1-B fora da M2-D13 (M2-D15, §8.1).** Prazo: uma migration própria,
  antes de fechar o M2, as alinha à M2-D13. São nove, citadas pela função e pela
  linha no `pg_get_functiondef` vivo depois da `0015`, como a segunda revisão do
  PR #36 as listou: `private.reconcile_deletion_request`, linha 13
  (`deletion_requests`); `public.consume_data_export`, linha 21 (`data_exports`);
  `public.enqueue_data_export_purge`, linha 9 (`data_exports`);
  `public.finalize_deletion`, linha 19 (`deletion_requests`);
  `public.worker_acquire_external_effect`, linha 67 (`external_effects`,
  `FOR UPDATE SKIP LOCKED`); `public.worker_complete_external_effect`, linha 26
  (`external_effects`); `public.worker_execute_database_job`, linha 10
  (`job_runs`); `public.worker_finish_job`, linha 24 (`job_runs`); e
  `public.worker_publish_data_export`, linha 9 (`external_effects`). A `0016`
  reescreve `worker_execute_database_job` para despachar
  `purge_removed_memberships` e, pela regra do §2, alinha a trava dela a
  `FOR NO KEY UPDATE`; restam oito.

- **Replay de `request_data_export` sem autoridade atual (M2-D21, §8.1).**
  Prazo: **antes de fechar o M2**, na mesma migration própria da M2-D15 acima.
  Em `0015_group_foundation.sql:831` (origem `0013:818`), o replay precede a
  denylist em `0015:843`; com sessão revogada, ainda devolve desfecho e
  `current`, enquanto a chamada nova dá `UNAUTHENTICATED`. É divergência
  temporária de `13` §0: a migration deve revalidar a autenticação antes do
  replay e, quando negada, devolver o erro normal sem desfecho nem `current`,
  pelo ajuste de 28/09 à M2-D20 emendada. A projeção atual é somente
  do titular, sem link, path ou token; download continua exigindo sessão válida
  e reautenticação recente. Esse prazo é uma decisão expressa, não bloqueio da
  `0016` nem exceção permanente à denylist. Não corrigir nesta rodada.

Continuam indefinidos, e cada um precisa de resposta antes da fatia que o
implementa, sem que o implementador escolha:

- o que um membro já `active` recebe ao resgatar convite do próprio grupo, dado
  que `13` §5 só prevê `{ status: 'pending', reentry }`, e se esse resgate
  consome uso do convite, antes da `0017`. O §4.2 só fixa que a membership
  ativa não é rebaixada e que a resposta não revela a terceiros a membership.
  Insumo da decisão, sem decidi-la: se esse resgate consumir uso, um único
  perfil esgota os 100 usos do convite trocando o `request_id`, limitado
  somente pelo rate limit;
- o que acontece quando perfil já `pending` no grupo resgata de novo com
  `request_id` novo, pelo mesmo convite ou por outro convite do mesmo grupo,
  antes da `0017`: se consome uso do convite, se atualiza `last_requested_at` e
  qual `reentry` devolve. O §4.2 diz “sem nova membership nem consumo
  duplicado”, mas não diz se “duplicado” cobre só o replay idempotente, que o
  envelope já resolve, ou também o resgate novo; e o passo 4 do §5.3 incrementa
  `used_count` antes do passo 5, sem ramo para membership já `pending`. Insumo
  da decisão, sem decidi-la: se esse resgate consumir uso, um único perfil
  esgota os 100 usos do convite trocando o `request_id`, limitado somente pelo
  rate limit.

Continuam valendo os gates herdados: textos/digests legais efetivos, restore
isolado, RPO/RTO aceitos e evidência em hardware real antes do beta. Nenhuma
resposta muda a numeração; se exigir contrariar documento normativo, o trabalho
para antes da migration.

## 9. Manifesto de especificação

Este plano entra em `docs/spec-manifest.sha256`. Diferente dos documentos
operacionais `19`–`21` e `23`, ele fixa a numeração `0015`–`0017`, a ordem global
de locks, as duas extensões da saga de exclusão, as fronteiras de RLS/HMAC e os
critérios de saída que as próximas fatias precisam obedecer. Portanto é
especificação de implementação e precisa falhar por drift. Com sua inclusão, a
baseline passa de 23 para **24 entradas**. O documento operacional do M2, quando
existir, fica fora do manifesto pelo mesmo precedente dos marcos anteriores.

A numeração salta de `23` para `25` porque `docs/24-entrega-academica.md` existe
no commit `05fc2fd`, na branch `demo/apresentacao-academica` (PR #25, inativo), e
não em `main`. Ele está fora do manifesto: registra uma entrega acadêmica, não
contrato de implementação.
