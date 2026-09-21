# Colete — Schema do banco de dados (v2, implementação incremental)

**PostgreSQL / Supabase.** Deriva de `01-requisitos.md`, `09-pivo-produto.md` e
`04-algoritmo-sorteio.md` v3. Nomes de código em inglês, timestamps em `timestamptz` UTC e
fuso IANA do racha armazenado à parte.

Este documento define invariantes que as migrations precisam implementar. Comentário não é
garantia: cada regra abaixo vira constraint, trigger, policy, função ou teste negativo.

---

## 1. Princípios irredutíveis

1. RLS habilitada e forçada em **toda** tabela exposta; ausência de policy significa negar.
2. Tabelas críticas não aceitam escrita direta de `anon`/`authenticated`; só RPC.
3. Toda mutação do usuário recebe `request_id` e conquista, na mesma transação, uma chave
   idempotente única antes de produzir efeito de negócio. Nenhum estado intermediário é
   commitado ou observável.
4. Ordem global de lock: idempotência → perfis → grupos → memberships → recorrências → rachas → convites
   → participantes/claims → ciclos → sessões/provas → resolução/estorno/contestação/caso.
   Nenhuma função inverte essa ordem.
5. Fato/valor/estado/payload de auditoria e ledger não sofre update/delete e não usa cascade.
   A única exceção é a rotina de retenção, que pode zerar vínculo identificador/texto livre
   explicitamente previsto no mapa, sem mudar o fato; cada redação entra em `retention_runs`.
6. `profiles.id` é identidade interna; apagar Auth não apaga o histórico.
7. Dados públicos nunca contêm nota privada, comprovante, fingerprint, chave Pix completa ou PII de
   operação.
8. O payload externo do M1-A nunca envia `actor_id`, `auth_user_id`, `profile_id`,
   `session_id` ou papel Admin. Em contratos posteriores, um `profile_id` expressamente
   listado pode identificar o **alvo** de uma ação administrativa, nunca o ator. Em mutação, a
   Edge valida o JWT e entrega contexto de ator à RPC interna por um caminho administrativo
   exclusivo. Como esse caminho não executa sob o JWT do usuário, o banco não atribui a origem
   do ator a `auth.uid()`; ele confia na Edge autenticada e no grant estreito da função, mas
   ainda resolve o perfil e revalida toda autorização de domínio.

## 2. Identidade, aceite e privacidade

```sql
create table profiles (
  id              uuid primary key default gen_random_uuid(),
  auth_user_id    uuid unique references auth.users(id) on delete set null,
  name            text not null,
  nickname        text,
  photo_url       text,
  position        text check (position in ('goalkeeper','defender','midfielder','forward')),
  dominant_foot   text check (dominant_foot in ('left','right','both')),
  shirt_number    int,
  account_status  text not null default 'active'
                  check (account_status in
                         ('active','suspended','banned','deletion_pending','deleted')),
  status_changed_at timestamptz,
  deidentified_at timestamptz,
  created_at      timestamptz not null default now(),
  check ((account_status in ('active','suspended','banned') and auth_user_id is not null
          and deidentified_at is null)
      or (account_status = 'deletion_pending' and deidentified_at is null)
      or (account_status = 'deleted' and auth_user_id is null and deidentified_at is not null))
);

create table private.policy_documents (
  document_type text not null check (document_type in ('terms','privacy')),
  version        text not null,
  content_sha256 bytea not null check (octet_length(content_sha256) = 32),
  published_at   timestamptz not null,
  mandatory      boolean not null default false,
  primary key (document_type, version)
);
create unique index one_mandatory_policy_per_type
  on private.policy_documents(document_type) where mandatory;

create table policy_acceptances (
  id             bigint generated always as identity primary key,
  profile_id     uuid not null references profiles,
  document_type  text not null check (document_type in ('terms','privacy')),
  version        text not null,
  accepted_at    timestamptz not null default now(),
  source         text not null check (source in ('signup','reauth')),
  unique (profile_id, document_type, version),
  foreign key (document_type, version)
    references private.policy_documents(document_type, version)
);

create table privacy_requests (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid references profiles,
  kind          text not null check (kind in ('access','correction','deletion','objection','information')),
  status        text not null default 'open' check (status in ('open','in_progress','resolved','denied')),
  response      text,
  opened_at     timestamptz not null default now(),
  resolved_at   timestamptz
);

create table private.revoked_auth_sessions (
  session_id   uuid primary key,
  profile_id   uuid not null references profiles,
  revoked_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  check (expires_at > revoked_at)
);

create table private.deletion_requests (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null unique references profiles,
  auth_user_id    uuid,
  status          text not null default 'requested' check (status in
                  ('requested','cleaning_storage','deleting_auth','finalizing',
                   'completed','failed_retryable')),
  attempts        int not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  last_error_code text,
  requested_at    timestamptz not null default now(),
  auth_deleted_at timestamptz,
  completed_at    timestamptz,
  check ((status = 'completed' and completed_at is not null and auth_user_id is null)
      or (status <> 'completed' and completed_at is null and auth_user_id is not null))
);

create table private.data_exports (
  id                 uuid primary key default gen_random_uuid(),
  privacy_request_id uuid not null unique references privacy_requests,
  profile_id         uuid not null references profiles,
  status             text not null default 'queued'
                     check (status in ('queued','building','ready','downloaded',
                                       'cleanup_pending','expired','failed')),
  storage_path       text unique,
  content_digest     text,
  ready_at           timestamptz,
  expires_at         timestamptz,
  downloaded_at      timestamptz,
  purged_at          timestamptz,
  created_at         timestamptz not null default now(),
  check ((status in ('queued','building') and storage_path is null and content_digest is null
          and ready_at is null and expires_at is null and downloaded_at is null
          and purged_at is null)
      or (status = 'ready' and storage_path is not null and content_digest is not null
          and ready_at is not null and expires_at is not null and downloaded_at is null
          and purged_at is null)
      or (status = 'downloaded' and ready_at is not null and expires_at is not null
          and downloaded_at is not null
          and ((storage_path is not null and content_digest is not null and purged_at is null)
            or (storage_path is null and content_digest is null and purged_at is not null)))
      or (status = 'cleanup_pending' and storage_path is not null
          and content_digest is not null and ready_at is not null and expires_at is not null
          and purged_at is null)
      or (status in ('expired','failed') and storage_path is null and content_digest is null
          and purged_at is not null)),
  check (expires_at is null or expires_at <= ready_at + interval '24 hours')
);
```

`profiles.position` é preferência exibida no cartão do time. Não entra no sorteio na v1
(`01` §5.7) e não tem relação com a vaga de goleiro do racha, que é
`match_players.list_kind`.

`private.policy_documents` é catálogo técnico, sem texto integral. `content_sha256` guarda
exatamente os 32 bytes do SHA-256 do arquivo publicado. `(document_type, version)` e o digest
são imutáveis; uma troca de versão obrigatória desmarca a anterior e marca a nova na mesma
transação. A aplicação falha fechada se não encontrar **exatamente uma** versão obrigatória de
`terms` e uma de `privacy`. `source` do aceite é derivado no servidor: `signup` no primeiro
aceite daquele tipo e `reauth` nos seguintes. Versão desconhecida, superada ou não obrigatória
é `VALIDATION`.

Versões fictícias existem somente em fixture pgTAP ou seed explicitamente local e nunca são
apresentadas como Termos/Política reais; não há seed canônico `m1-draft-1`. Antes do beta, uma
migration publica as versões efetivas e seus digests, e o build passa a verificar que os
arquivos empacotados produzem os mesmos valores. O catálogo e essa verificação não substituem
o gate jurídico de texto, papéis, bases e prazos.

`delete_account(request_id)` inicia uma **saga**, porque banco, Auth e Storage não compartilham
transação:

1. na transação inicial, bloqueia se a pessoa é parte indispensável de contestação/caso
   financeiro aberto ou dona sem substituto elegível; transfere autoridade quando possível,
   cancela exports pendentes, cria `deletion_requests` e muda o perfil para
   `deletion_pending`;
2. desde esse commit, o helper comum de RLS/RPC nega toda autoridade de domínio ao perfil,
   inclusive com JWT ainda não expirado; somente consulta do pedido/canal de suporte é permitida;
3. o worker, com lease próprio da saga, remove ou transfere todos os objetos Storage cujo
   `owner_id` é do Auth e limpa assinaturas/artefatos pessoais; retry procura o estado externo
   real antes de repetir;
4. chama `auth.admin.deleteUser`. “Usuário não encontrado” após tentativa anterior conta como
   sucesso; erro temporário mantém `failed_retryable`. O ID do Auth permanece somente na tabela
   restrita da saga até essa etapa terminar;
5. `finalize_deletion(request_id)` desidentifica perfil/histórico conforme o mapa, confirma
   `auth_user_id is null`, muda `account_status='deleted'`, grava manifesto e marca
   `completed`. O estado `deletion_pending` permite que o FK `on delete set null` do Auth
   ocorra antes do finalize sem violar a constraint do perfil. Crash depois de
   apagar Auth e antes do finalize é recuperado pelo mesmo pedido, sem recriar identidade.

`revoke_current_session` grava o `session_id` do JWT antes do logout do Auth. Todo helper
privilegiado rejeita sessão presente em `revoked_auth_sessions`; o job apaga a negação depois
do `expires_at` calculado pela vida máxima da sessão. Isso cobre logout seguro, enquanto
`deletion_pending` cobre todas as sessões da conta.

Download de export é one-shot no nível da **tentativa autorizada**: sob row lock e depois de
reauth, a Edge faz compare-and-set `ready→downloaded`, grava `downloaded_at` e commita antes
de abrir o stream. Só uma chamada concorrente conquista a linha; as demais recebem
`EXPORT_EXPIRED`. Queda de rede depois desse ponto consome a tentativa — a UI oferece gerar
novo export, não reabrir o mesmo artefato. Ao terminar ou abortar o stream, a Edge enfileira o
purge; reconciliação também apaga qualquer `downloaded` ainda com path. Somente depois do
delete confirmado no Storage ela nulifica path/digest e grava `purged_at`.

Suspensão/banimento urgente não espera o usuário: sob os locks globais, primeiro transfere cada
caso a outro organizador ativo elegível; sem candidato, cria `financial_cases` com autoridade
`admin_financial`. Só depois revoga sessões. O Admin não vira membro nem ganha leitura geral:
usa apenas projeções/funções do caso, com motivo obrigatório, acesso registrado e notificação.
Claims/uploads do alvo são cancelados; rachas futuros removem a participação e invalidam
publicação atual pela mesma primitiva de remoção, preservando histórico de jogo iniciado.

