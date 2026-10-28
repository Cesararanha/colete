-- Fatia D63.5: registro de operações de idempotência em tabela (09 D63.5;
-- 16 §8, "Pré-M3 — registro de operações"; 25 §8.1, obrigatório antes do
-- piloto com usuários reais). Pré-plano conferido em duas rodadas
-- (~/colete-noite/plano-d63-5.md §§8 a 11, fora do repositório); decisões
-- humanas de César de 28/10/2026, P-A a P-F.
--
-- Até a 0032, cada operação nova redefinia a lista de operações em cinco
-- lugares: os três CHECKs de private.idempotency_records (operation,
-- outcome_code e resource_type), acquire_group_idempotency,
-- complete_group_idempotency, o gatilho de conclusão e mais um elo numa cadeia
-- de validadores renomeados (13 elos). A partir daqui, a lista mora em duas
-- tabelas imutáveis, lidas por um validador estável:
--
-- * private.idempotency_operations: uma linha por operação, com a família
--   (identity, account, group), o formato do desfecho (ids, ou as duas
--   exceções accept_policies e session_revoked), as chaves UUID exatas e o
--   recurso (tipo, chave do desfecho que o nomeia e se ele é o ator);
-- * private.idempotency_operation_results: uma linha por resultado lógico.
--
-- Três FKs substituem os três CHECKs: (operation), que vale também para o
-- executing_uncommitted; (operation, outcome_code); e (operation,
-- resource_type). As duas compostas são MATCH SIMPLE: com nulo não conferem,
-- como os CHECKs de antes, e com valor conferem por operação, o que é mais
-- estrito que os CHECKs globais.
--
-- Operação nova da família group no formato ids passa a ser uma linha em cada
-- tabela, numa migration, mais as listas da Edge e o teste de consistência.
-- Operação de identidade ou de conta ainda redefine os próprios helpers (P-B),
-- e formato novo ainda redefine o validador. As tabelas são imutáveis (P-C):
-- operation faz parte da chave primária do registro e da entrada do HMAC, então
-- trocar o desfecho de uma operação existente pede desenho próprio.
--
-- Equivalência (P-D): a migration revalida todo registro completed existente
-- com a regra nova, antes de trocar qualquer coisa, e aborta no primeiro que
-- falhar; os payload_expired são conferidos pelas FKs ao serem criadas. A regra
-- de conclusão mora numa função só, private.check_idempotency_conclusion,
-- usada pela revalidação e pelo gatilho. Dois endurecimentos deliberados, em
-- caminhos que nenhuma RPC alcança: logical_result precisa ser string em todas
-- as operações (rename_group e request_data_export aceitavam JSON null no
-- validador), e o gatilho compara recurso com is distinct from em todas (as de
-- identidade e conta usavam <>, que deixa nulo passar). O limite de 4096 bytes
-- do desfecho, que valia para as de identidade, passa a valer para todas.
--
-- Fronteira de privilégios: as tabelas nascem em private, sem RLS e sem grant
-- (14 §5.2), lidas só por funções; o validador e os helpers continuam
-- security invoker com search_path vazio, chamados de dentro das RPCs security
-- definer; o gatilho continua security definer, porque dispara no commit sob
-- service_role. A migration roda numa transação só: a trava é tomada no início
-- e vale até o fim.
begin;

set local lock_timeout = '5s';
lock table private.idempotency_records in access exclusive mode;

do $check$
begin
  if exists (
    select 1 from private.idempotency_records where state = 'executing_uncommitted'
  ) then
    raise exception 'D63.5: executing_uncommitted visível durante a migration';
  end if;
end;
$check$;

-- ---------------------------------------------------------------------------
-- Registro de operações
-- ---------------------------------------------------------------------------
create table private.idempotency_operations (
  operation         text primary key check (operation ~ '^[a-z][a-z0-9_]{0,62}$'),
  family            text not null check (family in ('identity', 'account', 'group')),
  outcome_shape     text not null
                    check (outcome_shape in ('ids', 'accept_policies', 'session_revoked')),
  id_keys           text[] not null,
  resource_type     text,
  resource_key      text,
  resource_is_actor boolean not null default false,
  unique (operation, resource_type),
  check ((resource_type is null) = (resource_key is null)),
  check (resource_key is null or resource_key = any (id_keys)),
  check (not resource_is_actor or resource_type is not null)
);

