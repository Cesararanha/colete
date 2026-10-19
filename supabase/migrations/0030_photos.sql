-- Fatia 0030: foto de perfil e foto do grupo (PR K, item 6 do feedback do
-- César; decisões humanas de 19/10/2026, docs/13 §5.0.9 e docs/25 §3.3).
--
-- Quem troca e remove: a foto de perfil, a própria pessoa; a do grupo, só o
-- dono ativo, como o ícone (0027). Quem vê: a própria pessoa e quem divide
-- com ela ao menos um grupo ativo; a do grupo, só os membros ativos. A prévia
-- do convite (0026/0027) não muda: continua só com o ícone e a cor.
--
-- O caminho do objeto é decidido aqui, nunca pelo app:
--   avatars/<profile_id>/<upload_id>.jpg
--   group-photos/<group_id>/<upload_id>.jpg
-- A Edge groups abre a sessão de envio (begin_photo_upload), gera a URL de
-- upload assinada para esse caminho, confere o objeto enviado (JPEG, tamanho,
-- dimensão, sem Exif/XMP/IPTC) e só então troca a foto (set_*_photo). A
-- leitura é por URL assinada curta, emitida pela Edge depois de
-- get_visible_photos conferir a regra de quem vê.
--
-- Todo objeto que deixa de ser a foto corrente (trocado, removido ou enviado
-- e nunca confirmado) vira uma linha de private.photo_uploads e um
-- delete_storage_object de resource_type photo_upload, executado pelo handler
-- genérico do worker. docs/25 §3.3: o tipo entra na lista fechada de
-- private.deletion_has_pending_storage nesta mesma migration, e a exclusão de
-- conta só libera o Auth quando nenhum objeto da pessoa sobrou.
--
-- Funções redefinidas, cada uma a partir do texto vivo anterior:
--   0015: deletion_has_pending_storage, sync_deletion_failure_from_effect,
--         worker_get_deletion_effect_target, worker_confirm_deletion_effect,
--         worker_get_data_export_build_target (o harness db:test:groups passa
--         a compará-las com este arquivo);
--   0017: worker_job_slot, worker_execute_database_job;
--   0029: acquire/complete_group_idempotency, enforce_idempotency_conclusion.
begin;

-- ---------------------------------------------------------------------------
-- Limites
-- ---------------------------------------------------------------------------
-- O tamanho e o tipo vivem no próprio bucket (o Storage recusa o resto) e são
-- conferidos de novo pela Edge antes da troca. Aqui ficam os prazos da sessão
-- de envio e o teto de sessões abertas por pessoa.
insert into private.app_limits (limit_key, limit_value, unit, notes) values
  ('photo_upload_commit_seconds', 900, 'seconds',
   'Prazo para confirmar uma sessão de envio de foto depois de aberta.'),
  ('photo_upload_reclaim_seconds', 7500, 'seconds',
   'Depois deste prazo o objeto de uma sessão não confirmada é apagado. Precisa '
   'ser maior que a validade da URL de upload assinada do Storage (2 h no '
   'hospedado): a Edge recusa entregar uma URL que viva além dele.'),
  ('photo_upload_max_pending', 10, 'attempts',
   'Sessões de envio de foto ainda abertas por pessoa; a seguinte recusa com '
   'RATE_LIMITED.');

-- ---------------------------------------------------------------------------
-- Buckets privados
-- ---------------------------------------------------------------------------
-- Sem policy de cliente em storage.objects: anon e authenticated não leem nem
-- escrevem; a leitura sai por URL assinada da Edge e o envio por URL de upload
-- assinada para o caminho decidido acima. service_role ignora RLS do Storage
-- por desenho da plataforma, mas não os limites do bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 1048576, array['image/jpeg']::text[]);

-- O bucket nasceu na 0015 sem limites, à espera do produtor.
update storage.buckets
set file_size_limit = 1048576, allowed_mime_types = array['image/jpeg']::text[]
where id = 'group-photos';

-- ---------------------------------------------------------------------------
-- Objetos que não são a foto corrente
-- ---------------------------------------------------------------------------
-- Tabela privada de serviço, sem RLS (docs/14 §5.2); os defaults da 0004 a
-- fazem nascer sem privilégio. A foto corrente continua só em
-- profiles.photo_url e groups.photo_url, que a 0012/0015 já cobrem na
-- exclusão. Uma linha aqui é um objeto que pode existir no Storage e não é a
-- foto de ninguém:
--   pending  sessão aberta; o objeto pode ainda não ter chegado;
--   retired  foto trocada, removida ou sessão vencida, com o apagamento
--            enfileirado;
--   deleted  ausência confirmada pelo worker; o caminho já foi apagado e a
--            linha fica um dia só para o efeito terminal achar o pedido de
--            exclusão de conta.
-- profile_id é a pessoa cuja exclusão de conta espera por este objeto: quem
-- abriu a sessão, ou a dona do avatar trocado. A foto trocada de um grupo não
-- pertence a uma pessoa e fica sem profile_id.
create table private.photo_uploads (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('profile_avatar', 'group_photo')),
  profile_id    uuid references public.profiles (id),
  group_id      uuid references public.groups (id),
  object_path   text unique
                check (object_path is null or object_path ~ '^[a-z0-9][a-z0-9/._-]{0,250}$'),
  state         text not null default 'pending'
                check (state in ('pending', 'retired', 'deleted')),
  created_at    timestamptz not null default now(),
  commit_before timestamptz,
  reclaim_after timestamptz,
  retired_at    timestamptz,
  deleted_at    timestamptz,
  constraint photo_uploads_subject_check
    check ((kind = 'group_photo') = (group_id is not null)
           and (kind = 'group_photo' or profile_id is not null)),
  constraint photo_uploads_pending_check
    check (state <> 'pending'
           or (profile_id is not null and object_path is not null
               and commit_before is not null and reclaim_after is not null
               and commit_before < reclaim_after
               and retired_at is null and deleted_at is null)),
  constraint photo_uploads_retired_check
    check (state <> 'retired'
           or (object_path is not null and retired_at is not null and deleted_at is null)),
  constraint photo_uploads_deleted_check
    check (state <> 'deleted' or (object_path is null and deleted_at is not null))
);

comment on table private.photo_uploads is
  'Objetos de foto que não são a foto corrente (0030). Caminho decidido pelo banco; nunca concedido a cliente.';

create index photo_uploads_open_by_profile_idx on private.photo_uploads (profile_id)
  where state in ('pending', 'retired');
create index photo_uploads_reclaim_idx on private.photo_uploads (reclaim_after)
  where state = 'pending';