## 3. Grupos, membros e convites

```sql
create table groups (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  photo_url       text,
  owner_id        uuid not null references profiles,
  monthly_enabled boolean not null default false,
  ratings_visibility text not null default 'private'
                     check (ratings_visibility in ('private','members')),
  suspended_at    timestamptz,
  archived_at     timestamptz,
  created_at      timestamptz not null default now()
);

create table group_members (
  group_id   uuid not null references groups,
  profile_id uuid not null references profiles,
  role       text not null default 'player' check (role in ('organizer','player')),
  status     text not null default 'pending' check (status in ('pending','active','removed')),
  is_monthly boolean not null default false,
  joined_at  timestamptz not null default now(),
  last_requested_at timestamptz not null default now(),
  removed_at timestamptz,
  removal_count int not null default 0 check (removal_count >= 0),
  primary key (group_id, profile_id)
);
-- owner é derivado de groups.owner_id; não existe role='owner'.

create table group_invites (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references groups,
  token_version smallint not null default 1 check (token_version > 0),
  public_nonce bytea not null check (octet_length(public_nonce) = 16),
  token_digest text unique not null,
  created_by   uuid not null references profiles,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  max_uses     int not null default 100 check (max_uses > 0),
  used_count   int not null default 0 check (used_count between 0 and max_uses),
  created_at   timestamptz not null default now()
);
```

- O limite de 100 conta `pending + active`, impedindo flood que ultrapasse capacidade. A
  aprovação trava o `group` e reconta; resgate trava grupo e convite, incrementa com
  `used_count = used_count + 1 where used_count < max_uses` e exige uma linha afetada.
- O limite pessoal de 5 conta memberships `active` em grupos não arquivados, inclusive
  grupo próprio. `create_group` e `approve_member` travam `profiles` e revalidam a contagem; pedido
  pendente não consome cota.
- Resgate de código/link tem rate limit por perfil/IP no gateway e não revela se determinado
  usuário já pertence ao grupo.
- Membership `removed` pode voltar apenas a `pending` por novo resgate válido. A mesma linha
  preserva `joined_at`, incrementa `removal_count`, atualiza `last_requested_at`, zera
  `removed_at`, força `role='player'`/`is_monthly=false` e exige nova aprovação. Não há
  banimento permanente implícito nem reativação direta para `active` na v1.
- Token de link usa bytes `invite_id(16) || token_version(u16 big-endian) || public_nonce(16)
  || HMAC-SHA-256(key_v, "colete/invite/v1\0" || bytes_anteriores)`, em base64url sem padding.
  `public_nonce` não é segredo; o dump sem a chave do cofre não forja token. Rotação incrementa
  versão, gera nonce, recalcula digest e revoga material anterior. Código humano usa alfabeto sem caracteres
  ambíguos, entropia mínima versionada, limite de tentativas e digest com segredo do servidor;
  não é um UUID ou código sequencial exposto.
- URL leva token no fragmento (não enviado em request/referrer); o app troca por POST,
  remove do endereço e nunca o envia a analytics/log. `Referrer-Policy: no-referrer` é
  defesa adicional.
- `transfer_ownership` atualiza somente `groups.owner_id` em transação e exige novo dono ativo.
  No fluxo excepcional, `admin_assign_financial_case` pode promover membro ativo elegível a
  dono; sem candidato, Admin só fecha os casos expressamente atribuídos.
- Constraint trigger diferida exige que `owner_id` tenha membership ativa enquanto o grupo
  não estiver arquivado. Grupo solo arquivado pode apontar historicamente para perfil
  desidentificado/removido, sem conferir autoridade ativa.
- Grupo é arquivado, nunca apagado pela API.

## 4. Recorrência e racha

```sql
create table recurrences (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references groups,
  version          int not null default 1 check (version > 0),
  rule_version     smallint not null default 1 check (rule_version > 0),
  template_version smallint not null default 1 check (template_version > 0),
  rule             jsonb not null,
  template         jsonb not null,
  active           boolean not null default true,
  disabled_at      timestamptz,
  created_by       uuid not null references profiles,
  updated_at       timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (id, group_id),
  check (active = (disabled_at is null))
);

create table recurrence_payment_secrets (
  recurrence_id       uuid primary key references recurrences,
  state               text not null default 'active' check (state in ('active','purged')),
  pix_key_ciphertext  bytea,
  pix_key_last4       text check (length(pix_key_last4) <= 4),
  pix_key_key_version smallint,
  pix_key_type        text check (pix_key_type in ('cpf','cnpj','email','phone','random')),
  pix_receiver_name   text,
  pix_receiver_city   text,
  updated_at          timestamptz not null default now(),
  purged_at           timestamptz,
  check ((state = 'active' and pix_key_ciphertext is not null and pix_key_last4 is not null
          and pix_key_key_version is not null and pix_key_type is not null
          and pix_receiver_name is not null and pix_receiver_city is not null
          and purged_at is null)
      or (state = 'purged' and pix_key_ciphertext is null and pix_receiver_name is null
          and pix_receiver_city is null and purged_at is not null))
);

create table matches (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references groups,
  recurrence_id   uuid references recurrences,
  recurrence_version int,
  occurrence_key  text,            -- data/hora local canônica da ocorrência
  generated_from_match_id uuid unique references matches,

  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  timezone        text not null,
  location_name   text,
  location_address text,

  field_slots     int not null check (field_slots > 0),
  goalkeeper_slots int not null default 0 check (goalkeeper_slots >= 0),
  field_price     numeric(10,2) not null check (field_price > 0),
  goalkeeper_price numeric(10,2) not null default 0 check (goalkeeper_price >= 0),
  priority_opens_at timestamptz not null, -- TP
  general_opens_at  timestamptz not null, -- T0
  payment_due_at    timestamptz not null, -- T1
  closes_at         timestamptz not null, -- T2
  promoted_payment_minutes int not null default 30 check (promoted_payment_minutes > 0),
  open_claim_minutes int not null default 10 check (open_claim_minutes > 0),

  phase           text not null default 'scheduled'
                  check (phase in ('scheduled','open','closed','teams_published','done','canceled')),
  payment_deadline_applied_at timestamptz,
  price_locked_at timestamptz,
  pix_locked_at   timestamptz,       -- T0
  revision        bigint not null default 0,
  canceled_at     timestamptz,
  canceled_by     uuid references profiles,
  cancellation_reason_code text check (cancellation_reason_code in
                           ('organizer_decision','venue_unavailable','weather','other')),
  cancellation_note text check (length(cancellation_note) <= 500),
  created_by      uuid not null references profiles,
  created_at      timestamptz not null default now(),

  unique (recurrence_id, occurrence_key),
  unique (id, group_id),
  foreign key (recurrence_id, group_id) references recurrences(id, group_id),
  check ((recurrence_id is null) = (occurrence_key is null)
      and (recurrence_id is null) = (recurrence_version is null)),
  check (starts_at < ends_at),
  check (priority_opens_at <= general_opens_at),
  check (general_opens_at < payment_due_at),
  check (payment_due_at < closes_at),
  check (closes_at < starts_at),
  check ((phase = 'canceled' and canceled_at is not null and canceled_by is not null
          and cancellation_reason_code is not null)
      or (phase <> 'canceled' and canceled_at is null and canceled_by is null
          and cancellation_reason_code is null and cancellation_note is null))
);

create table match_payment_secrets (
  match_id             uuid primary key references matches,
  state                text not null default 'active' check (state in ('active','purged')),
  pix_key_ciphertext   bytea,
  pix_key_last4        text check (length(pix_key_last4) <= 4),
  pix_key_key_version  smallint,
  pix_key_type         text check (pix_key_type in ('cpf','cnpj','email','phone','random')),
  pix_receiver_name    text,
  pix_receiver_city    text,
  purged_at            timestamptz,
  check ((state = 'active' and pix_key_ciphertext is not null and pix_key_last4 is not null
          and pix_key_key_version is not null and pix_key_type is not null
          and pix_receiver_name is not null and pix_receiver_city is not null
          and purged_at is null)
      or (state = 'purged' and pix_key_ciphertext is null and pix_receiver_name is null
          and pix_receiver_city is null and purged_at is not null))
);

create table match_invites (
  id           uuid primary key default gen_random_uuid(),
  match_id     uuid not null references matches,
  token_version smallint not null default 1 check (token_version > 0),
  public_nonce bytea not null check (octet_length(public_nonce) = 16),
  token_digest text unique not null,
  created_by   uuid not null references profiles,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  max_uses     int not null default 1 check (max_uses > 0),
  used_count   int not null default 0 check (used_count between 0 and max_uses),
  created_at   timestamptz not null default now()
);
```

Convite de racha usa o mesmo encoding autenticado de convite de grupo, trocando o domínio
por `colete/match-invite/v1`. Tanto grupo quanto racha são recompartilháveis por projeção
autorizada sem armazenar token secreto.

`occurrence_key` é `local_datetime|timezone|offset_policy`, determinística. Horário local
inexistente é rejeitado; ambíguo exige política de offset armazenada em `rule`.
`update_recurrence`/`set_recurrence_active` são somente de dono/organizador ativo, travam
grupo→recorrência e incrementam `version` quando a configuração muda; regra/template/Pix
novos afetam somente ocorrência ainda não materializada.
`advance_recurrence` trava grupo→recorrência→racha terminal, revalida `active`, versão e
`recurrence_payment_secrets.state='active'`, busca a primeira ocorrência depois de
`greatest(terminal_match.starts_at, now())`, copia snapshot/configuração Pix para o novo
racha e insere com `on conflict do nothing`. Desligar a série trava os mesmos pais e cancela
na mesma transação a única ocorrência futura gerada ainda sem participante/ciclo; se já houver
efeito, exige confirmação de cancelamento. Assim a corrida desligar×avançar termina sem próximo
racha ativo inesperado.

## 5. Inscrição, fila, reserva e ciclo financeiro

