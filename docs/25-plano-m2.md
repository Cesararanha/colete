# Plano detalhado do M2 — grupos, reentrada, papéis e convites

Status deste documento: **normativo para sequenciamento e critérios de saída do
M2**. Ele não cria requisito de produto e não substitui `09`, `10`, `11`, `13`,
`14`, `15`, `16` ou `17`; quando houver divergência, esses contratos prevalecem
e a fatia para. Este plano também não autoriza deploy, configuração do projeto
remoto nem criação de segredo real. A presente fatia cria somente este documento,
seu ponteiro no roadmap e sua entrada no manifesto: nenhuma migration, função,
bucket, tela ou configuração Supabase é criada agora.

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
  e `delete_storage_object`;
- a `0013` também fixou a ordem real perfil → export e provou com duas conexões
  que build concorrendo com exclusão não produz `SQLSTATE 40P01`;
- a `0014` unificou os slots UTC do worker e fez efeito Auth vencido convergir
  depois de a saga já estar concluída.

Ainda não existem `groups`, `group_members`, `group_invites`, policies de grupo,
RPCs de membership, material de convite, rota Edge de convite nem as telas 10–12.
Consequentemente, o guard de substituto opera sobre conjunto vazio e nenhuma
foto de grupo participa do fence de Storage da exclusão. Essas não são exceções
permanentes: são os dois pontos de extensão obrigatórios da primeira fatia.

## 2. Mapa fatia → migration

| Ordem | Fatia | Migration | Entrega que precisa ser provável | O que destrava | Revisão independente esperada |
| --- | --- | --- | --- | --- | --- |
| 1 | Fundação, isolamento e extensão da exclusão | `0015_group_foundation.sql` | tabelas/constraints, RLS default-deny, owner derivado, trigger diferido, limites canônicos, guard real de exclusão, arquivamento solo e `purge_group_photo` dentro do fence fechado de Storage | um domínio de grupos seguro para as RPCs; a saga não pode apagar Auth deixando ownership ou foto de grupo para trás | **4 rodadas:** schema/constraints; RLS e privilégios com papel-sonda; saga/Storage e crashes; locks/commit real/privacidade |
| 2 | Membership, papéis e titularidade | `0016_group_membership_rpcs.sql` | `create_group`, aprovação, remoção, papel, mensalista, visibilidade, transferência e saída; quinta/sexta membership e 100º/101º membro serializados; suspensão fail-closed | administração transacional do grupo sem convite e extensão segura futura para rachas/finanças | **4 rodadas:** envelope e grants; concorrência/capacidade; owner/reentrada/suspensão; caminho HTTP real e contraprovas |
| 3 | Convites, reentrada e HMAC | `0017_group_invites.sql` | código/link, compartilhamento, revogação, expiração, esgotamento, rotação global de versão, token ausente do banco/log e consumo concorrente único | entrada pendente, reentrada explícita e critério de saída criptográfico do M2 | **5 rodadas:** formato/vetores; cofre/rotação/dump; locks/capacidade; HTTP/log/referrer; RLS/projeções e abuso |
| 4 | Telas 10, 11 e 12 | —, sem migration | navegação Grupos/Perfil, lista, detalhe e entrada por código/link sobre contratos reais, com a lista integral de `15` e E2E pelo gateway produtivo | entrega visível do M2 sem botão, adaptador ou estado inventado | **3 rodadas:** estados/requests; acessibilidade integral e reflow; E2E/segurança de token e regressões |