-- Enfileira o apagamento de um objeto que deixou de ser foto. A chave é por
-- linha: um objeto, uma intenção. O caminho nunca entra na chave.
create function private.retire_photo_object(
  p_kind text, p_profile_id uuid, p_group_id uuid, p_object_path text
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_id uuid;
begin
  insert into private.photo_uploads (kind, profile_id, group_id, object_path, state, retired_at)
  values (p_kind, p_profile_id, p_group_id, p_object_path, 'retired', now())
  returning id into v_id;
  insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
  values ('delete_storage_object', 'photo_upload', v_id,
          'delete_storage_object:photo_upload:' || v_id::text)
  on conflict (dedupe_key) do nothing;
  return v_id;
end;
$function$;

revoke all on function private.retire_photo_object(text, uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Livro de idempotência: lista fechada de operações e desfechos
-- ---------------------------------------------------------------------------
-- Todas as operações e todos os desfechos que já existem continuam, inclusive
-- set_group_appearance (0027), update_match e cancel_match (0028) e
-- delete_group (0029).
alter table private.idempotency_records
  drop constraint idempotency_records_operation_check,
  drop constraint idempotency_records_outcome_code_check;
alter table private.idempotency_records
  add constraint idempotency_records_operation_check check (operation in (
    'complete_profile', 'update_profile', 'accept_policies',
    'revoke_current_session', 'delete_account', 'request_data_export',
    'approve_member', 'remove_member', 'set_role', 'set_monthly',
    'set_ratings_visibility', 'transfer_ownership', 'leave_group',
    'create_group', 'join_by_code', 'join_by_invite',
    'revoke_group_invite', 'regenerate_group_invite', 'issue_group_invite',
    'rename_group', 'create_match', 'join_match', 'leave_match',
    'set_match_payment', 'set_group_appearance', 'update_match', 'cancel_match',
    'delete_group', 'begin_photo_upload', 'set_profile_photo',
    'remove_profile_photo', 'set_group_photo', 'remove_group_photo'
  )),
  add constraint idempotency_records_outcome_code_check check (
    outcome_code is null or outcome_code in (
      'profile_created', 'profile_updated', 'policies_accepted',
      'session_revoked', 'deletion_requested', 'data_export_requested',
      'member_approved', 'member_refused', 'member_removed', 'role_set',
      'monthly_set', 'ratings_visibility_set', 'ownership_transferred',
      'group_left', 'group_created', 'membership_requested',
      'membership_reentry_requested', 'membership_request_unchanged',
      'membership_already_active', 'invite_revoked',
      'invite_revocation_unchanged', 'invite_regenerated', 'invite_issued',
      'group_renamed', 'match_created', 'match_joined', 'match_waitlisted',
      'match_join_unchanged', 'match_left', 'match_leave_unchanged',
      'payment_marked_paid', 'payment_marked_unpaid', 'payment_unchanged',
      'group_appearance_set', 'match_updated', 'match_canceled',
      'match_cancel_unchanged', 'group_deleted', 'photo_upload_started',
      'profile_photo_set', 'profile_photo_removed', 'profile_photo_unchanged',
      'group_photo_set', 'group_photo_removed', 'group_photo_unchanged'
    )
  );

-- O recurso da sessão de envio é a própria sessão: o vocabulário fechado de
-- recursos (0016) cresce de forma append-only.
alter table private.idempotency_records
  drop constraint idempotency_records_resource_type_check;
alter table private.idempotency_records
  add constraint idempotency_records_resource_type_check check (
    resource_type is null or resource_type in (
      'profile', 'auth_session', 'deletion_request', 'data_export', 'group', 'photo_upload'
    )
  );

alter function private.validate_idempotency_outcome(text, jsonb)
  rename to validate_through_delete_group_outcome;

-- O desfecho guarda só IDs estáveis e o resultado lógico: nenhum caminho,
-- prazo, tamanho ou URL. A sessão, a foto e o prazo correntes são projeção
-- fresca em current.
create function private.validate_idempotency_outcome(p_operation text, p_outcome jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_key text;
  v_results text[];
  v_id uuid;
begin
  if p_operation not in ('begin_photo_upload', 'set_profile_photo', 'remove_profile_photo',
                         'set_group_photo', 'remove_group_photo') then
    perform private.validate_through_delete_group_outcome(p_operation, p_outcome);
    return;
  end if;
  v_key := case p_operation
    when 'begin_photo_upload' then 'upload_id'
    when 'set_profile_photo' then 'profile_id'
    when 'remove_profile_photo' then 'profile_id'
    else 'group_id' end;
  v_results := case p_operation
    when 'begin_photo_upload' then array['photo_upload_started']
    when 'set_profile_photo' then array['profile_photo_set']
    when 'remove_profile_photo' then array['profile_photo_removed', 'profile_photo_unchanged']
    when 'set_group_photo' then array['group_photo_set']
    else array['group_photo_removed', 'group_photo_unchanged'] end;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
        is distinct from (select array_agg(key order by key)
                          from unnest(array[v_key, 'logical_result']) as key)
     or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
     or not (p_outcome ->> 'logical_result' = any (v_results))
     or jsonb_typeof(p_outcome -> v_key) <> 'string'
     or p_outcome ->> v_key
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  begin
    v_id := (p_outcome ->> v_key)::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;
  if p_outcome ->> v_key <> v_id::text then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
end;
$function$;

revoke all on function private.validate_through_delete_group_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;

-- Corpo idêntico ao da 0029; somente a lista de operações ganha as cinco da
-- foto.
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
     or p_operation not in ('approve_member', 'remove_member', 'set_role', 'set_monthly',
                            'set_ratings_visibility', 'transfer_ownership', 'leave_group',
                            'create_group', 'join_by_code', 'join_by_invite',
                            'revoke_group_invite', 'regenerate_group_invite', 'issue_group_invite',
                            'rename_group', 'create_match', 'join_match',
                            'leave_match', 'set_match_payment',
                            'set_group_appearance', 'update_match', 'cancel_match',
                            'delete_group', 'begin_photo_upload', 'set_profile_photo',
                            'remove_profile_photo', 'set_group_photo', 'remove_group_photo')
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

-- O recurso da sessão de envio é a própria sessão; o da foto de perfil, o
-- perfil (como complete_profile); o da foto do grupo, o grupo.
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
  v_resource_type text;
  v_resource_key text;
begin
  if p_operation is null
     or p_operation not in ('approve_member', 'remove_member', 'set_role', 'set_monthly',
                            'set_ratings_visibility', 'transfer_ownership', 'leave_group',
                            'create_group', 'join_by_code', 'join_by_invite',
                            'revoke_group_invite', 'regenerate_group_invite', 'issue_group_invite',
                            'rename_group', 'create_match', 'join_match',
                            'leave_match', 'set_match_payment',
                            'set_group_appearance', 'update_match', 'cancel_match',
                            'delete_group', 'begin_photo_upload', 'set_profile_photo',
                            'remove_profile_photo', 'set_group_photo', 'remove_group_photo') then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  perform private.validate_idempotency_outcome(p_operation, p_outcome);
  begin
    v_actor_id := substring(p_actor_key from 9)::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;
  if p_operation = 'begin_photo_upload' then
    v_resource_type := 'photo_upload';
    v_resource_key := 'upload_id';
  elsif p_operation in ('set_profile_photo', 'remove_profile_photo') then
    v_resource_type := 'profile';
    v_resource_key := 'profile_id';
    if (p_outcome ->> 'profile_id')::uuid is distinct from v_actor_id then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  else
    v_resource_type := 'group';
    v_resource_key := 'group_id';
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
  if tg_op='DELETE' then
    if old.state='executing_uncommitted' then raise exception using errcode='23514',message='IDEMPOTENCY_INCOMPLETE'; end if;
    return null;
  end if;
  if tg_op='INSERT' and new.state<>'executing_uncommitted' then
    raise exception using errcode='23514',message='IDEMPOTENCY_TRANSITION_INVALID';
  end if;
  if tg_op='UPDATE' and not ((old.state='executing_uncommitted' and new.state='completed')
      or (old.state='completed' and new.state='payload_expired')) then
    raise exception using errcode='23514',message='IDEMPOTENCY_TRANSITION_INVALID';
  end if;
  select records.* into v_record from private.idempotency_records records
  where records.actor_key=new.actor_key and records.operation=new.operation
    and records.request_id=new.request_id;
  if found and v_record.state='executing_uncommitted' then
    raise exception using errcode='23514',message='IDEMPOTENCY_INCOMPLETE';
  end if;
  if found and v_record.state='completed' then
    perform private.validate_idempotency_outcome(v_record.operation,v_record.outcome);
    if v_record.outcome_code <> v_record.outcome ->> 'logical_result'
       or (v_record.operation='complete_profile' and (v_record.resource_type<>'profile'
         or v_record.resource_id<>v_record.actor_id or v_record.resource_id<>(v_record.outcome->>'profile_id')::uuid))
       or (v_record.operation in ('update_profile','accept_policies') and (v_record.resource_type is not null or v_record.resource_id is not null))
       or (v_record.operation='revoke_current_session' and (v_record.resource_type<>'auth_session' or v_record.resource_id<>(v_record.outcome->>'session_id')::uuid))
       or (v_record.operation='delete_account' and (v_record.resource_type<>'deletion_request' or v_record.resource_id<>(v_record.outcome->>'deletion_request_id')::uuid))
       or (v_record.operation='request_data_export' and (v_record.resource_type<>'data_export' or v_record.resource_id<>(v_record.outcome->>'export_id')::uuid))
       or (v_record.operation in ('approve_member','remove_member','set_role','set_monthly',
                                  'set_ratings_visibility','transfer_ownership','leave_group',
                                  'create_group','join_by_code','join_by_invite',
                                  'revoke_group_invite','regenerate_group_invite','issue_group_invite',
                                  'rename_group','create_match','join_match','leave_match',
                                  'set_match_payment','set_group_appearance','update_match',
                                  'cancel_match','delete_group','set_group_photo',
                                  'remove_group_photo')
           and (v_record.resource_type is distinct from 'group'
                or v_record.resource_id is distinct from (v_record.outcome->>'group_id')::uuid))
       or (v_record.operation='begin_photo_upload'
           and (v_record.resource_type is distinct from 'photo_upload'
                or v_record.resource_id is distinct from (v_record.outcome->>'upload_id')::uuid))
       or (v_record.operation in ('set_profile_photo','remove_profile_photo')
           and (v_record.resource_type is distinct from 'profile'
                or v_record.resource_id is distinct from v_record.actor_id
                or v_record.resource_id is distinct from (v_record.outcome->>'profile_id')::uuid)) then
      raise exception using errcode='23514',message='IDEMPOTENCY_OUTCOME_INVALID';
    end if;
  end if;
  return null;
end;
$function$;

revoke all on function private.enforce_idempotency_conclusion() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- begin_photo_upload(target, group_id, request_id)
-- ---------------------------------------------------------------------------
-- target 'profile' abre uma sessão para a foto da própria pessoa (group_id
-- nulo); 'group', para a foto de um grupo de que o ator é o dono ativo. O
-- caminho, os prazos e o ID nascem aqui. A sessão não troca foto nenhuma:
-- set_*_photo é que troca, depois de a Edge conferir o objeto. O outcome
-- guarda só o ID da sessão; caminho e prazos saem em current, que a Edge
-- consome e nunca devolve ao cliente além da URL assinada.
create function public.begin_photo_upload(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_target text, p_group_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_actor_key text;
  v_acquired record;
  v_outcome jsonb;
  v_upload private.photo_uploads%rowtype;
  v_upload_id uuid;
  v_commit_seconds bigint;
  v_reclaim_seconds bigint;
  v_max_pending bigint;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_target is null or p_target not in ('profile', 'group')
     or (p_target = 'profile') <> (p_group_id is null) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'begin_photo_upload', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  -- Travas perfil próprio → grupo → membership própria, FOR NO KEY UPDATE
  -- (M2-D13): nenhuma destas linhas é apagada aqui. Como as demais mutações de
  -- grupo depois da correção da 0029, o grupo apagado é decidido antes de
  -- qualquer espera, pelo mesmo caminho de um ID desconhecido.
  perform 1 from public.profiles where id = v_actor_id for no key update;
  if p_target = 'group' then
    perform 1 from public.groups where id = p_group_id and not private.is_group_deleted(id)
      for no key update;
    perform 1 from public.group_members
      where group_id = p_group_id and profile_id = v_actor_id
        and not private.is_group_deleted(group_id) for no key update;
  end if;
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  if p_target = 'group' then
    begin
      if private.group_actor_authority(p_group_id, v_actor_id) <> 'owner' then
        raise exception using errcode = '42501', message = 'OWNER_ONLY';
      end if;
      perform private.require_group_not_suspended(p_group_id);
    exception when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm in
        ('NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER', 'OWNER_ONLY', 'GROUP_SUSPENDED') then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
    end;
  end if;

  if not v_acquired.acquired then
    -- Replay: a sessão só volta se ainda puder receber o objeto.
    select upload.* into v_upload from private.photo_uploads as upload
    where upload.id = (v_acquired.outcome ->> 'upload_id')::uuid
      and upload.state = 'pending' and upload.commit_before > now();
    return jsonb_build_object('outcome', v_acquired.outcome,
      'current', case when found then jsonb_build_object(
        'upload_id', v_upload.id,
        'bucket', case v_upload.kind when 'profile_avatar' then 'avatars' else 'group-photos' end,
        'path', v_upload.object_path,
        'commit_before', v_upload.commit_before,
        'reclaim_after', v_upload.reclaim_after) end);
  end if;

  select max(limit_value) filter (where limit_key = 'photo_upload_commit_seconds'),
         max(limit_value) filter (where limit_key = 'photo_upload_reclaim_seconds'),
         max(limit_value) filter (where limit_key = 'photo_upload_max_pending')
  into v_commit_seconds, v_reclaim_seconds, v_max_pending
  from private.app_limits
  where limit_key in ('photo_upload_commit_seconds', 'photo_upload_reclaim_seconds',
                      'photo_upload_max_pending');
  if v_commit_seconds is null or v_commit_seconds <= 0
     or v_reclaim_seconds is null or v_reclaim_seconds <= v_commit_seconds
     or v_max_pending is null or v_max_pending <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  -- O perfil está travado: duas sessões novas da mesma pessoa contam em série.
  if (select count(*) from private.photo_uploads
      where profile_id = v_actor_id and state = 'pending' and commit_before > now())
     >= v_max_pending then
    raise exception using errcode = 'P0001', message = 'RATE_LIMITED';
  end if;

  v_upload_id := gen_random_uuid();
  insert into private.photo_uploads (
    id, kind, profile_id, group_id, object_path, state, commit_before, reclaim_after
  ) values (
    v_upload_id,
    case p_target when 'profile' then 'profile_avatar' else 'group_photo' end,
    v_actor_id, p_group_id,
    case p_target when 'profile' then v_actor_id::text else p_group_id::text end
      || '/' || v_upload_id::text || '.jpg',
    'pending',
    now() + make_interval(secs => v_commit_seconds::integer),
    now() + make_interval(secs => v_reclaim_seconds::integer)
  )
  returning * into v_upload;

  v_outcome := jsonb_build_object('upload_id', v_upload_id::text,
    'logical_result', 'photo_upload_started');
  perform private.complete_group_idempotency(
    v_actor_key, 'begin_photo_upload', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome,
    'current', jsonb_build_object(
      'upload_id', v_upload.id,
      'bucket', case v_upload.kind when 'profile_avatar' then 'avatars' else 'group-photos' end,
      'path', v_upload.object_path,
      'commit_before', v_upload.commit_before,
      'reclaim_after', v_upload.reclaim_after));
end;
$function$;

-- ---------------------------------------------------------------------------
-- set_profile_photo(upload_id, request_id) / remove_profile_photo(request_id)
-- ---------------------------------------------------------------------------
-- Só a própria pessoa, conta active. A sessão precisa ser dela, de foto de
-- perfil, aberta e dentro do prazo; qualquer outra coisa é NOT_FOUND, sem
-- dizer qual. A Edge confere o objeto antes de chamar. A foto anterior, se
-- houver, sai de profiles.photo_url para private.photo_uploads com o
-- apagamento enfileirado. Travas perfil → sessão; a sessão é apagada, por
-- isso FOR UPDATE.
create function public.set_profile_photo(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_upload_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_actor_key text;
  v_acquired record;
  v_outcome jsonb;
  v_upload private.photo_uploads%rowtype;
  v_previous text;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_upload_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'set_profile_photo', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  select photo_url into v_previous from public.profiles where id = v_actor_id for no key update;
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome,
      'current', jsonb_build_object('has_photo', v_previous is not null));
  end if;

  select upload.* into v_upload from private.photo_uploads as upload
  where upload.id = p_upload_id for update;
  if not found or v_upload.kind <> 'profile_avatar' or v_upload.profile_id <> v_actor_id
     or v_upload.state <> 'pending' or v_upload.commit_before <= now() then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;

  delete from private.photo_uploads where id = v_upload.id;
  update public.profiles set photo_url = v_upload.object_path where id = v_actor_id;
  if v_previous is not null then
    perform private.retire_photo_object('profile_avatar', v_actor_id, null, v_previous);
  end if;

  v_outcome := jsonb_build_object('profile_id', v_actor_id::text,
    'logical_result', 'profile_photo_set');
  perform private.complete_group_idempotency(
    v_actor_key, 'set_profile_photo', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome,
    'current', jsonb_build_object('has_photo', true));
end;
$function$;

create function public.remove_profile_photo(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_actor_key text;
  v_acquired record;
  v_outcome jsonb;
  v_previous text;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'remove_profile_photo', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  select photo_url into v_previous from public.profiles where id = v_actor_id for no key update;
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome,
      'current', jsonb_build_object('has_photo', v_previous is not null));
  end if;

  if v_previous is null then
    v_outcome := jsonb_build_object('profile_id', v_actor_id::text,
      'logical_result', 'profile_photo_unchanged');
  else
    update public.profiles set photo_url = null where id = v_actor_id;
    perform private.retire_photo_object('profile_avatar', v_actor_id, null, v_previous);
    v_outcome := jsonb_build_object('profile_id', v_actor_id::text,
      'logical_result', 'profile_photo_removed');
  end if;
  perform private.complete_group_idempotency(
    v_actor_key, 'remove_profile_photo', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome,
    'current', jsonb_build_object('has_photo', false));
end;
$function$;

-- ---------------------------------------------------------------------------
-- set_group_photo(group_id, upload_id, request_id) / remove_group_photo(group_id, request_id)
-- ---------------------------------------------------------------------------
-- Somente o dono com membership active, como set_group_appearance (0027):
-- organizador e jogador recebem OWNER_ONLY, quem não é mais membro NOT_MEMBER,
-- grupo suspenso GROUP_SUSPENDED, arquivado GROUP_ARCHIVED e apagado
-- GROUP_DELETED (a Edge o devolve como NOT_FOUND), decidido antes de esperar
-- qualquer trava do grupo, como na 0029. A sessão precisa ser do próprio dono,
-- para este grupo. Travas perfil → grupo → membership própria → sessão.
create function public.set_group_photo(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_group_id uuid, p_upload_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_actor_key text;
  v_acquired record;
  v_outcome jsonb;
  v_upload private.photo_uploads%rowtype;
  v_previous text;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_group_id is null or p_upload_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'set_group_photo', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  perform 1 from public.profiles where id = v_actor_id for no key update;
  select photo_url into v_previous from public.groups
    where id = p_group_id and not private.is_group_deleted(id) for no key update;
  perform 1 from public.group_members
    where group_id = p_group_id and profile_id = v_actor_id
      and not private.is_group_deleted(group_id) for no key update;
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  begin
    if private.group_actor_authority(p_group_id, v_actor_id) <> 'owner' then
      raise exception using errcode = '42501', message = 'OWNER_ONLY';
    end if;
    perform private.require_group_not_suspended(p_group_id);
  exception when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
    if not v_acquired.acquired and sqlerrm in
      ('NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER', 'OWNER_ONLY', 'GROUP_SUSPENDED') then
      return jsonb_build_object('outcome', v_acquired.outcome);
    end if;
    raise;
  end;

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome,
      'current', jsonb_build_object('group_id', p_group_id, 'has_photo', v_previous is not null));
  end if;

  select upload.* into v_upload from private.photo_uploads as upload
  where upload.id = p_upload_id for update;
  if not found or v_upload.kind <> 'group_photo' or v_upload.group_id <> p_group_id
     or v_upload.profile_id <> v_actor_id
     or v_upload.state <> 'pending' or v_upload.commit_before <= now() then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;

  delete from private.photo_uploads where id = v_upload.id;
  update public.groups set photo_url = v_upload.object_path where id = p_group_id;
  if v_previous is not null then
    perform private.retire_photo_object('group_photo', null, p_group_id, v_previous);
  end if;

  v_outcome := jsonb_build_object('group_id', p_group_id::text,
    'logical_result', 'group_photo_set');
  perform private.complete_group_idempotency(
    v_actor_key, 'set_group_photo', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome,
    'current', jsonb_build_object('group_id', p_group_id, 'has_photo', true));
end;
$function$;

create function public.remove_group_photo(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_group_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_actor_key text;
  v_acquired record;
  v_outcome jsonb;
  v_previous text;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_group_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'remove_group_photo', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  perform 1 from public.profiles where id = v_actor_id for no key update;
  select photo_url into v_previous from public.groups
    where id = p_group_id and not private.is_group_deleted(id) for no key update;
  perform 1 from public.group_members
    where group_id = p_group_id and profile_id = v_actor_id
      and not private.is_group_deleted(group_id) for no key update;
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  begin
    if private.group_actor_authority(p_group_id, v_actor_id) <> 'owner' then
      raise exception using errcode = '42501', message = 'OWNER_ONLY';
    end if;
    perform private.require_group_not_suspended(p_group_id);
  exception when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
    if not v_acquired.acquired and sqlerrm in
      ('NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER', 'OWNER_ONLY', 'GROUP_SUSPENDED') then
      return jsonb_build_object('outcome', v_acquired.outcome);
    end if;
    raise;
  end;

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome,
      'current', jsonb_build_object('group_id', p_group_id, 'has_photo', v_previous is not null));
  end if;

  if v_previous is null then
    v_outcome := jsonb_build_object('group_id', p_group_id::text,
      'logical_result', 'group_photo_unchanged');
  else
    update public.groups set photo_url = null where id = p_group_id;
    perform private.retire_photo_object('group_photo', null, p_group_id, v_previous);
    v_outcome := jsonb_build_object('group_id', p_group_id::text,
      'logical_result', 'group_photo_removed');
  end if;
  perform private.complete_group_idempotency(
    v_actor_key, 'remove_group_photo', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome,
    'current', jsonb_build_object('group_id', p_group_id, 'has_photo', false));
end;
$function$;

revoke all on function public.begin_photo_upload(uuid, uuid, uuid, text, integer, integer, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.set_profile_photo(uuid, uuid, uuid, text, integer, integer, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.remove_profile_photo(uuid, uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.set_group_photo(uuid, uuid, uuid, text, integer, integer, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.remove_group_photo(uuid, uuid, uuid, text, integer, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_photo_upload(uuid, uuid, uuid, text, integer, integer, text, uuid)
  to service_role;
grant execute on function public.set_profile_photo(uuid, uuid, uuid, text, integer, integer, uuid)
  to service_role;
grant execute on function public.remove_profile_photo(uuid, uuid, uuid, text, integer, integer)
  to service_role;
grant execute on function public.set_group_photo(uuid, uuid, uuid, text, integer, integer, uuid, uuid)
  to service_role;
grant execute on function public.remove_group_photo(uuid, uuid, uuid, text, integer, integer, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Leituras da Edge: a sessão a conferir e as fotos visíveis
-- ---------------------------------------------------------------------------
-- A sessão aberta do próprio ator, ainda no prazo, para a Edge baixar e
-- conferir o objeto antes da troca. Qualquer outra coisa devolve null: a Edge
-- então chama set_*_photo, que recusa uma chamada nova (NOT_FOUND) e devolve o
-- desfecho gravado de um replay.
create function public.get_photo_upload_target(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_upload_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_upload private.photo_uploads%rowtype;
begin
  if p_upload_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor_id := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id);
  select upload.* into v_upload from private.photo_uploads as upload
  where upload.id = p_upload_id and upload.profile_id = v_actor_id
    and upload.state = 'pending' and upload.commit_before > now();
  if not found then return null; end if;
  return jsonb_build_object(
    'kind', v_upload.kind,
    'group_id', v_upload.group_id,
    'bucket', case v_upload.kind when 'profile_avatar' then 'avatars' else 'group-photos' end,
    'path', v_upload.object_path);
end;
$function$;

-- Quem vê (decisão humana de 19/10/2026): a foto de perfil, a própria pessoa
-- e quem divide com ela ao menos um grupo não arquivado em que as duas estão
-- active; a do grupo, os membros active do grupo não arquivado. O grupo
-- apagado (0029) também está arquivado e fica de fora. Conta em exclusão não
-- aparece, como em get_group_members. Os IDs pedidos que não passam somem da
-- resposta, sem dizer por quê. A própria foto vem por p_self, linha 'self':
-- o app nunca manda o próprio ID (docs/22 §6). Trava o próprio perfil como
-- get_group_members, para que a leitura depois do commit de delete_account já
-- veja a conta em exclusão.
create function public.get_visible_photos(
  p_actor_auth_user_id uuid, p_actor_session_id uuid,
  p_profile_ids uuid[], p_group_ids uuid[], p_self boolean
)
returns table (kind text, subject_id uuid, bucket text, object_path text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
begin
  if p_profile_ids is null or p_group_ids is null or p_self is null
     or cardinality(p_profile_ids) > 100 or cardinality(p_group_ids) > 100
     or array_position(p_profile_ids, null) is not null
     or array_position(p_group_ids, null) is not null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id);
  perform 1 from public.profiles p where p.id = v_actor for no key update;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id);
  return query
  select 'self'::text, p.id, 'avatars'::text, p.photo_url
  from public.profiles p
  where p_self and p.id = v_actor and p.photo_url is not null
  union all
  select 'profile'::text, p.id, 'avatars'::text, p.photo_url
  from public.profiles p
  where p.id = any (p_profile_ids)
    and p.photo_url is not null
    and p.account_status not in ('deletion_pending', 'deleted')
    and (p.id = v_actor or exists (
      select 1
      from public.group_members mine
      join public.group_members theirs
        on theirs.group_id = mine.group_id and theirs.profile_id = p.id
       and theirs.status = 'active'
      join public.groups g on g.id = mine.group_id and g.archived_at is null
      where mine.profile_id = v_actor and mine.status = 'active'
        and not private.is_group_deleted(g.id)))
  union all
  select 'group'::text, g.id, 'group-photos'::text, g.photo_url
  from public.groups g
  join public.group_members m
    on m.group_id = g.id and m.profile_id = v_actor and m.status = 'active'
  where g.id = any (p_group_ids)
    and g.photo_url is not null
    and g.archived_at is null
    and not private.is_group_deleted(g.id)
  order by 1, 2;
end;
$function$;

revoke all on function public.get_photo_upload_target(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_visible_photos(uuid, uuid, uuid[], uuid[], boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.get_photo_upload_target(uuid, uuid, uuid) to service_role;
grant execute on function public.get_visible_photos(uuid, uuid, uuid[], uuid[], boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Fence de Storage da exclusão (docs/25 §3.3)
-- ---------------------------------------------------------------------------
-- Lista fechada de 0015, mais photo_upload: o efeito da linha, enquanto não
-- terminal, e a própria linha pending/retired da pessoa, enquanto não tiver
-- efeito dead, seguram o Auth. Uma sessão aberta ainda pode receber o objeto
-- pela URL assinada: o Auth espera o reclaim_after, quando o job a recolhe.
create or replace function private.deletion_has_pending_storage(p_request_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $function$
  with target_request as (
    select request.profile_id
    from private.deletion_requests as request
    where request.id = p_request_id
  ),
  storage_effects as (
    select effect.*
    from private.external_effects as effect
    cross join target_request as request
    where effect.kind in (
      'build_data_export', 'delete_data_export', 'delete_storage_object'
    )
      and (
        (effect.resource_type = 'data_export' and exists (
          select 1 from private.data_exports as export
          where export.id = effect.resource_id
            and export.profile_id = request.profile_id
        ))
        or (effect.resource_type = 'profile_avatar'
            and effect.resource_id = request.profile_id)
        or (effect.resource_type = 'group_photo'
            and effect.dedupe_key = 'delete_storage_object:group_photo:'
                                    || effect.resource_id::text || ':' || p_request_id::text)
        or (effect.resource_type = 'photo_upload' and exists (
          select 1 from private.photo_uploads as upload
          where upload.id = effect.resource_id
            and upload.profile_id = request.profile_id
        ))
      )
  )
  select coalesce(
    exists (
      select 1 from storage_effects
      where status in ('pending', 'leased', 'failed_retryable')
    )
    or exists (
      select 1
      from public.profiles as profile
      cross join target_request as request
      where profile.id = request.profile_id
        and profile.photo_url is not null
        and not exists (
          select 1 from storage_effects
          where resource_type = 'profile_avatar' and status = 'dead'
        )
    )
    or exists (
      select 1
      from private.data_exports as export
      cross join target_request as request
      where export.profile_id = request.profile_id
        and export.storage_path is not null
        and not exists (
          select 1 from storage_effects
          where resource_type = 'data_export'
            and resource_id = export.id
            and status = 'dead'
        )
    )
    or exists (
      select 1
      from public.groups as grp
      cross join target_request as request
      where grp.owner_id = request.profile_id
        and grp.archived_at is not null
        and grp.photo_url is not null
        and not exists (
          select 1 from storage_effects
          where resource_type = 'group_photo'
            and resource_id = grp.id
            and status = 'dead'
        )
    )
    or exists (
      select 1
      from private.photo_uploads as upload
      cross join target_request as request
      where upload.profile_id = request.profile_id
        and upload.state in ('pending', 'retired')
        and not exists (
          select 1 from storage_effects
          where resource_type = 'photo_upload'
            and resource_id = upload.id
            and status = 'dead'
        )
    ),
    false
  );
$function$;

-- Mapeamento efeito → pedido e política terminal da 0015, mais photo_upload:
-- a linha guarda a pessoa (profile_id) até depois da confirmação, e dead
-- registra falha operacional durável, com o caminho mantido só na linha
-- retired porque a ausência não foi confirmada.
create or replace function private.sync_deletion_failure_from_effect()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_request_id uuid;
begin
  if new.kind = 'build_data_export' and new.status = 'dead' then
    -- Upload may have committed before the terminal database failure. The path
    -- is deterministic, so terminal build accounting always becomes a real
    -- absence-confirming purge attempt instead of dropping the object.
    update private.data_exports
    set status = 'failed'
    where id = new.resource_id and status in ('queued', 'building');
    insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
    values ('delete_data_export', 'data_export', new.resource_id,
            'delete_data_export:' || new.resource_id::text)
    on conflict (dedupe_key) do nothing;
  end if;

  if new.resource_type = 'deletion_request' and new.kind = 'delete_auth_user' then
    v_request_id := new.resource_id;
  elsif new.resource_type = 'data_export' then
    select request.id into v_request_id
    from private.data_exports as export
    join private.deletion_requests as request on request.profile_id = export.profile_id
    where export.id = new.resource_id;
  elsif new.resource_type = 'profile_avatar' then
    select id into v_request_id from private.deletion_requests
    where profile_id = new.resource_id;
  elsif new.resource_type = 'group_photo' then
    v_request_id := private.group_photo_deletion_request(new.resource_id, new.dedupe_key);
  elsif new.resource_type = 'photo_upload' then
    select request.id into v_request_id
    from private.photo_uploads as upload
    join private.deletion_requests as request on request.profile_id = upload.profile_id
    where upload.id = new.resource_id;
  end if;

  if v_request_id is null then return new; end if;

  if new.status = 'failed_retryable' then
    update private.deletion_requests
    set status = 'failed_retryable',
        attempts = greatest(attempts, new.attempts),
        next_attempt_at = new.next_attempt_at,
        last_error_code = new.last_error_code
    where id = v_request_id and status <> 'completed';
  elsif new.status = 'dead'
        and new.resource_type in ('data_export', 'profile_avatar', 'group_photo',
                                  'photo_upload') then
    if new.kind = 'delete_data_export' then
      -- The provider never confirmed absence. Keep path/digest, keep purged_at
      -- null, and release the export state honestly as failed.
      update private.data_exports
      set status = 'failed'
      where id = new.resource_id;
    end if;
    update private.deletion_requests
    set status = 'failed_retryable',
        attempts = greatest(attempts, new.attempts),
        next_attempt_at = null,
        last_error_code = new.last_error_code,
        has_operational_failure = true
    where id = v_request_id and status <> 'completed';
  elsif new.status = 'dead' then
    -- Auth dead-letter remains an actionable stalled saga. This item changes
    -- only the human-approved terminal policy for Storage.
    update private.deletion_requests
    set status = 'failed_retryable',
        attempts = greatest(attempts, new.attempts),
        next_attempt_at = null,
        last_error_code = new.last_error_code
    where id = v_request_id and status <> 'completed';
  end if;

  if new.resource_type in ('data_export', 'profile_avatar', 'group_photo', 'photo_upload')
     and new.status in ('pending', 'succeeded', 'dead') then
    perform private.reconcile_deletion_request(v_request_id);
  end if;
  return new;
end;
$function$;

-- Alvo fenced do handler genérico de Storage. photo_upload só é alvo quando a
-- linha está retired: uma sessão aberta nunca é apagada por aqui, e a linha
-- já confirmada (deleted) responde none.
create or replace function public.worker_get_deletion_effect_target(
  p_effect_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_effect private.external_effects%rowtype;
  v_path text;
  v_profile_id uuid;
  v_request_id uuid;
  v_request private.deletion_requests%rowtype;
  v_upload private.photo_uploads%rowtype;
begin
  -- FOR NO KEY UPDATE (M2-D13): esta transação não apaga o efeito nem altera
  -- id ou dedupe_key.
  select effect.* into v_effect from private.external_effects as effect
  where effect.id = p_effect_id for no key update;
  if not found or v_effect.status <> 'leased'
     or v_effect.lease_token <> p_lease_token
     or v_effect.lease_until <= clock_timestamp()
     or v_effect.kind not in ('delete_data_export', 'delete_storage_object', 'delete_auth_user') then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  if v_effect.kind = 'delete_data_export' then
    select coalesce(export.storage_path,
                    'exports/' || export.profile_id::text || '/' || export.id::text || '.zip'),
           export.profile_id
    into v_path, v_profile_id
    from private.data_exports as export
    where export.id = v_effect.resource_id;
    select id into v_request_id from private.deletion_requests
    where profile_id = v_profile_id;
    if v_request_id is not null then
      perform private.reconcile_deletion_request(v_request_id);
    end if;
    return jsonb_build_object('action', case when v_path is null then 'none' else 'storage' end,
      'bucket', 'data-exports', 'path', v_path);
  elsif v_effect.kind = 'delete_storage_object' and v_effect.resource_type = 'profile_avatar' then
    select id into v_request_id from private.deletion_requests
    where profile_id = v_effect.resource_id;
    if v_request_id is not null then
      perform private.reconcile_deletion_request(v_request_id);
    end if;
    select photo_url into v_path from public.profiles where id = v_effect.resource_id;
    return jsonb_build_object('action', case when v_path is null then 'none' else 'storage' end,
      'bucket', 'avatars', 'path', v_path);
  elsif v_effect.kind = 'delete_storage_object' and v_effect.resource_type = 'group_photo' then
    v_request_id := private.group_photo_deletion_request(v_effect.resource_id, v_effect.dedupe_key);
    if v_request_id is null then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    perform private.reconcile_deletion_request(v_request_id);
    select photo_url into v_path from public.groups where id = v_effect.resource_id;
    return jsonb_build_object('action', case when v_path is null then 'none' else 'storage' end,
      'bucket', 'group-photos', 'path', v_path);
  elsif v_effect.kind = 'delete_storage_object' and v_effect.resource_type = 'photo_upload' then
    -- FOR NO KEY UPDATE: a leitura não apaga a linha; a confirmação, sim.
    select upload.* into v_upload from private.photo_uploads as upload
    where upload.id = v_effect.resource_id for no key update;
    if not found or v_upload.state = 'deleted' then
      return jsonb_build_object('action', 'none');
    end if;
    if v_upload.state <> 'retired' then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    select id into v_request_id from private.deletion_requests
    where profile_id = v_upload.profile_id;
    if v_request_id is not null then
      perform private.reconcile_deletion_request(v_request_id);
    end if;
    return jsonb_build_object('action', 'storage',
      'bucket', case v_upload.kind when 'profile_avatar' then 'avatars' else 'group-photos' end,
      'path', v_upload.object_path);
  elsif v_effect.kind = 'delete_auth_user' and v_effect.resource_type = 'deletion_request' then
    select request.* into v_request from private.deletion_requests as request
    where request.id = v_effect.resource_id;
    if found and v_request.status in ('requested', 'failed_retryable') then
      perform private.reconcile_deletion_request(v_effect.resource_id);
      select request.* into v_request from private.deletion_requests as request
      where request.id = v_effect.resource_id;
    end if;
    if not found or v_request.status = 'completed' or v_request.auth_user_id is null then
      return jsonb_build_object('action', 'none', 'deletion_request_id', v_effect.resource_id);
    end if;
    return jsonb_build_object('action', 'auth',
      'auth_user_id', v_request.auth_user_id,
      'deletion_request_id', v_request.id);
  end if;

  raise exception using errcode = '22023', message = 'VALIDATION';
end;
$function$;

-- Confirmador fenced. Depois de o handler observar a ausência do objeto, a
-- linha photo_upload perde o caminho e vira deleted; a pessoa fica na linha
-- para o efeito terminal achar o pedido de exclusão.
create or replace function public.worker_confirm_deletion_effect(
  p_effect_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_effect private.external_effects%rowtype; v_export private.data_exports%rowtype;
        v_profile_id uuid; v_request_id uuid; v_status text;
begin
  -- FOR NO KEY UPDATE no efeito (M2-D13): esta transação não o apaga nem
  -- altera id ou dedupe_key. O export fica em FOR UPDATE, a exceção da regra:
  -- a confirmação zera storage_path, coluna com índice único, e o próprio
  -- UPDATE tomaria FOR UPDATE; travar mais fraco antes seria promover o lock
  -- dentro da transação. A linha photo_upload segue o export: object_path
  -- também tem índice único.
  select effect.* into v_effect from private.external_effects effect where effect.id=p_effect_id for no key update;
  if not found or v_effect.status<>'leased' or v_effect.lease_token<>p_lease_token
     or v_effect.lease_until<=clock_timestamp() then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  if v_effect.kind='delete_data_export' then
    select export.* into v_export from private.data_exports export where export.id=v_effect.resource_id for update;
    if not found then return jsonb_build_object('status','orphan_reconciled'); end if;
    v_profile_id:=v_export.profile_id;
    select id into v_request_id from private.deletion_requests where profile_id=v_profile_id;
    update private.data_exports set
      status=case when v_request_id is not null then 'failed'
                  when v_export.status='downloaded' then 'downloaded'
                  when v_export.status='failed' then 'failed' else 'expired' end,
      storage_path=null,content_digest=null,purged_at=coalesce(purged_at,now())
    where id=v_export.id;
  elsif v_effect.kind='delete_storage_object' and v_effect.resource_type='profile_avatar' then
    v_profile_id:=v_effect.resource_id;
    update public.profiles set photo_url=null where id=v_profile_id;
    select id into v_request_id from private.deletion_requests where profile_id=v_profile_id;
  elsif v_effect.kind='delete_storage_object' and v_effect.resource_type='group_photo' then
    v_request_id:=private.group_photo_deletion_request(v_effect.resource_id,v_effect.dedupe_key);
    if v_request_id is null then raise exception using errcode='22023',message='VALIDATION'; end if;
    update public.groups set photo_url=null where id=v_effect.resource_id;
  elsif v_effect.kind='delete_storage_object' and v_effect.resource_type='photo_upload' then
    select upload.profile_id into v_profile_id from private.photo_uploads upload
    where upload.id=v_effect.resource_id and upload.state in ('retired','deleted') for update;
    if not found then raise exception using errcode='22023',message='VALIDATION'; end if;
    update private.photo_uploads set state='deleted',object_path=null,
      deleted_at=coalesce(deleted_at,now())
    where id=v_effect.resource_id;
    select id into v_request_id from private.deletion_requests where profile_id=v_profile_id;
  elsif v_effect.kind='delete_auth_user' and v_effect.resource_type='deletion_request' then
    v_request_id:=v_effect.resource_id;
    if exists(select 1 from auth.users u join private.deletion_requests r on r.auth_user_id=u.id
      where r.id=v_request_id) then raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
    update private.deletion_requests set status='finalizing',auth_deleted_at=coalesce(auth_deleted_at,now()),
      next_attempt_at=null,last_error_code=null where id=v_request_id and status<>'completed';
    return jsonb_build_object('deletion_request_id',v_request_id,'status','finalizing');
  else raise exception using errcode='22023',message='VALIDATION'; end if;
  if v_request_id is null then return jsonb_build_object('status','orphan_reconciled'); end if;
  v_status:=private.reconcile_deletion_request(v_request_id);
  return jsonb_build_object('deletion_request_id',v_request_id,'status',v_status);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Exportação: a própria foto entra no colete-export-v1 (docs/22 §5.1)
-- ---------------------------------------------------------------------------
-- Corpo da 0015 e o mesmo snapshot, byte a byte, mais 'photo' fora dele: o
-- bucket e o caminho da foto corrente do titular, ou null. O worker baixa o
-- objeto e o grava como profile-photo.jpg no ZIP, enumerado no manifesto. O
-- caminho nunca entra no snapshot nem em um JSON do ZIP.
create or replace function public.worker_get_data_export_build_target(
  p_effect_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_effect private.external_effects%rowtype; v_export private.data_exports%rowtype;
        v_profile public.profiles%rowtype; v_profile_id uuid;
begin
  -- FOR NO KEY UPDATE no efeito, no perfil e no export (M2-D13): esta
  -- transação não apaga nenhuma das três linhas, e o único UPDATE, em
  -- data_exports, muda status e snapshot_at, que não são chave. O lock do
  -- perfil continua conflitando com o de delete_account e com o FOR UPDATE
  -- das funções do M1-B que não são redefinidas aqui.
  select effect.* into v_effect from private.external_effects effect
  where effect.id=p_effect_id for no key update;
  if not found or v_effect.kind<>'build_data_export' or v_effect.status<>'leased'
     or v_effect.lease_token<>p_lease_token or v_effect.lease_until<=clock_timestamp() then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  -- Read only the key needed to acquire the canonical profile -> export lock
  -- order. The export row is deliberately not locked until the profile is.
  select export.profile_id into v_profile_id from private.data_exports export
  where export.id=v_effect.resource_id;
  if not found then return jsonb_build_object('action','none'); end if;
  select profile.* into v_profile from public.profiles profile where profile.id=v_profile_id for no key update;
  if not found then return jsonb_build_object('action','purge'); end if;
  select export.* into v_export from private.data_exports export
  where export.id=v_effect.resource_id and export.profile_id=v_profile_id for no key update;
  if not found then return jsonb_build_object('action','none'); end if;
  if v_export.status in ('failed','expired') then return jsonb_build_object('action','purge'); end if;
  if v_profile.account_status in ('deletion_pending','deleted')
     or v_export.status='cleanup_pending' then return jsonb_build_object('action','purge'); end if;
  if v_export.status='ready' then return jsonb_build_object('action','none'); end if;
  if v_export.status not in ('queued','building') then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  update private.data_exports
  set status=case when status='queued' then 'building' else status end,
      snapshot_at=coalesce(snapshot_at,clock_timestamp())
  where id=v_export.id
  returning * into v_export;
  return jsonb_build_object(
    'action','build','path','exports/'||v_profile.id::text||'/'||v_export.id::text||'.zip',
    'auth_user_id',v_profile.auth_user_id,
    'photo',case when v_profile.photo_url is null then null
      else jsonb_build_object('bucket','avatars','path',v_profile.photo_url) end,
    'snapshot',jsonb_build_object(
      'snapshot_at',to_char(v_export.snapshot_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'profile',jsonb_build_object('id',v_profile.id,'name',v_profile.name,'nickname',v_profile.nickname,
        'position',v_profile.position,'dominant_foot',v_profile.dominant_foot,
        'shirt_number',v_profile.shirt_number,'account_status',v_profile.account_status,'created_at',v_profile.created_at),
      'policy_acceptances',coalesce((select jsonb_agg(jsonb_build_object(
        'document_type',a.document_type,'version',a.version,'source',a.source,'accepted_at',a.accepted_at)
        order by a.document_type,a.version) from public.policy_acceptances a where a.profile_id=v_profile.id),'[]'::jsonb),
      'privacy_requests',coalesce((select jsonb_agg(jsonb_build_object(
        'kind',r.kind,'status',r.status,'response',r.response,
        'opened_at',r.opened_at,'resolved_at',r.resolved_at) order by r.opened_at,r.id)
        from public.privacy_requests r where r.profile_id=v_profile.id),'[]'::jsonb),
      'data_exports',coalesce((select jsonb_agg(jsonb_build_object(
        'id',e.id,'status',e.status,'created_at',e.created_at,'ready_at',e.ready_at,
        'expires_at',e.expires_at,'downloaded_at',e.downloaded_at,'purged_at',e.purged_at)
        order by e.created_at,e.id) from private.data_exports e where e.profile_id=v_profile.id),'[]'::jsonb),
      'groups',coalesce((select jsonb_agg(jsonb_build_object(
        'group_id',m.group_id,'group_name',g.name,'role',m.role,'status',m.status,
        'is_monthly',m.is_monthly,'joined_at',m.joined_at,'removed_at',m.removed_at,
        'removal_count',m.removal_count) order by m.group_id)
        from public.group_members m join public.groups g on g.id=m.group_id
        where m.profile_id=v_profile.id),'[]'::jsonb)
    ));
end;
$function$;

-- ---------------------------------------------------------------------------
-- Job: recolher sessões de envio vencidas
-- ---------------------------------------------------------------------------
-- A cada cinco minutos, a sessão aberta que passou do reclaim_after (a URL de
-- upload assinada já não vale) vira retired com o apagamento enfileirado. A
-- linha deleted há mais de um dia sai: o efeito dela já é terminal.
create function private.reclaim_photo_uploads()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_now timestamptz := now();
  v_scanned bigint;
  v_reclaimed bigint := 0;
  v_purged bigint;
  v_id uuid;
begin
  select count(*) into v_scanned from private.photo_uploads
  where (state = 'pending' and reclaim_after <= v_now)
     or (state = 'deleted' and deleted_at <= v_now - interval '1 day');
  for v_id in
    select id from private.photo_uploads
    where state = 'pending' and reclaim_after <= v_now
    order by reclaim_after, id
    for no key update skip locked
  loop
    update private.photo_uploads
    set state = 'retired', retired_at = v_now
    where id = v_id and state = 'pending';
    insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
    values ('delete_storage_object', 'photo_upload', v_id,
            'delete_storage_object:photo_upload:' || v_id::text)
    on conflict (dedupe_key) do nothing;
    v_reclaimed := v_reclaimed + 1;
  end loop;
  with expired as (
    select id from private.photo_uploads
    where state = 'deleted' and deleted_at <= v_now - interval '1 day'
    order by deleted_at, id
    for update skip locked
  )
  delete from private.photo_uploads as upload
  using expired where upload.id = expired.id;
  get diagnostics v_purged = row_count;
  insert into private.retention_runs
    (policy, window_start, window_end, scanned, purged, failed, started_at, finished_at)
  values ('reclaim_photo_uploads', v_now - interval '1 day', v_now,
          v_scanned::integer, (v_reclaimed + v_purged)::integer, 0, v_started_at,
          clock_timestamp());
  return jsonb_build_object('scanned', v_scanned, 'reclaimed', v_reclaimed, 'purged', v_purged);
end;
$function$;

revoke all on function private.reclaim_photo_uploads()
  from public, anon, authenticated, service_role;

-- Corpo da 0017 mais o slot de cinco minutos do novo job.
create or replace function private.worker_job_slot(p_job_name text, p_now timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_now_utc timestamp := p_now at time zone 'UTC';
  v_slot timestamptz;
begin
  if p_job_name in ('process_external_effects', 'purge_invite_rate_limits') then
    return date_trunc('minute', v_now_utc) at time zone 'UTC';
  elsif p_job_name in ('health_check_jobs', 'reclaim_photo_uploads') then
    return (
      date_trunc('hour', v_now_utc)
      + make_interval(mins => (extract(minute from v_now_utc)::integer / 5) * 5)
    ) at time zone 'UTC';
  elsif p_job_name = 'purge_expired_revoked_sessions' then
    v_slot := (date_trunc('hour', v_now_utc) at time zone 'UTC')
      + interval '17 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 hour' end;
  elsif p_job_name = 'purge_expired_idempotency_outcomes' then
    v_slot := (date_trunc('day', v_now_utc) at time zone 'UTC')
      + interval '3 hours 23 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 day' end;
  elsif p_job_name = 'purge_completed_deletion_requests' then
    v_slot := (date_trunc('day', v_now_utc) at time zone 'UTC')
      + interval '3 hours 43 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 day' end;
  elsif p_job_name = 'expire_data_exports' then
    v_slot := (date_trunc('hour', v_now_utc) at time zone 'UTC')
      + interval '7 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 hour' end;
  elsif p_job_name in ('purge_removed_memberships', 'purge_terminal_group_invites') then
    v_slot := (date_trunc('day', v_now_utc) at time zone 'UTC')
      + interval '3 hours 53 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 day' end;
  end if;

  raise exception using errcode = '22023', message = 'VALIDATION';
end;
$function$;

create or replace function public.worker_execute_database_job(p_run_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_run private.job_runs%rowtype; v_result jsonb; v_scanned bigint; v_failed bigint; v_stale bigint;
begin
  if p_run_id is null then raise exception using errcode='22023',message='VALIDATION'; end if;
  select run.* into v_run from private.job_runs run where run.id=p_run_id for no key update;
  if not found or v_run.status<>'running' then raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  if v_run.job_name='purge_expired_revoked_sessions' then
    v_result:=private.purge_expired_revoked_sessions();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_expired_idempotency_outcomes' then
    v_result:=private.purge_expired_idempotency_outcomes(); v_scanned:=(v_result->>'payload_expired')::bigint+(v_result->>'tombstones_deleted')::bigint;
    return jsonb_build_object('scanned',v_scanned,'changed',v_scanned,'skipped',0,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_completed_deletion_requests' then
    v_result:=private.purge_completed_deletion_requests();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='expire_data_exports' then
    v_result:=private.expire_data_exports();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'changed')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'changed')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_invite_rate_limits' then
    v_result:=private.purge_invite_rate_limits();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_terminal_group_invites' then
    v_result:=private.purge_terminal_group_invites();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_removed_memberships' then
    v_result:=private.purge_removed_memberships();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='reclaim_photo_uploads' then
    v_result:=private.reclaim_photo_uploads();
    v_scanned:=(v_result->>'reclaimed')::bigint+(v_result->>'purged')::bigint;
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',v_scanned,'skipped',(v_result->>'scanned')::bigint-v_scanned,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='health_check_jobs' then
    select count(*),count(*) filter(where run.status='failed'),count(*) filter(where run.error_code='RUN_ABANDONED') into v_scanned,v_failed,v_stale
    from private.job_runs run where run.id<>p_run_id and run.started_at>=now()-interval '24 hours';
    return jsonb_build_object('scanned',v_scanned,'changed',0,'skipped',v_scanned-v_failed,'failed',v_failed,'stale',v_stale,'duration_ms',0);
  end if;
  raise exception using errcode='22023',message='VALIDATION';
end;
$function$;

revoke all on function private.worker_job_slot(text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.worker_execute_database_job(bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.worker_execute_database_job(bigint) to service_role;

select cron.schedule('colete_v1_reclaim_photo_uploads', '*/5 * * * *',
  $$select private.invoke_worker_cron('reclaim_photo_uploads');$$);

commit;