```sql
create sequence match_queue_seq;

create table match_players (
  id               uuid primary key default gen_random_uuid(),
  match_id         uuid not null references matches,
  profile_id       uuid not null references profiles,
  list_kind        text not null check (list_kind in ('field','goalkeeper')),
  status           text not null check (status in ('starter','waitlist','left','removed')),
  current_payment_cycle_id uuid, -- FK composta adicionada depois de payment_cycles
  is_guest         boolean not null default false,
  added_by         uuid references profiles,
  joined_at        timestamptz not null default now(),
  waitlisted_at    timestamptz,
  queue_tier       smallint,
  queue_seq        bigint,
  left_at          timestamptz,
  unique (match_id, profile_id),
  unique (id, match_id),
  check ((status = 'waitlist') = (queue_tier is not null and queue_seq is not null))
);

create unique index one_active_queue_position
  on match_players(match_id, list_kind, queue_seq) where status = 'waitlist';

create table slot_claims (
  id              uuid primary key default gen_random_uuid(),
  match_player_id uuid not null references match_players,
  kind            text not null check (kind in ('promotion','open_slot','manual')),
  status          text not null default 'active'
                  check (status in ('active','completed','expired','canceled')),
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create unique index one_active_claim_per_player
  on slot_claims(match_player_id) where status = 'active';

create table payment_cycles (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references groups,
  match_player_id uuid not null references match_players,
  match_id         uuid not null references matches,
  charge_version  int not null check (charge_version > 0),
  amount           numeric(10,2) not null check (amount >= 0),
  status           text not null check (status in
                  ('exempt','presumed','pending','under_review','accepted',
                   'refund_due','refunded','canceled')),
  opened_at        timestamptz not null default now(),
  accepted_at      timestamptz,
  closed_at        timestamptz,
  unique (match_player_id, charge_version),
  unique (id, match_player_id),
  unique (id, group_id, match_id),
  foreign key (match_player_id, match_id) references match_players(id, match_id),
  foreign key (match_id, group_id) references matches(id, group_id),
  check ((status = 'accepted') = (accepted_at is not null and closed_at is null)
      or status <> 'accepted'),
  check ((status in ('refunded','canceled')) = (closed_at is not null))
);

alter table match_players add constraint current_cycle_belongs_to_player
  foreign key (current_payment_cycle_id, id)
  references payment_cycles(id, match_player_id);
```

`payment_cycles` é a autoridade. O rótulo público antigo é projeção: `accepted` vira
`approved` ou `marked_paid` conforme a resolução; não existe coluna paralela de status para
divergir. Uma nova versão de preço só nasce depois de o ciclo anterior estar `refunded` ou
`canceled`, recebe `charge_version + 1` e passa a ser o ponteiro atual; fatos antigos nunca
são reescritos.

Ordem da espera: `(queue_tier asc, queue_seq asc)`. Tier normal = 100; análise expirada =
10. Ir ao fim sempre chama `nextval('match_queue_seq')`; `joined_at` nunca é reescrito.
Capacidade conta todo `starter`, inclusive claim ativa e ciclo `under_review`; cada mutação
sob lock do racha prova `starter_count <= slots`.

## 6. Upload, resolução, ledger e contestação financeira

```sql
create table proof_upload_sessions (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references groups,
  match_id        uuid not null references matches,
  payment_cycle_id uuid not null,
  storage_path    text unique,
  status          text not null default 'created'
                  check (status in ('created','finalized','cleanup_pending','expired','purged')),
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  finalized_at    timestamptz,
  cleaned_at      timestamptz,
  unique (id, payment_cycle_id, group_id, match_id),
  foreign key (payment_cycle_id, group_id, match_id)
    references payment_cycles(id, group_id, match_id),
  check ((status = 'created' and storage_path is not null and finalized_at is null and cleaned_at is null)
      or (status = 'finalized' and storage_path is not null and finalized_at is not null and cleaned_at is null)
      or (status = 'cleanup_pending' and storage_path is not null and finalized_at is null and cleaned_at is null)
      or (status = 'expired' and storage_path is null and finalized_at is null and cleaned_at is not null)
      or (status = 'purged' and storage_path is null and finalized_at is not null and cleaned_at is not null))
);

create table payment_proofs (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references groups,
  match_id        uuid not null references matches,
  payment_cycle_id uuid not null,
  upload_session_id uuid unique not null,
  storage_path    text,
  file_fingerprint text,
  fingerprint_key_version smallint,
  uploaded_at     timestamptz not null default now(),
  review_expires_at timestamptz not null,
  review_expired_at timestamptz,
  decided_by      uuid references profiles,
  decided_at      timestamptz,
  decision        text check (decision in ('approved','rejected','resolved_elsewhere')),
  decision_reason text check (length(decision_reason) <= 500),
  purge_after     timestamptz not null,
  binary_purged_at timestamptz,
  unique (id, payment_cycle_id, group_id, match_id),
  foreign key (payment_cycle_id, group_id, match_id)
    references payment_cycles(id, group_id, match_id),
  foreign key (upload_session_id, payment_cycle_id, group_id, match_id)
    references proof_upload_sessions(id, payment_cycle_id, group_id, match_id),
  check ((decision is null and decided_at is null and decided_by is null)
      or (decision is not null and decided_at is not null and decided_by is not null)),
  check ((binary_purged_at is null and storage_path is not null
          and file_fingerprint is not null and fingerprint_key_version is not null)
      or (binary_purged_at is not null and storage_path is null
          and file_fingerprint is null and fingerprint_key_version is null))
);
create unique index one_undecided_proof_per_cycle
  on payment_proofs(payment_cycle_id) where decision is null;
create index proof_fingerprint_signal
  on payment_proofs(group_id, file_fingerprint) where file_fingerprint is not null;

create table payment_resolutions (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references groups,
  match_id         uuid not null references matches,
  payment_cycle_id uuid not null unique,
  kind             text not null check (kind in ('proof_approved','marked_paid')),
  proof_id         uuid unique references payment_proofs,
  amount           numeric(10,2) not null check (amount >= 0),
  accepted_by      uuid not null references profiles,
  accepted_at      timestamptz not null default now(),
  unique (id, payment_cycle_id, group_id, match_id),
  foreign key (payment_cycle_id, group_id, match_id)
    references payment_cycles(id, group_id, match_id),
  foreign key (proof_id, payment_cycle_id, group_id, match_id)
    references payment_proofs(id, payment_cycle_id, group_id, match_id),
  check ((kind = 'proof_approved') = (proof_id is not null))
);

create table payment_events (
  id               bigint generated always as identity primary key,
  group_id         uuid not null references groups,
  match_id         uuid not null references matches,
  payment_cycle_id uuid not null,
  resolution_id    uuid references payment_resolutions,
  proof_id         uuid references payment_proofs,
  related_event_id bigint references payment_events,
  kind             text not null check (kind in
                   ('cycle_opened','proof_submitted','proof_rejected','proof_resolved_elsewhere',
                    'resolution_accepted','refund_due','refunded','proof_withdrawn','proof_purged')),
  amount           numeric(10,2) not null check (amount >= 0),
  actor_id         uuid references profiles,
  reason_code      text,
  occurred_at      timestamptz not null default now(),
  external_reference text check (length(external_reference) <= 120),
  created_at       timestamptz not null default now()
  ,unique (id, payment_cycle_id, group_id, match_id)
  ,foreign key (payment_cycle_id, group_id, match_id)
    references payment_cycles(id, group_id, match_id)
  ,foreign key (resolution_id, payment_cycle_id, group_id, match_id)
    references payment_resolutions(id, payment_cycle_id, group_id, match_id)
  ,foreign key (proof_id, payment_cycle_id, group_id, match_id)
    references payment_proofs(id, payment_cycle_id, group_id, match_id)
  ,foreign key (related_event_id, payment_cycle_id, group_id, match_id)
    references payment_events(id, payment_cycle_id, group_id, match_id)
  ,check ((kind = 'resolution_accepted') = (resolution_id is not null and proof_id is null)
       or kind <> 'resolution_accepted')
  ,check (kind <> 'refund_due' or resolution_id is not null)
  ,check (kind not in ('proof_submitted','proof_rejected','proof_resolved_elsewhere',
                       'proof_withdrawn','proof_purged') or proof_id is not null)
  ,check ((kind = 'refunded') = (related_event_id is not null))
);
create unique index one_resolution_event
  on payment_events(resolution_id) where kind = 'resolution_accepted';
create unique index one_refund_due_per_resolution
  on payment_events(resolution_id) where kind = 'refund_due';
create unique index one_refunded_per_obligation
  on payment_events(related_event_id) where kind = 'refunded';

create table financial_disputes (
  id                 uuid primary key default gen_random_uuid(),
  group_id           uuid not null references groups,
  match_id           uuid not null references matches,
  payment_cycle_id   uuid not null,
  contested_event_id bigint not null,
  opened_by          uuid not null references profiles,
  status             text not null default 'open'
                     check (status in ('open','responded','resolved_first_instance',
                                       'appealed','escalated','resolved_final')),
  reason             text not null check (length(reason) between 1 and 500),
  response            text check (length(response) <= 1000),
  first_resolution    text check (first_resolution in ('upheld','rejected','corrected')),
  first_resolved_by   uuid references profiles,
  final_resolution    text check (final_resolution in ('upheld','rejected','corrected')),
  final_resolved_by   uuid references profiles,
  opened_at           timestamptz not null default now(),
  responded_at        timestamptz,
  sla_due_at          timestamptz not null default (now() + interval '7 days'),
  first_resolved_at   timestamptz,
  appeal_deadline     timestamptz,
  final_resolved_at   timestamptz,
  unique (id, payment_cycle_id, group_id, match_id),
  unique (id, opened_by, payment_cycle_id, group_id, match_id),
  foreign key (payment_cycle_id, group_id, match_id)
    references payment_cycles(id, group_id, match_id),
  foreign key (contested_event_id, payment_cycle_id, group_id, match_id)
    references payment_events(id, payment_cycle_id, group_id, match_id),
  check ((status = 'open' and responded_at is null)
      or (status in ('responded','resolved_first_instance','appealed')
          and responded_at is not null)
      or status in ('escalated','resolved_final')),
  check ((status in ('resolved_first_instance','appealed') and first_resolution is not null
          and first_resolved_by is not null and first_resolved_at is not null
          and appeal_deadline = first_resolved_at + interval '7 days')
      or status not in ('resolved_first_instance','appealed')),
  check ((status = 'resolved_final') = (final_resolution is not null
          and final_resolved_by is not null and final_resolved_at is not null))
);
create unique index one_open_dispute_per_event
  on financial_disputes(payment_cycle_id, contested_event_id)
  where status in ('open','responded','resolved_first_instance','appealed','escalated');

create table financial_appeals (
  id               uuid primary key default gen_random_uuid(),
  dispute_id       uuid not null unique,
  group_id         uuid not null references groups,
  match_id         uuid not null references matches,
  payment_cycle_id uuid not null,
  opened_by        uuid not null references profiles,
  reason           text not null check (length(reason) between 1 and 500),
  status           text not null default 'pending' check (status in ('pending','resolved')),
  opened_at        timestamptz not null default now(),
  resolved_at      timestamptz,
  unique (id, dispute_id, payment_cycle_id, group_id, match_id),
  foreign key (dispute_id, opened_by, payment_cycle_id, group_id, match_id)
    references financial_disputes(id, opened_by, payment_cycle_id, group_id, match_id),
  check ((status = 'resolved') = (resolved_at is not null))
);

create table financial_dispute_events (
  id          bigint generated always as identity primary key,
  dispute_id  uuid not null,
  group_id    uuid not null references groups,
  match_id    uuid not null references matches,
  payment_cycle_id uuid not null,
  kind        text not null check (kind in ('opened','responded','first_instance_resolved',
                                            'appealed','appeal_waived','escalated',
                                            'final_resolved','corrected')),
  actor_id    uuid references profiles,
  from_status text check (from_status in ('open','responded','resolved_first_instance',
                                          'appealed','escalated','resolved_final')),
  to_status   text not null check (to_status in ('open','responded','resolved_first_instance',
                                                 'appealed','escalated','resolved_final')),
  resolution  text check (resolution in ('upheld','rejected','corrected')),
  reason_code text,
  created_at  timestamptz not null default now(),
  unique (id, dispute_id, payment_cycle_id, group_id, match_id),
  foreign key (dispute_id, payment_cycle_id, group_id, match_id)
    references financial_disputes(id, payment_cycle_id, group_id, match_id)
);

create table financial_cases (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references groups,
  match_id         uuid not null references matches,
  payment_cycle_id uuid not null references payment_cycles,
  dispute_id       uuid,
  appeal_id        uuid,
  kind             text not null check (kind in ('proof_review','refund','dispute','dispute_appeal')),
  status           text not null default 'open' check (status in ('open','assigned','resolved')),
  authority        text not null check (authority in ('group_organizer','admin_financial')),
  assigned_profile_id uuid references profiles,
  opened_at        timestamptz not null default now(),
  assigned_at      timestamptz,
  resolved_at      timestamptz,
  foreign key (payment_cycle_id, group_id, match_id)
    references payment_cycles(id, group_id, match_id),
  foreign key (dispute_id, payment_cycle_id, group_id, match_id)
    references financial_disputes(id, payment_cycle_id, group_id, match_id),
  foreign key (appeal_id, dispute_id, payment_cycle_id, group_id, match_id)
    references financial_appeals(id, dispute_id, payment_cycle_id, group_id, match_id),
  check ((kind = 'dispute_appeal') = (appeal_id is not null)),
  check ((kind in ('dispute','dispute_appeal')) = (dispute_id is not null)),
  check ((status = 'open' and assigned_profile_id is null and assigned_at is null and resolved_at is null)
      or (status = 'assigned' and assigned_profile_id is not null and assigned_at is not null and resolved_at is null)
      or (status = 'resolved' and assigned_profile_id is not null and assigned_at is not null and resolved_at is not null))
);
create unique index one_open_financial_case
  on financial_cases(payment_cycle_id, kind)
  where status in ('open','assigned');
```