comment on table private.idempotency_operations is
  'Registro de operações de idempotência (D63.5, 0033): família, formato do desfecho, chaves UUID exatas e recurso. Imutável; lido só pelo validador, pelos helpers da família group e pela regra de conclusão.';

create table private.idempotency_operation_results (
  operation      text not null references private.idempotency_operations (operation),
  logical_result text not null check (logical_result ~ '^[a-z][a-z0-9_]{0,62}$'),
  primary key (operation, logical_result)
);

comment on table private.idempotency_operation_results is
  'Resultados lógicos permitidos de cada operação (D63.5, 0033). Imutável; alvo da FK (operation, outcome_code) de idempotency_records.';

insert into private.idempotency_operations
  (operation, family, outcome_shape, id_keys, resource_type, resource_key, resource_is_actor)
values
  ('complete_profile', 'identity', 'ids', array['profile_id'], 'profile', 'profile_id', true),
  ('update_profile', 'identity', 'ids', array[]::text[], null, null, false),
  ('accept_policies', 'identity', 'accept_policies', array[]::text[], null, null, false),
  ('revoke_current_session', 'identity', 'session_revoked', array['session_id'], 'auth_session', 'session_id', false),
  ('delete_account', 'account', 'ids', array['deletion_request_id'], 'deletion_request', 'deletion_request_id', false),
  ('request_data_export', 'account', 'ids', array['export_id'], 'data_export', 'export_id', false),
  ('approve_member', 'group', 'ids', array['group_id', 'profile_id'], 'group', 'group_id', false),
  ('remove_member', 'group', 'ids', array['group_id', 'profile_id'], 'group', 'group_id', false),
  ('set_role', 'group', 'ids', array['group_id', 'profile_id'], 'group', 'group_id', false),
  ('set_monthly', 'group', 'ids', array['group_id', 'profile_id'], 'group', 'group_id', false),
  ('set_ratings_visibility', 'group', 'ids', array['group_id'], 'group', 'group_id', false),
  ('transfer_ownership', 'group', 'ids', array['group_id', 'new_owner_id'], 'group', 'group_id', false),
  ('leave_group', 'group', 'ids', array['group_id'], 'group', 'group_id', false),
  ('create_group', 'group', 'ids', array['group_id', 'invite_id'], 'group', 'group_id', false),
  ('join_by_code', 'group', 'ids', array['group_id', 'invite_id'], 'group', 'group_id', false),
  ('join_by_invite', 'group', 'ids', array['group_id', 'invite_id'], 'group', 'group_id', false),
  ('revoke_group_invite', 'group', 'ids', array['group_id', 'invite_id'], 'group', 'group_id', false),
  ('regenerate_group_invite', 'group', 'ids', array['group_id', 'invite_id'], 'group', 'group_id', false),
  ('issue_group_invite', 'group', 'ids', array['group_id', 'invite_id'], 'group', 'group_id', false),
  ('rename_group', 'group', 'ids', array['group_id'], 'group', 'group_id', false),
  ('create_match', 'group', 'ids', array['group_id', 'match_id'], 'group', 'group_id', false),
  ('join_match', 'group', 'ids', array['group_id', 'match_id'], 'group', 'group_id', false),
  ('leave_match', 'group', 'ids', array['group_id', 'match_id'], 'group', 'group_id', false),
  ('set_match_payment', 'group', 'ids', array['group_id', 'match_id', 'profile_id'], 'group', 'group_id', false),
  ('set_group_appearance', 'group', 'ids', array['group_id'], 'group', 'group_id', false),
  ('update_match', 'group', 'ids', array['group_id', 'match_id'], 'group', 'group_id', false),
  ('cancel_match', 'group', 'ids', array['group_id', 'match_id'], 'group', 'group_id', false),
  ('delete_group', 'group', 'ids', array['group_id'], 'group', 'group_id', false),
  ('begin_photo_upload', 'group', 'ids', array['upload_id'], 'photo_upload', 'upload_id', false),
  ('set_profile_photo', 'group', 'ids', array['profile_id'], 'profile', 'profile_id', true),
  ('remove_profile_photo', 'group', 'ids', array['profile_id'], 'profile', 'profile_id', true),
  ('set_group_photo', 'group', 'ids', array['group_id'], 'group', 'group_id', false),
  ('remove_group_photo', 'group', 'ids', array['group_id'], 'group', 'group_id', false),
  ('set_rating', 'group', 'ids', array['group_id', 'profile_id'], 'group', 'group_id', false),
  ('draw_teams', 'group', 'ids', array['group_id', 'match_id'], 'group', 'group_id', false);