O corte é deliberado. A `0015` cria juntas as três tabelas porque as FKs, o
owner derivado, a capacidade e o isolamento precisam ser provados como um grafo;
na mesma migration ela salda as duas extensões que a existência de `groups`
torna obrigatórias. A `0016` usa esse grafo sem misturar segredo ou parsing de
token e concentra as corridas de membership/titularidade. A `0017` só então
adiciona a fronteira criptográfica e o consumo de convites, permitindo revisar
HMAC, URL e logs sem esconder defeito de capacidade dentro do mesmo diff. A
interface vem por último e não recebe migration artificial.

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
→ pedidos de exclusão → external_effects
```

Perfis, grupos, memberships e demais UUIDs do mesmo nível são travados pelos
bytes crescentes. A leitura necessária apenas para descobrir a chave do pai não
trava o filho: por exemplo, `join_by_invite` lê o `group_id`, trava perfil e
grupo, trava a membership e só então trava/revalida o convite. `delete_account`
trava o perfil, todos os grupos próprios em ordem crescente, suas memberships e
somente depois exports, pedido e efeitos. Worker que parte de um efeito resolve
primeiro as chaves, então volta à ordem canônica antes de travar domínio. Nenhum
handler pode conservar lock de `external_effects` enquanto tenta adquirir
perfil/grupo; aquisição e conclusão do lease continuam transações curtas.

Essa extensão preserva perfil → export, já provado no M1-B, e coloca todo o novo
domínio de grupos antes dele. Harness com conexões independentes executa, nas
duas ordens, exclusão × transferência, exclusão × criação/entrada, rotação ×
resgate e aprovação × saída; `40P01` reprova a fatia, não é retry normal.

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
pgTAP não basta.

Índices cobrem `owner_id`, memberships por perfil/status e contagens de
`pending|active`; índice não substitui os locks. `group_invites.token_digest` é
único, `public_nonce` tem exatamente 16 bytes e `token_version > 0`.

### 3.2 Isolamento tabela por tabela

As policies são fechadas e testadas com um papel-sonda sem `BYPASSRLS`:

| Tabela | Leitura autorizada | Prova negativa obrigatória |
| --- | --- | --- |
| `groups` | membership própria `active` no grupo; grupo arquivado somente por projeção histórica autorizada, não por enumeração | membro ativo de A não lê a linha de B; `pending` e `removed` não leem a linha do grupo |
| `group_members` | membro ativo lê as memberships do próprio grupo; `pending` lê somente a própria linha/pedido | membro de A não lê membership de B; pendente não enumera membros nem outro pedido |
| `group_invites` | criador ou owner/organizer ativo lê somente a projeção administrativa allowlisted | membro comum, pendente e organizador de outro grupo não leem; ninguém cliente recebe `token_digest` ou material bruto |

RLS filtra linhas, não colunas. Por isso grants diretos de `group_invites` não
incluem `token_digest` nem `public_nonce`; a listagem usa projeção tipada com
`id`, `group_id`, `expires_at`, `revoked_at`, `max_uses`, `used_count` e
`created_at`. O link compartilhável é outra projeção, exclusiva da Edge e
definida na fatia 3. `groups` e `group_members` também recebem grants somente
nas colunas necessárias às telas 10–11.

A suíte cria dois grupos, membro ativo, pendente e identidade alheia, afirma o
caminho positivo de cada leitor e só depois as negações cruzadas. Ela prova
explicitamente `rolbypassrls=false` do papel-sonda, ausência de policy de escrita,
zero DML direto de `service_role` e grants futuros cobertos pelos defaults da
`0004`.

### 3.3 Extensão obrigatória da exclusão e de Storage

Na mesma migration que cria `groups`,
`private.require_financial_deletion_substitute(profile_id)` deixa de operar
sobre conjunto vazio:

1. com o perfil já travado, trava em UUID crescente todos os grupos em que ele é
   owner e as memberships correspondentes;
2. grupo com outro membro ativo exige transferência prévia e retorna
   `FINANCIAL_SUBSTITUTE_REQUIRED` sem iniciar a saga;
3. grupo sem outro membro ativo e sem caso financeiro é realmente solo para o
   M2: é arquivado no mesmo commit, pedidos pendentes deixam de conferir qualquer
   expectativa de entrada e a membership do owner perde autoridade;
4. a extensão futura do M5 consulta casos financeiros antes do arquivamento e
   conserva a mesma chamada em `delete_account`.

O guard não escolhe substituto, não promove pending e não transfere por heurística.
Se havia candidato, a pessoa precisa usar `transfer_ownership`; exceção Admin usa
o contrato já definido em `13` §5.4.

`groups.photo_url` representa objeto de Storage e, portanto, nasce já coberto
pela regra geral: **toda fatia que introduzir um novo objeto de Storage acrescenta
seu kind à lista fechada de `private.deletion_has_pending_storage` na mesma
migration**. O bucket `group-photos` nasce privado e sem policy de cliente;
`photo_url` guarda somente o localizador interno e não recebe grant de leitura.
Membro ativo obtém a imagem por `GET /group-photos/:group_id/content`, que revalida
sessão e membership, faz stream sem redirect e responde `private, no-store`.
Nenhum path ou signed URL chega ao cliente. A `0015` cria `purge_group_photo`,
publica o handler correspondente no worker e estende simultaneamente:

- a allowlist aceita por `worker_acquire_external_effect`;
- a projeção/confirmador fenced do handler;
- o relacionamento `group_photo → group → owner/deletion_request`;
- `deletion_has_pending_storage`, para que `pending|leased|failed_retryable`
  bloqueiem `delete_auth_user`;
- a reconciliação de `dead`, com marcador operacional durável e path mantido
  somente na fronteira privada quando ausência não foi confirmada.

Ao arquivar grupo solo com foto, `delete_account` enfileira
`purge_group_photo:<group_id>:<deletion_request_id>`. A chave é por ocasião da
saga, como no M1-B. O token/path não entra em idempotência, efeito, job, erro ou
log. O Auth só fica adquirível depois de o objeto estar ausente ou a política
terminal explícita registrar falha operacional; crash antes/depois do delete e
antes/depois da confirmação converge por observação do Storage.

Nenhum upload de foto nem UI de edição entra automaticamente por existir a
coluna. Quando uma fatia futura publicar o produtor do objeto, ela reutiliza o
kind e precisa provar o caminho HTTP real; não pode criar uma segunda lista de
kinds nem outro fence paralelo. O stream de leitura já publicado pela fundação
é exercitado pela Edge real com foto de fixture, inclusive outro grupo, sessão
revogada, grupo suspenso, headers e ausência de redirect/cache.

### 3.4 Provas de saída e orçamento

Além das quatro rodadas da tabela do §2, a fatia só fecha quando provar: banco
do zero; constraints e FKs; trigger de owner em commit real; RLS positiva e
cruzada por tabela; zero DML administrativo; quinto/sexto e 99º/100º/101º sob
25 conexões; exclusão bloqueada com membro ativo; grupo solo arquivado; foto
pendente impedindo Auth; crash e retry do purge; dump sem path/token/PII; e
ausência de linha ou objeto residual no fim dos harnesses.

## 4. Fatia 2 — `0016_group_membership_rpcs.sql`

### 4.1 Envelope, locks e operações

Cada mutação amplia de forma append-only as allowlists de operação, outcome e
resource do livro de idempotência, recebe o contexto interno do gateway e
conquista a chave antes de qualquer lock de domínio. Outcomes contêm apenas IDs
estáveis e `logical_result`; papel, capacidade, status, contagem e autoridade
atuais vêm de projeção fresca.

| Operação | Locks e invariantes | Erros específicos |
| --- | --- | --- |
| `create_group` | perfil → novo grupo → membership; reconta ativas, cria owner e membership `organizer/active`, cria convite inicial com `max_uses=100` mas sem produzir token no banco | `GROUP_LIMIT` |
| `approve_member` | perfil alvo → grupo → membership; owner/organizer ativo, capacidade e cota recontadas; recusa não fabrica outra linha | `MEMBERSHIP_ALREADY_DECIDED`, `GROUP_LIMIT`, `GROUP_FULL` |
| `remove_member` | perfis afetados em ordem → grupo → memberships; owner é recusado; no M2 o conjunto de rachas/provas é vazio e a primitiva fica preparada para extensão atômica no M3/M5 | `IS_OWNER`, `PROOFS_PENDING` |
| `set_role` | perfil alvo → grupo → membership; somente owner; owner continua derivado de `owner_id` | `OWNER_ONLY`, `NOT_ACTIVE_MEMBER` |
| `set_monthly` | perfil alvo → grupo → membership; somente autoridade permitida; `is_monthly=true` exige `monthly_enabled` | `MONTHLY_DISABLED`, `NOT_ACTIVE_MEMBER` |
| `set_ratings_visibility` | perfil ator → grupo; confirmação explícita para `members`; owner only | `OWNER_ONLY`, `VISIBILITY_CONFIRMATION_REQUIRED` |
| `transfer_ownership` | perfis antigo/novo por bytes → grupo → memberships; novo owner precisa estar ativo; altera somente `groups.owner_id` | `NOT_ACTIVE_MEMBER` |
| `leave_group` | perfil → grupo → própria membership; owner recebe erro antes de qualquer efeito; membership muda por último | `OWNER_MUST_TRANSFER`, `PROOFS_PENDING` |

As operações revalidam `account_status`, aceite pendente, sessão revogada,
membership e `suspended_at` depois dos locks. Grupo arquivado retorna
`GROUP_ARCHIVED`. Grupo suspenso retorna `GROUP_SUSPENDED` para criação/entrada,
aprovação, papel, mensalista, visibilidade, transferência comum e qualquer edição.
A allowlist mínima continua disponível: leitura própria, privacidade/exportação,
`leave_group` de não-owner e, nos marcos futuros, cancelamento seguro e resolução
financeira pela autoridade substituta. `set_group_suspension` e
`admin_transfer_ownership` seguem o caminho Admin de `13` §5.4, com razão
obrigatória e grants separados; não existe painel administrativo no M2.

Transferência e saída geram as trilhas/notificações somente quando os objetos
de auditoria/outbox chegarem na fatia B2 correspondente; o M2 não inventa uma
tabela parcial para antecipá-los. A ausência atual desses objetos não autoriza
log livre nem resposta com PII.

### 4.2 Reentrada e `removal_count`

Remoção não é banimento. A linha `(group_id, profile_id)` nunca é substituída
para apagar o histórico:

- `active → removed` marca `removed_at`, desliga `is_monthly` e retira
  autoridade; não existe RPC de reativação direta;
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
não revela a terceiros se o perfil já pertence ao grupo.

### 4.3 Provas de saída e orçamento

As quatro rodadas cobrem: envelope/grants; concorrência; titularidade/reentrada;
e HTTP real. O harness de 25 conexões prova duas criações contra a quinta vaga,
duas aprovações contra a sexta, duas aprovações contra a 100ª vaga, transferência
× saída e exclusão × transferência nas duas ordens. Contraprovas removem cada
lock-pai e precisam produzir sexta membership, 101º membro ou estado de owner
inválido. Toda rota Edge é chamada por HTTP real com JWT GoTrue; o harness não
possui switch/adaptador próprio diferente do gateway produtivo. O commit como
`service_role` prova o trigger diferido e a idempotência concluída.

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
Código humano usa alfabeto sem caracteres ambíguos, entropia/versionamento
fechados e digest HMAC separado. Token e código completos chegam à Edge, são
normalizados e viram apenas IDs, versão e digest na chamada interna: **o token
nunca chega ao PostgreSQL**.

O link usa fragmento, nunca query. A página troca o fragmento por POST, remove-o
com `history.replaceState` antes de analytics/observabilidade e envia
`Referrer-Policy: no-referrer`. Token não entra em Sentry, título, cache,
localStorage, histórico de requests ou erro. A rota recusa redirect e resposta
cacheável.

### 5.2 Criação, compartilhamento e rotação

`create_group` já deixa um convite inicial. A fatia publica as operações internas
necessárias para revogar e para a rotação operacional de versão, sem painel novo.
Rotação é global e explícita: após provisionar a próxima chave, lotes em UUID
crescente trocam `token_version`, nonce e digest de cada convite vivo; o material
anterior deixa de validar no mesmo commit da linha. Lote interrompido é retomável,
versionado e nunca aceita duas versões simultâneas da mesma linha. Convite
revogado, expirado ou esgotado não é ressuscitado pela rotação; criar outro
convite é uma nova ocasião.

`get_invite_share_link(invite_id)` é a projeção sensível externa da Edge. Somente
`created_by` ou owner/organizer `active` do mesmo grupo a recebe. O banco devolve
à Edge, por RPC nominal, apenas o material necessário e revalida autoridade,
revogação, expiração e `used_count < max_uses` sob a linha corrente. A Edge
recalcula o MAC, confere o digest persistido e devolve ao cliente somente:
`invite_id`, `expires_at`, `remaining_uses` e `share_url` com token no fragmento.
Não devolve `token_digest`, chave, versão de chave, nonce separado ou URL de
ambiente em coluna. Revogado retorna `INVITE_REVOKED`, expirado
`INVITE_EXPIRED` e esgotado `INVITE_USED`; nenhuma dessas condições produz link.

Recompartilhar não consome uso nem gira material. Rotação invalida o link antigo
e exige novo compartilhamento. Dump do banco contém nonce público, versão e
digest, mas sem o keyring não produz MAC válido; contraprova com chave errada
precisa falhar.

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
não número a ser inventado pelo implementador.

### 5.4 Provas de saída e orçamento

As cinco rodadas cobrem criptografia, segredo/dump, concorrência, HTTP/log e
isolamento. Provas mínimas: nonce de 16 bytes; u16 big-endian; base64url sem
padding; domínio exato; vetor nos runtimes; MAC inválido; versão desconhecida;
fragmento removido; compartilhamento autorizado; outro grupo negado; revogado,
expirado e esgotado; rotação invalidando o anterior; 25 resgates no último uso;
99º/100º/101º membro; reentrada única; nenhum token em banco/log/Sentry/cache;
e objeto/linha residual zero. Toda rota passa pela Edge real. O teste importa o
mesmo parser, provider e dispatcher de produção; um `case` ausente no gateway ou
um status real divergente reprova o critério de saída.

## 6. Fatia 4 — telas 10, 11 e 12

A interface entra somente depois de `0015`–`0017`, sem migration e sem botão
oculto/desabilitado antes do contrato. A área autenticada passa a ter Grupos e
Perfil; Rachas continua ausente até o M3. Em tela larga a mesma navegação vira
lateral, conforme `11` §0.

- **Tela 10 — Grupos:** carregamento por esqueleto, erro honesto com retry,
  vazio com ação, lista de memberships autorizadas e selos derivados da
  projeção. A criação usa `create_group` pelo gateway e conserva o mesmo
  `request_id` em retry; não escreve tabela nem cria token no cliente;
- **Tela 11 — Detalhe:** nome/foto pela projeção segura, membros e papéis conforme
  RLS, selo mensalista somente quando habilitado e saída com
  `OWNER_MUST_TRANSFER` explicada como “transfira a titularidade primeiro”.
  Histórico de rachas e notas não são placeholders: entram nos marcos que criam
  esses contratos. Blocos de organizador aparecem somente para operações M2 já
  disponíveis;
- **Tela 12 — Código/link:** código e fragmento nunca se confundem; confirma o
  grupo, chama a Edge uma vez e mostra `pending` como **aguardando aprovação**.
  Revogado, expirado, esgotado, arquivado, suspenso, cheio e limite pessoal têm
  mensagens estáveis sem revelar membership prévia.

A fatia aplica **a lista integral de `15-acessibilidade.md`**, não um resumo:
contrastes nos dois temas, componentes 3:1, texto 200%, 44×44, teclado, foco,
rótulos/estados, associação e anúncio de erros, headings/título por rota,
validação no blur e em tempo real depois do primeiro erro, botão focável com foco
no primeiro campo inválido, redução de movimento, horários absolutos, linguagem
simples, prevenção de erro, passada manual e as exceções declaradas. Axe é camada
adicional, não substitui leitor de tela.

O E2E usa Auth, Edge e Postgres locais reais. Inspeciona URL, corpo, headers,
Cache API, storage persistente e Sentry fake para provar ausência de token/HMAC/
ator. Exercita membro de outro grupo, reentrada, último uso, grupo cheio,
transferência antes da saída e grupo suspenso. Nenhum harness implementa parser,
classificador de erro ou adapter próprio: importa o mesmo código produtivo.

## 7. O que fica fora do M2

- rachas, recorrências, Pix, participantes, claims e capacidade de jogo: M3–M5;
- provas, ciclos, ledger, estornos, contestações e casos financeiros: M5 estende
  o guard de exclusão e as primitivas de remoção sem reescrever o M2;
- notas, histórico de rachas, sorteio e composição: M6; as telas não exibem
  placeholder nem dado sintético;
- auditoria tipada, outbox N1–N28 e entrega de notificações: permanecem nas
  fatias B2 correspondentes; o M2 não cria log livre substituto;
- painel amplo de Admin e as telas organizadoras 17, 24 e 25: operações sem
  painel continuam no caminho administrativo estreito já contratado;
- upload/edição de foto de grupo: a fundação cobre path existente e purge, mas
  não inventa produtor sem contrato de upload; a futura fatia de upload estende
  export, backup e testes HTTP no mesmo commit;
- textos/digests legais, Google OAuth, rate limit geral do gateway, deploy,
  secrets reais, projeto Supabase remoto, app nativo, Apple Sign In e push;
- mudança em `09`, `10`, `11`, `13`, `14`, `15`, `17`, `18` ou `22`. Divergência
  com qualquer um deles é bloqueio, não licença para o plano prevalecer.

## 8. Decisões e gates humanos

A implementação não pode preencher estas respostas:

1. Qual armazenamento e quais limites iniciais aprovados serão usados para o
   rate limit por perfil/IP dos resgates? A escolha precisa de retenção,
   privacidade e comportamento de fallback definidos antes da `0017`.
2. Quem executa a cerimônia de rotação, guarda as versões antigas e aprova sua
   remoção? A CI pode provar nomes e cobertura, mas não custódia operacional.
3. Qual é a origem pública por ambiente usada no link compartilhável? A migration
   não grava domínio de produção e a Edge não inventa URL a partir de header não
   confiável.
4. A validação jurídica aprova papéis, bases legais e retenção de memberships,
   convites, IP derivado e fotos? Sem aprovação, o M2 pode ser testado localmente,
   mas não convidar o beta.
5. Quem é o responsável operacional e o canal para abuso de convite, efeito
   `dead`, grupo suspenso e exclusão bloqueada? Sentry não define plantão.

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