`group_id`/`match_id` de cada filho são copiados do ciclo dentro da RPC e não são editáveis.
Toda FK composta é testada com combinações cruzadas de dois grupos, dois rachas e dois ciclos;
inserts por `service_role` também precisam falhar.

Constraint triggers diferidos comprovam no commit: ciclo `under_review` tem exatamente uma
prova indecidida; ciclo `accepted|refund_due|refunded` tem exatamente uma resolução; decisão
`approved` aponta para essa resolução; `refund_due` referencia evento
`resolution_accepted`; `refunded` referencia `refund_due`; estados `exempt|presumed` nunca
recebem resolução real. Escrita direta é revogada, mas os triggers também protegem erro de
função/migration.
Outro trigger diferido valida a máquina da disputa: primeira decisão só sai de `responded`,
`appealed` exige a única `financial_appeals` do próprio `opened_by`, `escalated` exige SLA/
ausência, `resolved_final` exige evento final e resolve appeal/case quando existentes. Update/
delete direto de eventos, apelações e fatos financeiros é revogado.

- O cliente nunca recebe signed download/upload URL, token de Storage ou `storage_path`.
  `PUT /proof-upload-sessions/:id/content` e `GET /proofs/:id/content` são endpoints Edge
  autenticados. Eles resolvem o caminho apenas no servidor e revalidam perfil/sessão/ciclo/
  claim/caso em cada chamada. Download faz streaming, não redirect, com
  `Cache-Control: private, no-store, max-age=0`, `Pragma: no-cache` e sem CDN compartilhado.
  Revogar membership/caso corta a próxima leitura; bytes já baixados no dispositivo não são
  tecnicamente revogáveis e essa limitação aparece na transparência.
- Na finalização, SHA-256 bruto existe apenas na memória. O banco recebe
  `HMAC-SHA-256(chave_v, "colete/proof-fingerprint/v1" || group_id_bytes || sha256_bytes)`.
  Mesmo arquivo no mesmo grupo coincide; em grupos distintos diverge. Dump não permite
  testar arquivos sem a chave do cofre; RPC nunca retorna o fingerprint, só booleano.
- `decide_proof`, `mark_paid` e `record_canceled_match_payment` travam ciclo antes da prova.
  O primeiro cria a única `payment_resolutions`; se `mark_paid` vencer, a prova pendente vira
  `resolved_elsewhere` atomicamente. Unique constraints fazem o perdedor retornar
  `PAYMENT_ALREADY_RESOLVED`, sem dois pagamentos aceitos.
- `refund_due` aponta para a resolução; `refunded` aponta para a obrigação. Valor e ciclo
  são revalidados, impedindo duplicação ou estorno maior. `occurred_at` é declaração humana,
  não confirmação bancária.
- Somente a pessoa afetada abre contestação de evento aceito/estorno. Organizador elegível
  responde e pode registrar decisão de primeira instância. O autor pode aceitar/renunciar ou
  apelar **uma vez** em até sete dias; a unique de `financial_appeals.dispute_id` fixa a
  cardinalidade. Apelação ou SLA vencido abre caso Admin, cuja decisão é final. O job só muda
  `resolved_first_instance→resolved_final` sem Admin depois do prazo se não houver apelação.
  Autoridades não atualizam/apagam a trilha append-only.
- Contestação `open|responded|resolved_first_instance|appealed|escalated` bloqueia
  `unlock_price_after_refunds`; durante `resolved_first_instance`, bloqueia até renúncia ou
  `appeal_deadline`. Suspenso mantém canal
  autenticado mínimo ou suporte verificado para abrir/acompanhar; Admin usa projeção limitada
  ao caso. Motivos privados nunca entram na trilha pública.
- `correct_refund` apenas corrige horário/referência de evento de estorno existente, com
  razão obrigatória e novo evento `corrected`; não cria pagamento, não apaga ledger e não
  troca beneficiário. Mudança de estado usa as funções financeiras específicas.
- Binário/fingerprint é apagado no prazo canônico de sete dias mesmo com disputa; ledger e
  texto limitado da disputa seguem `17-mapa-dados-lgpd.md`.

Organizador financeiro **elegível** é perfil `active`, membership `active`, papel
`organizer` ou dono, no mesmo grupo, sem ser a pessoa cuja autoridade foi revogada nem a parte
adversa daquele caso. A seleção automática é determinística: dono elegível; senão menor
`(joined_at, profile_id_bytes)`. Um constraint trigger diferido revalida essa condição no commit
de `financial_cases` com `authority='group_organizer'`; sem candidato, a autoridade é
`admin_financial`. Atribuição nunca concede membership.

## 7. Notas e snapshots privados

```sql
create table ratings (
  group_id    uuid not null references groups,
  profile_id  uuid not null references profiles,
  current_history_id bigint not null,
  stars       int not null check (stars between 1 and 5),
  updated_by  uuid not null references profiles,
  updated_at  timestamptz not null default now(),
  primary key (group_id, profile_id)
);

create table rating_history (
  id          bigint generated always as identity primary key,
  group_id    uuid not null references groups,
  profile_id  uuid not null references profiles,
  old_stars   int check (old_stars between 1 and 5),
  new_stars   int not null check (new_stars between 1 and 5),
  changed_by  uuid not null references profiles,
  changed_at  timestamptz not null default now(),
  unique (id, group_id, profile_id)
);

alter table ratings add constraint current_rating_history_belongs_to_rating
  foreign key (current_history_id, group_id, profile_id)
  references rating_history(id, group_id, profile_id)
  deferrable initially deferred;

create table rating_disputes (
  id                uuid primary key default gen_random_uuid(),
  group_id          uuid not null references groups,
  profile_id        uuid not null references profiles,
  rating_history_id bigint not null,
  opened_by         uuid not null references profiles,
  status            text not null default 'open'
                    check (status in ('open','responded','escalated','resolved')),
  reason            text not null check (length(reason) between 1 and 500),
  response          text check (length(response) <= 1000),
  resolution        text check (resolution in ('upheld','corrected','deleted')),
  corrected_rating_history_id bigint,
  resolved_by       uuid references profiles,
  opened_at         timestamptz not null default now(),
  responded_at      timestamptz,
  sla_due_at        timestamptz not null default (now() + interval '7 days'),
  resolved_at       timestamptz,
  foreign key (rating_history_id, group_id, profile_id)
    references rating_history(id, group_id, profile_id),
  foreign key (corrected_rating_history_id, group_id, profile_id)
    references rating_history(id, group_id, profile_id),
  check (opened_by = profile_id),
  check ((status = 'resolved') = (resolution is not null and resolved_by is not null
                                   and resolved_at is not null)),
  check ((resolution = 'corrected') = (corrected_rating_history_id is not null)),
  check (corrected_rating_history_id is null
         or corrected_rating_history_id <> rating_history_id)
);
create unique index one_open_rating_dispute_per_version
  on rating_disputes(rating_history_id)
  where status in ('open','responded','escalated');

create table rating_dispute_events (
  id          bigint generated always as identity primary key,
  dispute_id  uuid not null references rating_disputes,
  kind        text not null check (kind in ('opened','responded','escalated','resolved')),
  actor_id    uuid references profiles,
  from_status text,
  to_status   text not null,
  created_at  timestamptz not null default now()
);

create table draws (
  id                uuid primary key default gen_random_uuid(),
  match_id          uuid not null references matches,
  match_revision    bigint not null,
  algorithm_version text not null,
  prng              text not null,
  team_count        int not null check (team_count >= 2),
  exact             boolean not null,
  canonical_key     text not null,
  run_by            uuid not null references profiles,
  created_at        timestamptz not null default now(),
  unique (id, match_id)
);

create table draw_private_artifacts (
  draw_id           uuid primary key references draws,
  input             jsonb not null,
  seed_hex          text not null check (length(seed_hex) = 64),
  input_hmac        text not null,
  hmac_key_version  smallint not null,
  score             jsonb not null,
  evaluation_count  int not null check (evaluation_count >= 0),
  private_result    jsonb not null,
  purge_after       timestamptz not null
);

create table team_publications (
  id             uuid primary key default gen_random_uuid(),
  match_id       uuid not null references matches,
  draw_id        uuid not null,
  match_revision bigint not null,
  published_by   uuid not null references profiles,
  published_at   timestamptz not null default now(),
  unique (match_id, draw_id),
  unique (id, match_id),
  foreign key (draw_id, match_id) references draws(id, match_id)
);

create table teams (
  id             uuid primary key default gen_random_uuid(),
  publication_id uuid not null references team_publications,
  team_number    int not null,
  unique (publication_id, team_number),
  unique (id, publication_id)
);

create table team_members (
  team_id        uuid not null references teams,
  publication_id uuid not null references team_publications,
  profile_id     uuid not null references profiles,
  primary key (team_id, profile_id),
  unique (publication_id, profile_id),
  foreign key (team_id, publication_id) references teams(id, publication_id)
);

create table team_rating_snapshots (
  publication_id uuid not null references team_publications,
  profile_id     uuid not null references profiles,
  stars          int not null check (stars between 1 and 5),
  purge_after    timestamptz not null,
  primary key (publication_id, profile_id)
);

alter table matches add column current_publication_id uuid;
alter table matches add constraint current_publication_belongs_to_match
  foreign key (current_publication_id, id) references team_publications(id, match_id);
```