insert into private.idempotency_operation_results (operation, logical_result)
values
  ('complete_profile', 'profile_created'),
  ('update_profile', 'profile_updated'),
  ('accept_policies', 'policies_accepted'),
  ('revoke_current_session', 'session_revoked'),
  ('delete_account', 'deletion_requested'),
  ('request_data_export', 'data_export_requested'),
  ('approve_member', 'member_approved'),
  ('approve_member', 'member_refused'),
  ('remove_member', 'member_removed'),
  ('set_role', 'role_set'),
  ('set_monthly', 'monthly_set'),
  ('set_ratings_visibility', 'ratings_visibility_set'),
  ('transfer_ownership', 'ownership_transferred'),
  ('leave_group', 'group_left'),
  ('create_group', 'group_created'),
  ('join_by_code', 'membership_requested'),
  ('join_by_code', 'membership_reentry_requested'),
  ('join_by_code', 'membership_request_unchanged'),
  ('join_by_code', 'membership_already_active'),
  ('join_by_invite', 'membership_requested'),
  ('join_by_invite', 'membership_reentry_requested'),
  ('join_by_invite', 'membership_request_unchanged'),
  ('join_by_invite', 'membership_already_active'),
  ('revoke_group_invite', 'invite_revoked'),
  ('revoke_group_invite', 'invite_revocation_unchanged'),
  ('regenerate_group_invite', 'invite_regenerated'),
  ('issue_group_invite', 'invite_issued'),
  ('rename_group', 'group_renamed'),
  ('create_match', 'match_created'),
  ('join_match', 'match_joined'),
  ('join_match', 'match_waitlisted'),
  ('join_match', 'match_join_unchanged'),
  ('leave_match', 'match_left'),
  ('leave_match', 'match_leave_unchanged'),
  ('set_match_payment', 'payment_marked_paid'),
  ('set_match_payment', 'payment_marked_unpaid'),
  ('set_match_payment', 'payment_unchanged'),
  ('set_group_appearance', 'group_appearance_set'),
  ('update_match', 'match_updated'),
  ('cancel_match', 'match_canceled'),
  ('cancel_match', 'match_cancel_unchanged'),
  ('delete_group', 'group_deleted'),
  ('begin_photo_upload', 'photo_upload_started'),
  ('set_profile_photo', 'profile_photo_set'),
  ('remove_profile_photo', 'profile_photo_removed'),
  ('remove_profile_photo', 'profile_photo_unchanged'),
  ('set_group_photo', 'group_photo_set'),
  ('remove_group_photo', 'group_photo_removed'),
  ('remove_group_photo', 'group_photo_unchanged'),
  ('set_rating', 'rating_set'),
  ('set_rating', 'rating_unchanged'),
  ('draw_teams', 'teams_drawn');

-- Imutáveis (P-C): só INSERT, numa migration. UPDATE e DELETE por linha, e
-- TRUNCATE por comando, que escapa do gatilho de linha.
create function private.forbid_idempotency_registry_change()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using errcode = '23514', message = 'IDEMPOTENCY_REGISTRY_IMMUTABLE';
end;
$function$;

revoke all on function private.forbid_idempotency_registry_change()
  from public, anon, authenticated, service_role;

create trigger idempotency_operations_immutable
before update or delete on private.idempotency_operations
for each row execute function private.forbid_idempotency_registry_change();
create trigger idempotency_operations_no_truncate
before truncate on private.idempotency_operations
for each statement execute function private.forbid_idempotency_registry_change();
create trigger idempotency_operation_results_immutable
before update or delete on private.idempotency_operation_results
for each row execute function private.forbid_idempotency_registry_change();
create trigger idempotency_operation_results_no_truncate
before truncate on private.idempotency_operation_results
for each statement execute function private.forbid_idempotency_registry_change();

-- ---------------------------------------------------------------------------
-- O validador estável e a regra de conclusão
-- ---------------------------------------------------------------------------
-- Uma regra para os 35, lida da tabela. Só levanta 22023 VALIDATION, como os
-- elos que substitui. stable, porque lê tabela; invoker, porque só é chamado
-- de dentro de RPCs security definer e do gatilho.
create or replace function private.validate_idempotency_outcome(
  p_operation text,
  p_outcome jsonb
)
returns void
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_operation private.idempotency_operations%rowtype;
  v_expected text[];
  v_key text;
  v_uuid uuid;
  v_item jsonb;
  v_document_type text;
  v_version text;
  v_sort_key bytea;
  v_previous_sort_key bytea;