Um constraint trigger diferido mantém `ratings.stars` igual ao `new_stars` apontado por
`current_history_id` e valida a máquina `open→responded→resolved` ou
`open|responded→escalated→resolved`. Resolver como `corrected` insere a nova versão e troca o
ponteiro na mesma transação; `deleted` só é aceito se a versão contestada ainda for a atual.
Assim saída/purge concorrente não troca o alvo nem corrige uma avaliação diferente. Eventos de
disputa são append-only e cada transição válida produz exatamente um.

Cada publicação é imutável; republicar cria outra `team_publications` e atualiza
`matches.current_publication_id` na mesma transação. Participantes consultam
`published_team_members`, view `security_invoker` limitada à publicação atual, que retorna
time, perfil público e posição. `draw_private_artifacts`, publicações históricas e
`team_rating_snapshots` são legíveis apenas pelo servidor/organizador autorizado. Após
12 meses, o job apaga artefato e snapshots; `team_members` preserva a composição sem estrelas.

Remover participante antes do início, depois de publicar, nunca edita essas linhas:
sob o lock do racha, nulifica `current_publication_id`, muda a fase para `closed`, incrementa
`revision` e grava `publication_invalidated`. A publicação anterior permanece privada como
histórico técnico; a projeção pública fica sem escalação atual até novo draw/publicação.

## 8. Auditoria pública e administrativa

```sql
create table audit_log (
  id         bigint generated always as identity primary key,
  match_id   uuid not null references matches,
  event      text not null check (event in
             ('draw_run','manual_move','manual_add','manual_remove','rating_changed_matchday',
              'republished','publication_invalidated','list_frozen','payment_decided','refund_status_changed',
              'financial_dispute_changed','admin_financial_intervention',
              'pix_config_locked','match_reconciled','match_canceled')),
  subject_id uuid references profiles,
  public_payload jsonb not null,
  actor_id   uuid references profiles,
  created_at timestamptz not null default now()
);
create unique index one_match_canceled_audit
  on audit_log(match_id) where event = 'match_canceled';

create table group_audit_log (
  id             bigint generated always as identity primary key,
  group_id       uuid not null references groups,
  event          text not null check (event in
                 ('member_approved','member_removed','role_changed','monthly_changed',
                  'ratings_visibility_changed','ownership_transferred','group_archived',
                  'invite_revoked')),
  subject_id     uuid references profiles,
  related_subject_id uuid references profiles,
  public_payload jsonb not null, -- schema por evento; sem nota, token ou motivo privado
  actor_id       uuid references profiles,
  created_at     timestamptz not null default now()
);

create table admin_audit_log (
  id          bigint generated always as identity primary key,
  action      text not null check (action in
              ('transfer_ownership','suspend_group','restore_group','suspend_profile',
               'ban_profile','restore_profile','assign_financial_case','access_case_evidence',
               'decide_financial_case','resolve_dispute','correct_refund','force_deidentify')),
  target_type text not null,
  target_id   uuid not null,
  reason      text not null,
  actor_id    uuid not null references profiles,
  created_at  timestamptz not null default now()
);
```

`REVOKE UPDATE, DELETE` nas três trilhas, inclusive de papéis internos comuns. Somente o papel
técnico de retenção recebe função fechada para nulificar links vencidos; ele não recebe SQL
arbitrário nem pode alterar evento/payload. Inserção ocorre apenas dentro das funções
autorizadas; grupo/racha não é apagado, portanto FK não apaga a trilha em cascata.
A pessoa afetada vê eventos financeiros/administrativos referentes a ela; comprovante, nota,
motivos e referência continuam privados. A rotina exclusiva de retenção pode somente remover
links identificadores vencidos, registrando a redação; não altera evento/payload.

### 8.1 Schemas dos payloads públicos

`validate_public_audit_payload(scope,event,payload)` é chamado por trigger antes do insert.
Ele rejeita objeto acima de 1 KiB, chave desconhecida, tipo/enum fora da tabela e valor extra.
Funções constroem o JSON; `public_payload`, `actor_id` e `subject_id` nunca vêm do cliente.
IDs pessoais ficam nas colunas tipadas, sujeitas a RLS/desidentificação, não dentro do JSON.

| Escopo / evento | Payload exato (`!` = obrigatório) | Tipo, enum e limite |
|---|---|---|
| match `draw_run` | `draw_ref!`, `algorithm_version!`, `team_count!`, `sizes!`, `run_number!` | `draw_ref` UUID; versão string ≤ 20; inteiros; `sizes` int[2..10] |
| match `manual_move` | `from_team!`, `to_team!` | inteiros 1..10, diferentes; `subject_id` obrigatório; representa diferença entre proposta e draft final, não mutação intermediária |
| match `manual_add` / `manual_remove` | `list_kind!` | `field\|goalkeeper`; `subject_id` obrigatório |
| match `rating_changed_matchday` | `{}` | vazio; `subject_id` obrigatório; estrelas proibidas |
| match `republished` | `publication_ref!`, `ordinal!` | UUID; inteiro 2..100 |
| match `publication_invalidated` | `reason_code!` | `participant_left\|participant_removed\|rating_changed`; `subject_id` condicional ao participante |
| match `list_frozen` | `reason_code!` | `draw_committed\|t2` |
| match `payment_decided` | `outcome!` | `proof_approved\|proof_rejected\|marked_paid`; `subject_id` obrigatório |
| match `refund_status_changed` | `status!` | `refund_due\|refunded\|corrected`; `subject_id` obrigatório |
| match `financial_dispute_changed` | `status!` | `opened\|responded\|resolved_first_instance\|appealed\|escalated\|resolved_final`; `subject_id` obrigatório |
| match `admin_financial_intervention` | `action!` | `assigned\|proof_decided\|refund_corrected\|dispute_resolved`; `subject_id` obrigatório |
| match `pix_config_locked` | `{}` | vazio |
| match `match_reconciled` | `source!`, `transitions!` | `cron\|app\|organizer`; array ≤ 8 de `tp\|t0\|t1\|claim\|review\|t2\|start\|done` |
| match `match_canceled` | `reason_code!` | `organizer_decision\|venue_unavailable\|weather\|other`; nota livre nunca entra no payload |
| group `member_approved` / `member_removed` | `{}` | vazio; `subject_id` obrigatório |
| group `role_changed` | `new_role!` | `organizer\|player`; `subject_id` obrigatório |
| group `monthly_changed` | `enabled!` | boolean; `subject_id` obrigatório |
| group `ratings_visibility_changed` | `visibility!` | `private\|members` |
| group `ownership_transferred` | `{}` | vazio; `subject_id` é novo dono e `related_subject_id` o anterior |
| group `group_archived` | `{}` | vazio |
| group `invite_revoked` | `invite_kind!` | `code\|link` |

Além das regras por linha, as chaves `stars`, `rating`, `pix`, `key`, `proof`, `path`,
`fingerprint`, `token`, `reason`, `email`, `phone`, `cpf`, `cnpj` e `address` são proibidas
em qualquer nível. Evento ou chave nova falha com `AUDIT_PAYLOAD_INVALID` até este contrato
ser versionado. Para **cada evento**, testes negativos removem obrigatório, adicionam chave
extra, trocam tipo/enum e excedem tamanho; a suíte também tenta cada campo proibido, payload
aninhado e JSON fornecido pelo cliente.

## 9. Idempotência, notificações e operação temporal

Conforme `14` §5.2, tabelas de serviço que nenhum papel cliente lê ficam em `private`, sem
grants e sem RLS. Por isso os nomes abaixo são qualificados: a ausência de `usage` no schema
e de grants protege essas tabelas sem introduzir uma checagem negativa que possa falhar
aberta sob RLS.

```sql
create table private.idempotency_records (
  actor_key     text not null, -- servidor: profile:<uuid>, bootstrap:<sha256> ou system:<job>
  actor_id      uuid references profiles,
  operation     text not null,
  request_id    uuid not null,
  request_hash  text not null,
  canonical_version smallint not null check (canonical_version = 1),
  hash_key_version smallint not null,
  state         text not null check (state in
                ('executing_uncommitted','completed','payload_expired')),
  outcome_code  text,
  resource_type text,
  resource_id   uuid,
  outcome       jsonb,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  outcome_expires_at timestamptz not null default (now() + interval '30 days'),
  record_expires_at   timestamptz not null default (now() + interval '24 months'),
  payload_expired_at  timestamptz,
  primary key (actor_key, operation, request_id),
  check ((state = 'executing_uncommitted' and outcome is null and completed_at is null
          and payload_expired_at is null)
      or (state = 'completed' and outcome is not null and completed_at is not null
          and payload_expired_at is null)
      or (state = 'payload_expired' and outcome is null and completed_at is not null
          and payload_expired_at is not null)),
  check (outcome_expires_at < record_expires_at),
  check ((operation <> 'complete_profile'
          and actor_id is not null and actor_key = ('profile:' || actor_id::text))
      or (operation = 'complete_profile'
          and actor_key ~ '^bootstrap:[0-9a-f]{64}$'
          and (state = 'executing_uncommitted' or actor_id is not null))
      or (operation <> 'complete_profile'
          and actor_id is null and actor_key like 'system:%'))
);

create table private.external_effects (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in
                 ('delete_auth_user','delete_storage_object','build_data_export',
                  'delete_data_export','purge_proof_object')),
  resource_type  text not null,
  resource_id    uuid not null,
  dedupe_key     text not null unique,
  status         text not null default 'pending'
                 check (status in ('pending','leased','succeeded','failed_retryable','dead')),
  attempts       int not null default 0 check (attempts >= 0),
  lease_until    timestamptz,
  next_attempt_at timestamptz,
  last_error_code text,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);

create table notification_types (
  type       text primary key,
  category   text not null,
  required   boolean not null,
  channels   text[] not null check (cardinality(channels) > 0
                    and channels <@ array['inapp','webpush','expo','email']::text[])
);

create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles,
  kind        text not null check (kind in ('webpush','expo')),
  endpoint_digest text not null,
  payload     jsonb not null,
  disabled_at timestamptz,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (kind, endpoint_digest)
);

create table notification_prefs (
  profile_id uuid not null references profiles,
  type       text not null references notification_types,
  external_enabled boolean not null default true,
  primary key (profile_id, type)
);
-- trigger rejeita external_enabled=false quando notification_types.required=true.
-- ausência de linha significa external_enabled=true; seeds N5–N11, N14, N15, N17, N18, N20,
-- N22–N28 como required. A preferência controla push/e-mail; o fato in-app sempre existe.
-- N13 usa um único boolean para as duas entregas externas.

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles,
  type        text not null references notification_types,
  dedupe_key  text unique not null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  content_purged_at timestamptz
);

create table notification_contents (
  notification_id uuid primary key references notifications,
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  purge_after     timestamptz not null,
  check (purge_after <= created_at + interval '90 days')
);

create table notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications,
  channel         text not null check (channel in ('webpush','expo','email')),
  subscription_id uuid references push_subscriptions,
  target_digest   text not null, -- endpoint de alta entropia ou HMAC versionado do e-mail; nunca alvo em claro
  status          text not null default 'pending' check (status in ('pending','leased','sent','failed','dead')),
  attempts        int not null default 0,
  lease_until     timestamptz,
  next_attempt_at timestamptz,
  last_error_code text,
  provider_message_id text,
  sent_at         timestamptz,
  unique (notification_id, channel, target_digest),
  check ((channel in ('webpush','expo')) = (subscription_id is not null))
);

create table transition_markers (
  match_id    uuid not null references matches,
  transition text not null,
  marker_key  text not null, -- inclui versão/instante: n13:prior-day:<ISO>; claim:<id>:<expires_at>
  outcome     text not null default 'applied'
              check (outcome in ('applied','sent','skipped_stale')),
  applied_at  timestamptz not null default now(),
  primary key (match_id, marker_key)
);

create table private.job_runs (
  id            bigint generated always as identity primary key,
  run_key       text unique not null, -- cron:<job>:<slot> ou request:<uuid>
  job_name      text not null,
  match_id      uuid references matches,
  triggered_by  text not null check (triggered_by in ('cron','organizer','admin','system')),
  requested_by  uuid references profiles,
  scheduled_for timestamptz not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null check (status in ('running','succeeded','failed')),
  error_code    text,
  summary       jsonb not null default '{"scanned":0,"changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0}'::jsonb,
  check ((triggered_by in ('organizer','admin')) = (requested_by is not null))
);

create table private.retention_runs (
  id            bigint generated always as identity primary key,
  policy        text not null,
  window_start  timestamptz not null,
  window_end    timestamptz not null,
  scanned       int not null check (scanned >= 0),
  purged        int not null check (purged >= 0),
  failed        int not null check (failed >= 0),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  check (window_start <= window_end)
);

create table legal_holds (
  id            uuid primary key default gen_random_uuid(),
  category      text not null check (category in ('financial_ledger','financial_dispute','rating_dispute','incident_log')),
  record_type   text not null,
  record_id     text not null check (length(record_id) <= 80),
  case_reference text not null check (length(case_reference) <= 120),
  reason        text not null check (length(reason) <= 500),
  created_by    uuid not null references profiles,
  starts_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  released_at   timestamptz,
  check (expires_at > starts_at)
);
```

`private.job_runs.match_id` nasce nullable e sem FK no M1-A, porque `public.matches` ainda não
existe. A migration que criar `matches` adiciona e testa a FK; a ausência inicial é uma ordem
explícita de implantação, não um relaxamento permanente de integridade.