begin
  select operations.* into v_operation
  from private.idempotency_operations as operations
  where operations.operation = p_operation;
  if not found
     or p_outcome is null
     or jsonb_typeof(p_outcome) <> 'object'
     or octet_length(p_outcome::text) > 4096 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  v_expected := v_operation.id_keys || array['logical_result']::text[]
    || case v_operation.outcome_shape
         when 'accept_policies' then array['accepted']::text[]
         when 'session_revoked' then array['revoked_at']::text[]
         else array[]::text[]
       end;
  if (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
       is distinct from (select array_agg(key order by key) from unnest(v_expected) as key)
     or jsonb_typeof(p_outcome -> 'logical_result') is distinct from 'string'
     or not exists (
       select 1 from private.idempotency_operation_results as results
       where results.operation = p_operation
         and results.logical_result = p_outcome ->> 'logical_result'
     ) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  foreach v_key in array v_operation.id_keys loop
    if jsonb_typeof(p_outcome -> v_key) is distinct from 'string'
       or p_outcome ->> v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    begin
      v_uuid := (p_outcome ->> v_key)::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end;
    if p_outcome ->> v_key <> v_uuid::text then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end loop;

  if v_operation.outcome_shape = 'accept_policies' then
    -- 0009: 1 a 2 documentos, chaves exatas, tipos conhecidos, versão curta e
    -- ordem estritamente crescente por (document_type, 0x00, version) em bytes.
    if jsonb_typeof(p_outcome -> 'accepted') <> 'array'
       or jsonb_array_length(p_outcome -> 'accepted') not between 1 and 2 then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    for v_item in
      select value from jsonb_array_elements(p_outcome -> 'accepted') with ordinality
      order by ordinality
    loop
      if jsonb_typeof(v_item) <> 'object'
         or (select array_agg(key order by key) from jsonb_object_keys(v_item) as key)
              is distinct from array['document_type', 'version']::text[]
         or jsonb_typeof(v_item -> 'document_type') <> 'string'
         or jsonb_typeof(v_item -> 'version') <> 'string' then
        raise exception using errcode = '22023', message = 'VALIDATION';
      end if;
      v_document_type := v_item ->> 'document_type';
      v_version := v_item ->> 'version';
      if v_document_type not in ('privacy', 'terms')
         or v_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' then
        raise exception using errcode = '22023', message = 'VALIDATION';
      end if;
      v_sort_key := convert_to(v_document_type, 'UTF8')
        || '\x00'::bytea
        || convert_to(v_version, 'UTF8');
      if v_previous_sort_key is not null and v_sort_key <= v_previous_sort_key then
        raise exception using errcode = '22023', message = 'VALIDATION';
      end if;
      v_previous_sort_key := v_sort_key;
    end loop;
  elsif v_operation.outcome_shape = 'session_revoked' then
    -- 0009: revoked_at com seis casas em UTC e timestamptz válido.
    if jsonb_typeof(p_outcome -> 'revoked_at') <> 'string'
       or p_outcome ->> 'revoked_at'
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    begin
      perform (p_outcome ->> 'revoked_at')::timestamptz;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end;
  end if;
end;
$function$;

revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;

-- A regra de conclusão de um registro completed, a mesma na revalidação desta
-- migration e no gatilho diferido: desfecho válido, outcome_code igual ao
-- logical_result e recurso conforme a linha da operação (o ator, quando a
-- operação diz).
create function private.check_idempotency_conclusion(p_record private.idempotency_records)
returns void
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_operation private.idempotency_operations%rowtype;
begin
  if p_record.state <> 'completed' then
    return;
  end if;
  perform private.validate_idempotency_outcome(p_record.operation, p_record.outcome);
  select operations.* into strict v_operation
  from private.idempotency_operations as operations
  where operations.operation = p_record.operation;
  if p_record.outcome_code is distinct from p_record.outcome ->> 'logical_result'
     or p_record.resource_type is distinct from v_operation.resource_type
     or (v_operation.resource_key is null and p_record.resource_id is not null)
     or (v_operation.resource_key is not null
         and p_record.resource_id
             is distinct from (p_record.outcome ->> v_operation.resource_key)::uuid)
     or (v_operation.resource_is_actor
         and p_record.resource_id is distinct from p_record.actor_id) then
    raise exception using errcode = '23514', message = 'IDEMPOTENCY_OUTCOME_INVALID';
  end if;
end;
$function$;

revoke all on function private.check_idempotency_conclusion(private.idempotency_records)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Revalidação dos registros existentes (P-D), antes de trocar qualquer coisa
-- ---------------------------------------------------------------------------
do $revalidate$
declare
  v_record private.idempotency_records;
begin
  for v_record in
    select * from private.idempotency_records where state = 'completed'
  loop
    perform private.check_idempotency_conclusion(v_record);
  end loop;
end;
$revalidate$;

-- ---------------------------------------------------------------------------
-- Três FKs no lugar dos três CHECKs
-- ---------------------------------------------------------------------------
-- Criadas antes de tirar os CHECKs: ao nascer, cada FK confere todas as linhas
-- (inclusive payload_expired), e uma divergência aborta a migration.
alter table private.idempotency_records
  add constraint idempotency_records_operation_fkey
    foreign key (operation) references private.idempotency_operations (operation),
  add constraint idempotency_records_outcome_code_fkey
    foreign key (operation, outcome_code)
    references private.idempotency_operation_results (operation, logical_result),
  add constraint idempotency_records_resource_type_fkey
    foreign key (operation, resource_type)
    references private.idempotency_operations (operation, resource_type);

alter table private.idempotency_records
  drop constraint idempotency_records_operation_check,
  drop constraint idempotency_records_outcome_code_check,
  drop constraint idempotency_records_resource_type_check;

-- ---------------------------------------------------------------------------
-- Helpers da família group e gatilho de conclusão, lendo a tabela
-- ---------------------------------------------------------------------------
-- Corpos iguais aos da 0032; só a lista de operações e o mapeamento de recurso
-- passam a vir de idempotency_operations (P-B: os helpers de identidade e de
-- conta ficam como estão).
create or replace function private.acquire_group_idempotency(
  p_actor_key text,
  p_operation text,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer
)
returns table (
  acquired boolean,
  record_state text,
  outcome_code text,
  resource_type text,
  resource_id uuid,
  outcome jsonb
)
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_inserted boolean := false;
  v_wait_timeout_ms bigint;
  v_previous_lock_timeout text;
  v_record private.idempotency_records%rowtype;
begin
  if current_setting('transaction_isolation') <> 'read committed'
     or p_actor_key is null or p_operation is null or p_request_id is null
     or p_input_hmac is null
     or not exists (
       select 1 from private.idempotency_operations as operations
       where operations.operation = p_operation and operations.family = 'group'
     )
     or p_canonical_version is distinct from 1
     or p_hash_key_version is null or p_hash_key_version not between 1 and 32767
     or p_input_hmac !~ '^[0-9a-f]{64}$'
     or p_actor_key
        !~ '^profile:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  begin
    v_actor_id := substring(p_actor_key from 9)::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;

  if p_actor_key <> 'profile:' || v_actor_id::text
     or not exists (select 1 from public.profiles where id = v_actor_id) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  select limit_value into v_wait_timeout_ms
  from private.app_limits where limit_key = 'idempotency_wait_timeout_ms';
  if v_wait_timeout_ms is null or v_wait_timeout_ms <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  v_previous_lock_timeout := current_setting('lock_timeout');
  begin
    perform set_config('lock_timeout', v_wait_timeout_ms::text || 'ms', true);
    insert into private.idempotency_records (
      actor_key, actor_id, operation, request_id, request_hash,
      canonical_version, hash_key_version
    ) values (
      p_actor_key, v_actor_id, p_operation, p_request_id, p_input_hmac,
      p_canonical_version::smallint, p_hash_key_version::smallint
    )
    on conflict (actor_key, operation, request_id) do nothing
    returning true into v_inserted;
    perform set_config('lock_timeout', v_previous_lock_timeout, true);
  exception when lock_not_available then
    perform set_config('lock_timeout', v_previous_lock_timeout, true);
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_WAIT_TIMEOUT';
  end;

  if v_inserted then
    return query select true, 'executing_uncommitted'::text, null::text,
      null::text, null::uuid, null::jsonb;
    return;
  end if;

  select records.* into strict v_record
  from private.idempotency_records as records
  where records.actor_key = p_actor_key
    and records.operation = p_operation
    and records.request_id = p_request_id;

  if v_record.request_hash <> p_input_hmac
     or v_record.canonical_version <> p_canonical_version
     or v_record.hash_key_version <> p_hash_key_version then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
  end if;
  if v_record.state = 'payload_expired' then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_EXPIRED';
  elsif v_record.state = 'executing_uncommitted' then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_WAIT_TIMEOUT';
  end if;

  return query select false, v_record.state, v_record.outcome_code,
    v_record.resource_type, v_record.resource_id, v_record.outcome;
end;
$function$;

create or replace function private.complete_group_idempotency(
  p_actor_key text,
  p_operation text,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_outcome jsonb
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_operation private.idempotency_operations%rowtype;
  v_resource_type text;
  v_resource_key text;
begin
  select operations.* into v_operation
  from private.idempotency_operations as operations
  where operations.operation = p_operation and operations.family = 'group';
  if p_operation is null or not found then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  perform private.validate_idempotency_outcome(p_operation, p_outcome);
  begin
    v_actor_id := substring(p_actor_key from 9)::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;
  -- The resource comes from the operation's row (D63.5): its type, the
  -- outcome key that names it, and whether it must be the actor.
  v_resource_type := v_operation.resource_type;
  v_resource_key := v_operation.resource_key;
  if v_operation.resource_is_actor
     and (p_outcome ->> v_resource_key)::uuid is distinct from v_actor_id then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  update private.idempotency_records as records
  set state = 'completed',
      outcome_code = p_outcome ->> 'logical_result',
      resource_type = v_resource_type,
      resource_id = (p_outcome ->> v_resource_key)::uuid,
      outcome = p_outcome,
      updated_at = now(),
      completed_at = now()
  where records.actor_key = p_actor_key
    and records.actor_id = v_actor_id
    and records.operation = p_operation
    and records.request_id = p_request_id
    and records.request_hash = p_input_hmac
    and records.canonical_version = p_canonical_version
    and records.hash_key_version = p_hash_key_version
    and records.state = 'executing_uncommitted';

  if not found then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
  end if;
end;
$function$;

revoke all on function private.acquire_group_idempotency(text, text, uuid, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.complete_group_idempotency(text, text, uuid, text, integer, integer, jsonb) from public, anon, authenticated, service_role;

create or replace function private.enforce_idempotency_conclusion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare v_record private.idempotency_records%rowtype;
begin
  if tg_op = 'DELETE' then
    if old.state = 'executing_uncommitted' then
      raise exception using errcode = '23514', message = 'IDEMPOTENCY_INCOMPLETE';
    end if;
    return null;
  end if;
  if tg_op = 'INSERT' and new.state <> 'executing_uncommitted' then
    raise exception using errcode = '23514', message = 'IDEMPOTENCY_TRANSITION_INVALID';
  end if;
  if tg_op = 'UPDATE' and not ((old.state = 'executing_uncommitted' and new.state = 'completed')
      or (old.state = 'completed' and new.state = 'payload_expired')) then
    raise exception using errcode = '23514', message = 'IDEMPOTENCY_TRANSITION_INVALID';
  end if;
  select records.* into v_record from private.idempotency_records records
  where records.actor_key = new.actor_key and records.operation = new.operation
    and records.request_id = new.request_id;
  if found and v_record.state = 'executing_uncommitted' then
    raise exception using errcode = '23514', message = 'IDEMPOTENCY_INCOMPLETE';
  end if;
  if found and v_record.state = 'completed' then
    perform private.check_idempotency_conclusion(v_record);
  end if;
  return null;
end;
$function$;

revoke all on function private.enforce_idempotency_conclusion()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fim da cadeia: os 13 elos saem (só a própria cadeia os chamava)
-- ---------------------------------------------------------------------------
drop function private.validate_m1a_idempotency_outcome(text, jsonb);
drop function private.validate_through_account_deletion_outcome(text, jsonb);
drop function private.validate_through_data_export_outcome(text, jsonb);
drop function private.validate_through_group_membership_outcome(text, jsonb);
drop function private.validate_through_group_invites_outcome(text, jsonb);
drop function private.validate_through_rename_group_outcome(text, jsonb);
drop function private.validate_through_create_match_outcome(text, jsonb);
drop function private.validate_through_match_players_outcome(text, jsonb);
drop function private.validate_through_group_appearance_outcome(text, jsonb);
drop function private.validate_through_edit_cancel_match_outcome(text, jsonb);
drop function private.validate_through_delete_group_outcome(text, jsonb);
drop function private.validate_through_photos_outcome(text, jsonb);
drop function private.validate_through_ratings_outcome(text, jsonb);

commit;