Aquisição idempotente ocorre na **mesma transação `READ COMMITTED`** da mutação. A função faz
`insert ... on conflict do nothing returning 1` com estado `executing_uncommitted`. A unique
faz o insert concorrente aguardar commit/rollback do vencedor. Se o vencedor commitou, o
perdedor não inseriu e, em um **novo statement** da mesma RPC, lê a linha agora `completed`,
compara HMAC e reproduz o outcome; se houve rollback, o concorrente insere e executa. Um
constraint trigger `DEFERRABLE INITIALLY DEFERRED` rejeita commit que deixe
`executing_uncommitted`, portanto não há lease, takeover nem placeholder intermediário
observável. Timeout enquanto espera é mapeado para `IDEMPOTENCY_WAIT_TIMEOUT`, retryable e
sem efeito parcial. HMAC diferente retorna `IDEMPOTENCY_CONFLICT` sem tocar domínio.
Essa topologia depende do comportamento documentado de unique indexes, que podem bloquear
inserts concorrentes até a transação conflitante terminar
([PostgreSQL INSERT](https://www.postgresql.org/docs/current/sql-insert.html)); ela não supõe
visibilidade de escrita não commitada.

O vencedor, ainda na mesma transação, adquire locks do domínio, produz efeito/outbox e chama
`complete_idempotency`, que grava apenas outcome tipado. Crash antes do commit elimina chave,
efeito e outbox juntos; crash depois do commit encontra `completed`. Efeitos externos nunca
ficam dentro dessa promessa: a transação insere `private.external_effects.dedupe_key`, e worker com
lease/reconciliação própria executa a saga. Após 30 dias, o job zera `outcome` e marca
`payload_expired`; retry até 24 meses retorna `IDEMPOTENCY_EXPIRED`, sem reexecução.

### 9.1 Canonicalização idempotente v1

O transporte possui duas fronteiras distintas. Na chamada externa, o cliente envia somente
`request_id` e entrada de negócio à Edge; nunca envia `input_hmac`, `hash_key_version` ou
contexto de ator. A Edge valida o JWT, extrai `auth_user_id`/`session_id` das claims
verificadas, aplica rate limit, normaliza a entrada e calcula JCS/HMAC com a chave do cofre. Na
chamada interna, ela acrescenta à RPC estreita o contexto verificado, `input_hmac` e
`hash_key_version`.

O HMAC detecta replay com entrada divergente e impede que um dump permita testar por força
bruta digests de entradas de baixa entropia; ele **não autentica nem autoriza** o ator. A RPC
valida formato/versão, compara o HMAC persistido no replay e revalida todos os campos e regras
de negócio no banco. A chave nunca entra no cliente, banco, tabela, configuração SQL ou log.
Não existe helper produtivo `private.compute_idempotency_hash`: vetores SQL chamam
`extensions.hmac` diretamente ou usam helper criado e removido pela própria suíte.

Antes do HMAC, cada operação transforma a entrada validada em objeto normativo: campos
desconhecidos são rejeitados; ausência é diferente de `null`; strings de negócio são NFC;
UUIDs ficam minúsculos; timestamps usam UTC `YYYY-MM-DDTHH:mm:ss.ffffffZ`; dinheiro é string
decimal com duas casas; inteiros ficam no intervalo seguro e floats/NaN/Infinity são proibidos;
arrays que representam conjuntos são ordenados pelos bytes definidos pelo schema, enquanto
arrays ordenados preservam posição. O resultado é serializado por
[JSON Canonicalization Scheme, RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html), em
UTF-8 sem BOM.

Bytes do MAC:

```text
HMAC-SHA-256(key[hash_key_version],
  UTF8("colete/idempotency/v1") || 0x00 || UTF8(operation) || 0x00 || JCS(input))
```

Persiste-se `canonical_version=1` e `hash_key_version`. O cofre preserva chave antiga até o
último tombstone dependente expirar. Vetor público: chave de teste `00..1f`, operação
`join_match`, JCS
`{"list_kind":"field","match_id":"01890f7e-e948-7c53-b13a-4a36e4b7d21e"}` produz
`5974c4e8c2434e4d150f2f2199180b3228c869f80e72dabc0f25218132595ee4`.

Antes de consultar se já existe perfil, `complete_profile` deriva a chave
`bootstrap:<digest hexadecimal minúsculo>`, válida somente para essa operação, em que:

```text
digest = SHA-256(
  UTF8("colete/bootstrap-actor/v1") || 0x00 || UUID_BYTES(auth_user_id)
)
```

`UUID_BYTES` são os 16 bytes do UUID em ordem textual/RFC 4122 (network order): remover os
hífens da forma canônica minúscula e decodificar os 32 dígitos hexadecimais, sem UTF-8 do
texto. Vetor comum: `auth_user_id=01890f7e-e948-7c53-b13a-4a36e4b7d21e` usa bytes
`01890f7ee9487c53b13a4a36e4b7d21e` e produz
`21409156bb1cbd9d8cadf3814edcf230153e3378c09dc03ebf5ed8940c9c4d3a`.

O Auth ID vem das claims verificadas pela Edge. Durante `executing_uncommitted`, `actor_id`
pode ser nulo; depois do insert de `profiles`, a mesma transação liga
`actor_id=profiles.id` antes de marcar `completed`. Assim o replay ainda encontra a chave
bootstrap depois da criação, sem deixar ator permanentemente nulo.

Outcomes autorizados: participação/claim `{match_player_id,payment_cycle_id?,claim_id?,
logical_result}`; upload `{upload_session_id,constraints}`; financeiro `{payment_cycle_id,
resolution_id?,refund_event_id?,logical_result}`; sorteio `{draw_id,algorithm_version,
match_revision}`; identidade `{logical_result}` para `update_profile`,
`{profile_id,logical_result:'profile_created'}` para `complete_profile`,
`{accepted:[{document_type,version}],logical_result}` para `accept_policies` e
`{session_id,revoked_at,logical_result}` para `revoke_current_session`. `logical_result`
descreve o efeito no instante (`joined`, `waitlisted`, `claim_created`,
`resolution_created`, `profile_created`, `profile_updated`, `policies_accepted`,
`session_revoked`), não o estado atual.

As quatro formas de identidade obedecem à mesma regra do parágrafo acima: guardam fato
imutável, nunca estado. `complete_profile` guarda somente o ID criado; `update_profile` não
ecoa os campos gravados — nome, apelido,
posição, perna e número continuam mutáveis depois do commit, e o cliente relê por projeção
fresca. `accept_policies` guarda as versões aceitas, que são fato datado e imutável, com o
array ordenado por `document_type` e depois `version` para que a canonicalização seja
determinística. `revoke_current_session` guarda `session_id` e `revoked_at` e não guarda
`expires_at`, porque prazo de sessão é precisamente o que este parágrafo proíbe.

Prazo/status/posição de claim ou sessão, capacidade restante e estado financeiro mutável não
são persistidos. Pix, token/URL/path de upload, nota, prova, fingerprint/HMAC, input/score,
motivo livre e campos de perfil são proibidos. Toda resposta combina outcome com projeção atual fresca:
`get_my_match_state`, `get_upload_session_state` e projeções financeiras. Pix só via
`get_payment_instructions`; upload/leitura só pelos endpoints Edge autenticados para sessão/
caso utilizável;
proposta via `get_draw_proposal`. Token/Pix/claim aparentemente ativa nunca reaparecem.
Trigger `validate_idempotency_outcome(operation,outcome)` aplica a allowlist por operação e
rejeita chave desconhecida/tipo mutável antes de permitir `state='completed'`.

`validate_notification_payload(type,payload)` aplica o esquema N1–N28 de
`12-notificacoes.md`, rejeita chave desconhecida e as mesmas categorias sensíveis. Cliente
não insere notificação nem fornece payload.
`validate_job_summary(summary)` aceita somente os inteiros/`cursor` enumerados em
`17-mapa-dados-lgpd.md`; jobs não guardam listas de IDs pessoais.

Outbox (`notifications` + `notification_contents`) é gravado na **mesma transação** da
mudança. O fato mínimo e deliveries ficam 12 meses; conteúdo tipado sai aos 90 dias sem
apagar o pai nem fabricar `{}` inválido. Delivery ainda não terminal aos 90 dias vira
`dead/content_expired` antes do purge. Preferência opcional suprime somente deliveries
externos; a linha in-app continua existindo. Canais são entregues separadamente; retry pode
repetir externamente, então payload leva `notification_id` para
deduplicação do cliente.
Registrar a mesma assinatura em outro perfil trava a assinatura, marca deliveries pendentes da
conta anterior como `dead/subscription_reassigned` e só então transfere a propriedade/payload.
Logout tenta revogar, e resposta 404/410 também desabilita. Policies de delivery autorizam pelo
destinatário da `notifications`, nunca pelo dono atual da assinatura. Assim aparelho compartilhado
não recebe evento antigo nem lê histórico da conta anterior.

## 10. Transações críticas

Todas conquistam a chave idempotente não commitada da seção 9 antes dos locks de domínio.
Depois, IDs necessários são resolvidos sem lock e linhas são travadas nesta ordem, sempre
`FOR UPDATE`: perfis, grupos, memberships, recorrências, rachas, convites, participantes,
claims, ciclos, sessões/provas,
resoluções/estornos/contestações/casos. Se houver mais de um ID no mesmo nível, ordena-se
pelos 16 bytes do UUID em ordem crescente; não pela ordem do payload. A função nunca espera
em nível anterior depois de adquirir um posterior.

`create_group` trava o perfil e reconta seus cinco grupos. `approve_member` trava perfil,
grupo e membership; o grupo serializa `pending+active <= 100`. Resgate trava perfil, grupo e
convite e usa incremento condicional de `used_count`. Testes com 2–50 transações simultâneas
cobrem quinta/sexta membership, 99º/100º/101º membro, último uso de convite, última vaga,
última claim e ausência de deadlock em lotes com UUIDs invertidos.

### `join_match(match_id, list_kind, request_id)`

1. resolve IDs sem lock; trava **perfil → grupo → membership → racha**, nessa ordem;
2. sob esses locks, revalida perfil `active`, membership `active`, grupo não suspenso/
   arquivado e vínculo `match.group_id=membership.group_id`; remoção/saída concorrente ou
   `deletion_pending` vence antes da inserção;
3. chama `apply_due_transitions_locked`, exige fase `open`, `now < payment_due_at` e regra TP/T0;
4. reativa registro `left` como nova intenção; retry é distinguido por `request_id`;
5. conta starter da lista; insere/atualiza `starter` ou `waitlist`;
6. abre `payment_cycle` `exempt` para goleiro gratuito ou `presumed` para mensalista, mesmo
   após T0; quem perdeu TP perde a prioridade, não o pagamento presumido; demais ficam
   com ciclo `pending`.

Teste obrigatório intercala 50 `join_match` com `leave_group`, `remove_member`, suspensão e
`delete_account`, começando cada lado primeiro. Estado final nunca contém participante ativo
sem membership ativa no instante linearizado e nenhum caminho inverte racha→membership.

### `apply_payment_deadline(match_id)`

1. trava racha;
2. insere marker `payment_deadline` — conflito significa já aplicado;
3. starters `pending` vão ao fim da espera com nova sequência;
4. para cada vaga, promove imediatamente quem tem ciclo aceito/presumido/isento; para ciclo
   `pending`, cria claim de promoção de 30 min e reserva a capacidade; `under_review` não
   salta a decisão;
5. seta `payment_deadline_applied_at` e grava notificações deduplicadas.

### `claim_open_slot(match_id, list_kind, request_id)`

Exige `now >= payment_due_at`, `now < closes_at`, fila elegível vazia e capacidade. Para
pagante, cria/reativa starter + ciclo/claim de 10 min antes de o cliente abrir o banco.
Mensalista `presumed` e goleiro `exempt` ocupam imediatamente sem claim/Pix. Cooldown impede reocupação
contínua de pagantes.

Adição manual de membro só é aceita em `closes_at <= now() < starts_at`, sem publicação
**atual** e com capacidade; histórico já invalidado não bloqueia. Pagante recebe claim `manual` até
`least(now()+promoted_payment_minutes, starts_at)` e N7. Antes de T2, somente o convite
avulso auditado pode criar esse tipo de exceção à corrida. Se uma claim manual expira
antes de T2, o preenchimento automático volta à fila; em/após T2 não há promoção
automática e o organizador resolve a próxima adição. Mensalista/isento manual não cria claim.

Remoção é aceita até `starts_at`. Se houver publicação atual, a mesma transação aplica a
invalidação descrita na seção 7; nenhum cliente observa times atuais contendo alguém já
removido. Remoção em massa por saída/expulsão do grupo usa a mesma primitiva para todo
racha futuro e só confirma a mudança de membership após sucesso integral.

### `create_proof_upload` / `finalize_proof`

Só starter com vaga/claim/ciclo válidos cria sessão. Finalização trava racha, jogador/claim,
ciclo e sessão; valida objeto, calcula SHA transitório + fingerprint HMAC, cria prova, completa
claim, muda o ciclo para `under_review`, adiciona ledger e N18.

### `decide_proof(proof_id, decision, reason, request_id)`

Resolve IDs, trava racha → jogador → ciclo → comprovante. Só a criação da resolução única
vence. Mesma decisão já aceita devolve estado; decisão conflitante ou `mark_paid` concorrente
retorna `PAYMENT_ALREADY_RESOLVED`. Aprovação
tardia de starter apenas resolve o financeiro. Para espera: antes de T2 respeita fila/
capacidade; entre T2 e o início, capacidade livre gera `manual_add_required`; sem capacidade,
com publicação atual ou em/após o início, cria resolução + `refund_due`. Nunca remove starter
válido. Em racha cancelado, aprovação também cria resolução + `refund_due` sem reabrir vaga.

### Resolução, estorno e contestação concorrentes

- `decide_proof`, `mark_paid` e `record_canceled_match_payment` disputam o mesmo lock de
  ciclo e a unique de `payment_resolutions`. Se resolução externa vencer, prova indecidida
  vira `resolved_elsewhere`; se aprovação vencer, `mark_paid` não cria segundo pagamento.
- `mark_refund_due`, `mark_refunded`, `correct_refund` e `open_financial_dispute` travam
  ciclo → resolução → obrigação → disputa. Unique constraints tornam pares simultâneos
  idempotentes ou `PAYMENT_CYCLE_CONFLICT`, nunca duas obrigações/resoluções.
- `unlock_price_after_refunds` trava todos os ciclos por UUID e exige cada resolução real
  `refunded`, nenhuma prova indecidida e nenhuma disputa
  `open|responded|resolved_first_instance|appealed|escalated`. O update de preço
  fecha os ciclos antigos e cria exatamente uma nova `charge_version` por participante.
- Testes obrigatórios executam em ambos os orders e com retry de cada vencedor/perdedor:
  aprovar × rejeitar; aprovar × marcar pago; rejeitar × marcar pago; pagamento cancelado ×
  decisão tardia; marcar estorno devido × marcar devolvido; devolvido × correção; destravar
  preço × abrir contestação; update de preço × retry; e duas finalizações no mesmo ciclo.
- Cenário de autoridade cobre único dono com convidado, claim ativa, prova `under_review`,
  resolução aceita, `refund_due` e publicação com participante: suspensão transfere/abre
  todos os casos antes da sessão cair; exclusão sem substituto falha; com substituto conclui
  sem participante fantasma nem acesso geral do Admin.

### `reconcile_match(match_id, request_id)`

Resolve `group_id/recurrence_id` sem lock; racha recorrente trava grupo→recorrência→racha,
avulso trava grupo→racha. Só então aplica em ordem TP, T0, T1, claims vencidos, reviews vencidas, T2, fechamento financeiro do
início e done, cada qual com marker. Depois de `starts_at`, claims não promovem e review
vencida não altera participação. No fechamento do início, espera com resolução aceita
sem vaga recebe `refund_due`; starter com ciclo `under_review` permanece congelado para decisão humana.
Marcos informativos (N1/N5/N13/N20) também recebem marker `sent`/`skipped_stale`; atraso não
envia lembrete já contraditório. Pode ser chamada por cron, app ou ação do organizador e sempre
produz o mesmo estado final.

Racha `canceled` não processa claims/reviews como fila: claims são canceladas e provas
`under_review` viram pendência financeira para decisão humana, sem N11/promoção.

### Sorteio

Edge lê `{revision, snapshot}`; calcula; `commit_draw(expected_revision, request_id, result)`
trava, reconcilia, revalida e grava draw+fase+auditoria atomicamente. Toda mudança de lista ou
nota relevante incrementa `matches.revision`; publicação exige a revisão do draw.
O ajuste manual vive apenas como draft no cliente. `publish_draw` recebe a composição final
com todos os participantes exatamente uma vez e o mesmo multiconjunto de tamanhos permitido
pela proposta; rejeita draft intermediário 2/4, duplicata ou ausência. O servidor compara
proposta×final e cria um `manual_move` por participante cujo time mudou, ordenado por
`profile_id` em bytes, sem tentar persistir uma sequência de swaps intermediários.

## 11. Projeções seguras e RLS

RLS filtra **linhas**, não colunas. Por isso o cliente não recebe `select *` nas tabelas
sensíveis:

- `public_profiles` expõe só nome/apelido/foto/posição necessários e **não é enumerável
  globalmente**: a consulta precisa provar grupo ativo compartilhado ou participação no
  mesmo racha; convidado recebe apenas perfis daquele racha e nunca a lista do grupo;
- `match_public_details` omite Pix, campos de lock e configuração operacional;
- `match_players_public` retorna participantes e rótulo agregado de pagamento, sem tier,
  ledger ou IDs de prova;
- `get_payment_instructions(match_id)` é RPC com `security definer`, `search_path` fixo e
  checagem fresca: organizador ou o próprio starter com ciclo `pending`; em/após T1 exige
  claim `active` não expirada. Claim vencida retorna `CLAIM_EXPIRED` e nunca revela Pix,
  inclusive quando a mutação idempotente original é repetida;
- `PUT /proof-upload-sessions/:id/content` revalida titular, sessão `created`, prazo, ciclo
  `pending` e claim antes de aceitar o corpo; o service role resolve o path internamente,
  usa `upsert=false` e nunca devolve token/URL/path;
- `GET /proofs/:id/content`/`GET /admin-cases/:id/evidence` revalidam autoridade a cada
  requisição e fazem stream sem cache/redirect; não existe signed URL de comprovante;
- `published_team_members` lê somente `team_members` da publicação atual; não faz join com
  `team_rating_snapshots`;
- funções `security definer` revogam `public execute` e recebem grants nominais.

Views usam `security_invoker` + grants por coluna quando possível. Onde a projeção precisa
de privilégio elevado, usa-se função com retorno tipado, allowlist de colunas e teste
negativo; nunca view `security_definer` aberta.

Toda RPC mutável recebe `revoke execute` de `public`, `anon` e `authenticated`; somente o papel
administrativo usado pela Edge com secret key recebe o grant nominal da função interna. O
cliente administrativo só pode chamar essa allowlist de RPCs: não existe API administrativa
genérica nem escrita livre da Edge em tabelas de domínio. Como secret keys conferem acesso
elevado e ignoram RLS, essa restrição também é testada nos grants e na camada Edge; RLS não é
tratada como defesa aplicável ao chamador administrativo.

A Edge valida o JWT e passa `actor_auth_user_id`/`actor_session_id` obtidos das claims, nunca
do body. A RPC interna fixa `search_path`, qualifica objetos, rejeita sessão revogada e
`account_status in ('deletion_pending','deleted')`, resolve `profiles.id` pelo Auth ID e valida
membership/autorização dentro da transação. Nesse caminho, `auth.uid()` identifica o cliente
administrativo ou é nulo — não prova o usuário final. A confiança na origem do contexto vem da
Edge autenticada e do grant exclusivo; as constraints, denylist, locks e regras de domínio
continuam no banco. Projeções diretas autorizadas pelo JWT podem continuar usando `auth.uid()`
em RLS. O Admin de produto vem de allowlist/claim verificada, nunca de coluna editável do perfil.
Antes de mutar, o helper comum rejeita conta `suspended|banned`, salvo canal próprio de
privacidade/contestação e resolução de caso já transferido. Suspensão urgente transfere ou
abre `financial_cases` antes de revogar sessões. Grupo suspenso usa allowlist mínima: saída,
cancelamento seguro e resolução financeira pela autoridade substituta continuam; novas
inscrições, convites, edições, draws e publicações são rejeitados. Leitura própria,
exportação e canal de recurso/privacidade continuam disponíveis. Exclusão obedece o bloqueio
financeiro da seção 2.

| Recurso | Leitura | Escrita |
|---|---|---|
| `profiles` | próprio; demais só por `public_profiles` | próprio via RPC allowlist |
| `policy_documents` | serviço; cliente recebe somente projeção de versão obrigatória | migration/dispatcher interno; sem texto integral |
| `policy_acceptances`, `privacy_requests`, `data_exports`, `deletion_requests` | próprio por projeção mínima; export só por stream autenticado | RPC própria/sistema; tabelas de saga somente worker |
| `revoked_auth_sessions` | serviço; próprio vê apenas estado agregado da sessão | RPC de revogação/sistema |
| `groups`, `group_members` | membros ativos; pendente vê só o pedido | RPC de dono/organizador conforme ação |
| `group_invites`, `match_invites` | criador/organizadores; token nunca é retornado do banco | RPC |
| `recurrences`, `recurrence_payment_secrets` | regra a organizadores; segredo só por função interna | somente RPC/sistema |
| `matches`, `match_payment_secrets` | detalhe seguro por projeção; Pix só por RPC a organizador/starter/claim válido | RPC de organizador/sistema |
| `match_players` | participantes só por projeção; própria posição por RPC | somente RPC |
| `slot_claims` | próprio e organizadores | somente RPC |
| `payment_cycles`, `payment_resolutions`, `payment_events` | afetado e organizadores por projeção; participantes veem só rótulo agregado | somente RPC/trigger |
| `proof_upload_sessions`, `payment_proofs` | próprio/autoridade só por RPC/Edge tipada; caminho/fingerprint ficam no servidor | somente RPC/Edge |
| `financial_disputes`, `financial_appeals`, `financial_dispute_events` | partes e autoridade; motivo só em detalhe autorizado | somente RPC/trigger; sem delete |
| `financial_cases` | autoridade atribuída; Admin recebe projeção mínima do caso | somente função administrativa/financeira |
| `ratings`, `rating_history` | organizador; titular vê a própria em qualquer visibilidade e, durante a retenção, mesmo após remoção; demais membros ativos veem atuais só se `members`; histórico nunca é público | somente RPC |
| `rating_disputes`, `rating_dispute_events` | titular alvo, autoridade de resposta e Admin após escalonamento | somente RPC/trigger; sem delete |
| `draws`, `draw_private_artifacts`, `team_publications`, `teams`, `team_members`, `team_rating_snapshots` | organizadores autorizados; participantes só pela view atual sem nota | somente servidor |
| `published_team_members` | participantes | view sem nota |
| `audit_log` | participantes, payload sanitizado | somente funções de servidor |
| `group_audit_log` | membros ativos e pessoa afetada, payload sanitizado | somente funções de servidor |
| `admin_audit_log` | Admin e usuário afetado em projeção sanitizada | somente função administrativa |
| `push_subscriptions`, `notifications`, `notification_contents`, `notification_deliveries`, `notification_prefs` | próprio por projeção sanitizada; payload/endpoint bruto só serviço | assinatura/prefs via RPC; restante sistema |
| `idempotency_records`, `external_effects`, `transition_markers`, `job_runs` | serviço; organizador vê saúde agregada | sistema |

As migrations executam `enable row level security` e `force row level security` e revogam
privilégios antes de criar policies. Testes pgTAP tentam acesso indevido com cada papel.

## 12. Jobs e retenção

| Job | Frequência | Comportamento idempotente |
|---|---|---|
| `reconcile_due_matches` | por minuto | chama `reconcile_match` nos rachas com transição vencida |
| `dispatch_notifications` | por minuto | lease por destino/canal, retry/backoff, dead-letter e alerta |
| `expire_upload_sessions` | a cada 10 min | expira sessão e remove objeto órfão/não finalizado |
| `purge_proofs` | diário | apaga objeto; nulifica caminho/fingerprint; grava `proof_purged` só após sucesso no Storage |
| `process_external_effects` | por minuto | executa saga de Auth/Storage/export com `dedupe_key`, lease, backoff e reconciliação do estado externo |
| `expire_data_exports` | a cada hora | remove artefato vencido antes de marcar `expired`; exclusão de conta tem prioridade |
| `finalize_financial_appeal_windows` | por hora | sem apelação, finaliza primeira instância vencida; com apelação/SLA, garante caso Admin único |
| `expire_rating_dispute_sla` | por hora | escalona disputa de nota vencida sem duplicar evento/caso |
| `purge_draw_private_artifacts` | diário | apaga input/seed/HMAC/score e snapshots de estrela vencidos, preservando composição |
| `purge_idempotency_outcomes` | diário | faz `completed → payload_expired`, sem apagar tombstone antes de 24 meses |
| `apply_retention` | diário | aplica o mapa canônico a notas, conteúdo de notificações, ledger, disputas, auditoria e logs; metadado/delivery não dependem do conteúdo |
| `health_check_jobs` | a cada 5 min | alerta Sentry se transição/job atrasar acima do limite |

A tabela completa e normativa de finalidade, papéis, campos, derivados, prazo, evento inicial,
expurgo, exceção e backup está em `17-mapa-dados-lgpd.md`. O schema não mantém uma segunda
tabela resumida que possa divergir. Em especial: prova/fingerprint expiram em sete dias mesmo
sob disputa; artefatos privados e estrelas do sorteio em 12 meses; composição continua sem
nota; idempotência guarda outcome por 30 dias e tombstone/HMAC por 24 meses; contestação
financeira suspende apenas a retenção do ledger/texto necessários.

Backup e restore seguem o runbook de `14-convencoes-app.md`: reaplicam manifesto de exclusões
e expurgos antes de liberar tráfego. `retention_runs` registra política, janela, contagens,
falhas e duração; atraso acima de 24 h alerta operação.
