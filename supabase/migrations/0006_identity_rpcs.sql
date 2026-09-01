begin;

-- M1-A, slice 3: the policy catalogue, its internal dispatcher, the guards of
-- the administrative path and the four identity RPCs.
-- Sources: docs/10-schema-db.md sections 2 and 11; docs/13-contratos-funcoes.md
-- sections 0, 0.1, 5.2, 5.5, 5.6 and 5.7; docs/14-convencoes-app.md section 5.3;
-- docs/17-mapa-dados-lgpd.md section 2.
--
-- These RPCs are the internal half of the exclusive gateway. The client never
-- calls them: it calls the Edge Function, which validates the JWT, extracts the
-- claims, canonicalises the input and computes the HMAC. Only then does it call
-- one narrow RPC with the administrative client. In this path auth.uid() is the
-- administrative client or null, so nothing here treats it as the actor: the
-- actor arrives as an explicit argument and every authorisation is revalidated
-- against the database inside the transaction.
--
-- No Edge Function, no rate limit and no policy seed enters this migration.

-- ---------------------------------------------------------------------------
-- Policy catalogue
-- ---------------------------------------------------------------------------
-- docs/10-schema-db.md section 2 and docs/17-mapa-dados-lgpd.md section 2. The
-- catalogue is technical: it anchors an accepted version to the digest of the
-- published file. The integral text of a policy never enters the database, and
-- therefore never enters an idempotent outcome or an export.

create table private.policy_documents (
  document_type  text not null check (document_type in ('terms', 'privacy')),
  version        text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  content_sha256 bytea not null check (octet_length(content_sha256) = 32),
  published_at   timestamptz not null,
  mandatory      boolean not null default false,
  primary key (document_type, version)
);

comment on table private.policy_documents is
  'Technical catalogue of published policy versions. Digest only: the integral text lives in the published file, never in a column.';
comment on column private.policy_documents.content_sha256 is
  'SHA-256 of the published file, 32 raw bytes. A future build compares file against digest.';

-- docs/17-mapa-dados-lgpd.md section 2: at most one mandatory version per type.
create unique index one_mandatory_policy_per_type
  on private.policy_documents (document_type) where mandatory;

-- docs/10-schema-db.md section 2 carries this composite foreign key on
-- policy_acceptances. Migration 0003 could not create it because the catalogue
-- did not exist yet; it is added here instead of rewriting 0003.
alter table public.policy_acceptances
  add constraint policy_acceptances_document_fkey
  foreign key (document_type, version)
  references private.policy_documents (document_type, version)
  on update restrict on delete restrict;

revoke all on table private.policy_documents from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Internal dispatcher of the catalogue
-- ---------------------------------------------------------------------------
-- docs/10-schema-db.md section 11 says policy_documents is written by migration
-- or by an internal dispatcher, never by a client. Switching which version is
-- mandatory has to be atomic, because the partial unique index above admits no
-- moment with two mandatory versions of the same type.

create or replace function private.publish_policy_document(
  p_document_type text,
  p_version text,
  p_content_sha256 bytea,
  p_published_at timestamptz,
  p_make_mandatory boolean
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
begin
  if p_document_type is null or p_version is null or p_content_sha256 is null
     or p_published_at is null or p_make_mandatory is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  if p_document_type not in ('terms', 'privacy')
     or p_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     or octet_length(p_content_sha256) <> 32 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  -- Identity and digest of a published version are immutable. Republishing the
  -- same version with a different file is a different version, not an update.
  if exists (
    select 1
    from private.policy_documents as document
    where document.document_type = p_document_type
      and document.version = p_version
      and (document.content_sha256 <> p_content_sha256
        or document.published_at <> p_published_at)
  ) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  if p_make_mandatory then
    update private.policy_documents as document
    set mandatory = false
    where document.document_type = p_document_type
      and document.mandatory
      and document.version <> p_version;
  end if;

  insert into private.policy_documents
    (document_type, version, content_sha256, published_at, mandatory)
  values
    (p_document_type, p_version, p_content_sha256, p_published_at, p_make_mandatory)
  on conflict (document_type, version) do update
    set mandatory = excluded.mandatory;
end;
$function$;

comment on function private.publish_policy_document(text, text, bytea, timestamptz, boolean) is
  'Publishes a policy version and, when it becomes mandatory, clears the previous one in the same statement sequence so the partial unique index is never violated.';

revoke all on function private.publish_policy_document(text, text, bytea, timestamptz, boolean)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Guards of the administrative path
-- ---------------------------------------------------------------------------
-- private.require_domain_authority() of 0003 is the guard for a caller running
-- under the end user's JWT. It cannot be reused here: on this path auth.uid()
-- is the administrative client, so the session and the profile have to be
-- checked against the arguments the Edge extracted from the verified claims.

create or replace function private.is_actor_session_revoked(p_session_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $function$
  -- Fail closed. A context without a session identifier is a context whose
  -- revocation cannot be checked, and that is a denial.
  select p_session_id is null
      or exists (
        select 1
        from private.revoked_auth_sessions as revoked
        where revoked.session_id = p_session_id
      );
$function$;

comment on function private.is_actor_session_revoked(uuid) is
  'Denylist check for a session identifier supplied by the Edge. Null is revoked, so an unidentifiable session never passes.';

create or replace function private.require_actor_context(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_allow_suspended boolean default false,
  p_allow_revoked_session boolean default false
)
returns uuid
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_actor public.profiles%rowtype;
begin
  if p_actor_auth_user_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;

  -- revoke_current_session is the one operation that must accept an already
  -- revoked session: docs/13-contratos-funcoes.md section 5.5 makes a new
  -- request_id over a revoked session a success, not an error. It still demands
  -- an identified session, so a null session_id is refused either way.
  if p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;

  if not p_allow_revoked_session
     and private.is_actor_session_revoked(p_actor_session_id) then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;

  select *
  into v_actor
  from public.profiles as profile
  where profile.auth_user_id = p_actor_auth_user_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;

  if v_actor.account_status in ('deletion_pending', 'deleted') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  -- docs/13-contratos-funcoes.md section 5.5: a suspended or banned account may
  -- still revoke its own session, because that is the titular's own security
  -- action and not a domain mutation.
  if v_actor.account_status in ('suspended', 'banned') and not p_allow_suspended then
    raise exception using errcode = '42501', message = 'PROFILE_SUSPENDED';
  end if;

  return v_actor.id;
end;
$function$;

comment on function private.require_actor_context(uuid, uuid, boolean, boolean) is
  'The common guard of the administrative path: identified actor, session not revoked, account not deleted, and not suspended unless the operation is the titular own security action.';

revoke all on function private.is_actor_session_revoked(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.require_actor_context(uuid, uuid, boolean, boolean)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Transport of the internal call
-- ---------------------------------------------------------------------------
-- docs/13-contratos-funcoes.md section 0.1: the RPC validates the format and
-- the version of the HMAC and compares the persisted value on replay. It never
-- computes the HMAC, because the key never enters the database.

create or replace function private.require_internal_transport(
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer
)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
begin
  if p_request_id is null or p_input_hmac is null
     or p_canonical_version is null or p_hash_key_version is null
     or p_input_hmac !~ '^[0-9a-f]{64}$'
     or p_canonical_version <> 1
     or p_hash_key_version not between 1 and 32767 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
end;
$function$;

comment on function private.require_internal_transport(uuid, text, integer, integer) is
  'Shape of the internal call. The RPC never computes the HMAC: it validates format and version and lets acquire_idempotency compare the persisted value.';

revoke all on function private.require_internal_transport(uuid, text, integer, integer)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Profile input and safe projections
-- ---------------------------------------------------------------------------
-- docs/13-contratos-funcoes.md section 5.6 is the single authority for the
-- writable allowlist. complete_profile reuses it with name required, so the two
-- operations can never drift apart on trimming, NFC, limits or enums.

create or replace function private.validate_profile_patch(
  p_patch jsonb,
  p_require_name boolean
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_key text;
  v_patch jsonb := '{}'::jsonb;
  v_text text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  for v_key in select key from jsonb_object_keys(p_patch) as key loop
    if v_key not in ('name', 'nickname', 'position', 'dominant_foot', 'shirt_number') then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end loop;

  if p_require_name and not (p_patch ? 'name') then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  -- name never accepts null: absence leaves it untouched, and there is no
  -- state in which a profile has no name.
  if p_patch ? 'name' then
    if jsonb_typeof(p_patch -> 'name') <> 'string' then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;

    v_text := normalize(btrim(p_patch ->> 'name', E' \t\n\r'), NFC);
    if length(v_text) < 2 or length(v_text) > 80 then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    v_patch := v_patch || jsonb_build_object('name', v_text);
  end if;

  -- An optional text field has exactly two spellings: a non-empty value, or an
  -- explicit null that clears it. A blank string is a validation error, never a
  -- silent null, because two spellings of one state is how comparison bugs are
  -- born in the public projection.
  if p_patch ? 'nickname' then
    if jsonb_typeof(p_patch -> 'nickname') = 'null' then
      v_patch := v_patch || jsonb_build_object('nickname', null::text);
    elsif jsonb_typeof(p_patch -> 'nickname') = 'string' then
      v_text := normalize(btrim(p_patch ->> 'nickname', E' \t\n\r'), NFC);
      if length(v_text) < 1 or length(v_text) > 30 then
        raise exception using errcode = '22023', message = 'VALIDATION';
      end if;
      v_patch := v_patch || jsonb_build_object('nickname', v_text);
    else
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end if;

  if p_patch ? 'position' then
    if jsonb_typeof(p_patch -> 'position') = 'null' then
      v_patch := v_patch || jsonb_build_object('position', null::text);
    elsif jsonb_typeof(p_patch -> 'position') = 'string'
          and p_patch ->> 'position' in
              ('goalkeeper', 'defender', 'midfielder', 'forward') then
      v_patch := v_patch || jsonb_build_object('position', p_patch ->> 'position');
    else
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end if;

  if p_patch ? 'dominant_foot' then
    if jsonb_typeof(p_patch -> 'dominant_foot') = 'null' then
      v_patch := v_patch || jsonb_build_object('dominant_foot', null::text);
    elsif jsonb_typeof(p_patch -> 'dominant_foot') = 'string'
          and p_patch ->> 'dominant_foot' in ('left', 'right', 'both') then
      v_patch := v_patch || jsonb_build_object('dominant_foot', p_patch ->> 'dominant_foot');
    else
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end if;

  if p_patch ? 'shirt_number' then
    if jsonb_typeof(p_patch -> 'shirt_number') = 'null' then
      v_patch := v_patch || jsonb_build_object('shirt_number', null::int);
    elsif jsonb_typeof(p_patch -> 'shirt_number') = 'number'
          and (p_patch -> 'shirt_number' #>> '{}') ~ '^(0|[1-9][0-9]?)$' then
      v_patch := v_patch
        || jsonb_build_object('shirt_number', (p_patch ->> 'shirt_number')::int);
    else
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end if;

  return v_patch;
end;
$function$;

comment on function private.validate_profile_patch(jsonb, boolean) is
  'Closed allowlist of writable profile fields. Absence differs from null, blank optional text is rejected, and no key outside docs/13 section 5.6 survives.';

create or replace function private.profile_projection(p_profile_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select jsonb_build_object(
    'name', profile.name,
    'nickname', profile.nickname,
    'position', profile.position,
    'dominant_foot', profile.dominant_foot,
    'shirt_number', profile.shirt_number
  )
  from public.profiles as profile
  where profile.id = p_profile_id;
$function$;

comment on function private.profile_projection(uuid) is
  'Fresh authorised projection of the caller own profile. It never returns account_status, auth_user_id or any operational column.';

-- docs/13-contratos-funcoes.md section 5.2. Ordering is by raw bytes, not by
-- collation, so the canonical order of the outcome is the same one that
-- validate_idempotency_outcome enforces.
create or replace function private.policy_state(p_profile_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select jsonb_build_object(
    'accepted_current', coalesce((
      select jsonb_agg(
               jsonb_build_object('document_type', document.document_type,
                                  'version', document.version)
               order by convert_to(document.document_type, 'UTF8'),
                        convert_to(document.version, 'UTF8'))
      from private.policy_documents as document
      where document.mandatory
        and exists (
          select 1
          from public.policy_acceptances as acceptance
          where acceptance.profile_id = p_profile_id
            and acceptance.document_type = document.document_type
            and acceptance.version = document.version
        )
    ), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(
               jsonb_build_object('document_type', document.document_type,
                                  'version', document.version)
               order by convert_to(document.document_type, 'UTF8'),
                        convert_to(document.version, 'UTF8'))
      from private.policy_documents as document
      where document.mandatory
        and not exists (
          select 1
          from public.policy_acceptances as acceptance
          where acceptance.profile_id = p_profile_id
            and acceptance.document_type = document.document_type
            and acceptance.version = document.version
        )
    ), '[]'::jsonb)
  );
$function$;

comment on function private.policy_state(uuid) is
  'Which mandatory versions the profile has accepted and which are still pending. Never the integral text of a document.';

revoke all on function private.validate_profile_patch(jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.profile_projection(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.policy_state(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.require_policies_accepted(p_profile_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $function$
begin
  -- docs/13-contratos-funcoes.md section 5.2: an ordinary mutation is refused
  -- while a mandatory version is pending. complete_profile, accept_policies and
  -- revocation stay available, so none of them calls this.
  if jsonb_array_length(private.policy_state(p_profile_id) -> 'pending') > 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
end;
$function$;

comment on function private.require_policies_accepted(uuid) is
  'The policy gate of docs/13 section 5.2, applied to ordinary mutations only.';

revoke all on function private.require_policies_accepted(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- complete_profile
-- ---------------------------------------------------------------------------
-- docs/13-contratos-funcoes.md section 5.7. The bootstrap actor key is derived
-- from the verified Auth ID before asking whether a profile exists, because at
-- that moment there is no profile to key the idempotency on. The digest is a
-- plain SHA-256 with no key, so the database can derive it: nothing here needs
-- the HMAC key, which never enters the database.

create or replace function public.complete_profile(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_profile jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_key text;
  v_acquired record;
  v_patch jsonb;
  v_profile_id uuid;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);

  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;

  if private.is_actor_session_revoked(p_actor_session_id) then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;

  v_actor_key := 'bootstrap:' || encode(
    extensions.digest(
      convert_to('colete/bootstrap-actor/v1', 'UTF8')
        || '\x00'::bytea
        || decode(replace(lower(p_actor_auth_user_id::text), '-', ''), 'hex'),
      'sha256'),
    'hex');

  select * into v_acquired
  from private.acquire_idempotency(
    v_actor_key, 'complete_profile', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  if not v_acquired.acquired then
    return jsonb_build_object(
      'outcome', v_acquired.outcome,
      'current', private.profile_projection((v_acquired.outcome ->> 'profile_id')::uuid));
  end if;

  -- A different request_id after the profile already exists is a validation
  -- error, not a second profile. The unique on auth_user_id is the independent
  -- second barrier in a race.
  if exists (
    select 1 from public.profiles as profile
    where profile.auth_user_id = p_actor_auth_user_id
  ) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  v_patch := private.validate_profile_patch(p_profile, true);

  insert into public.profiles
    (auth_user_id, name, nickname, position, dominant_foot, shirt_number)
  values (
    p_actor_auth_user_id,
    v_patch ->> 'name',
    v_patch ->> 'nickname',
    v_patch ->> 'position',
    v_patch ->> 'dominant_foot',
    (v_patch ->> 'shirt_number')::int
  )
  returning id into v_profile_id;

  v_outcome := jsonb_build_object(
    'profile_id', v_profile_id::text,
    'logical_result', 'profile_created');

  perform private.complete_idempotency(
    v_actor_key, 'complete_profile', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object(
    'outcome', v_outcome,
    'current', private.profile_projection(v_profile_id));
end;
$function$;

comment on function public.complete_profile(uuid, uuid, uuid, text, integer, integer, jsonb) is
  'Internal RPC of the exclusive gateway. The actor arrives from the Edge verified claims; auth.uid() on this path is the administrative client and proves nothing.';

-- ---------------------------------------------------------------------------
-- update_profile
-- ---------------------------------------------------------------------------
-- docs/13-contratos-funcoes.md section 5.6. The outcome deliberately does not
-- echo what was written: those fields stay mutable after the commit, so the
-- client rereads them from the fresh projection in current.

create or replace function public.update_profile(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_profile_id uuid;
  v_actor_key text;
  v_acquired record;
  v_patch jsonb;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);

  v_profile_id := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id);
  v_actor_key := 'profile:' || v_profile_id::text;

  select * into v_acquired
  from private.acquire_idempotency(
    v_actor_key, 'update_profile', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  -- The replay path runs before the policy gate on purpose: a mandatory version
  -- published after the original commit must not turn an already-committed
  -- mutation into an error on retry.
  if not v_acquired.acquired then
    return jsonb_build_object(
      'outcome', v_acquired.outcome,
      'current', private.profile_projection(v_profile_id));
  end if;

  perform private.require_policies_accepted(v_profile_id);

  v_patch := private.validate_profile_patch(p_patch, false);

  -- Lock order of docs/10 section 1: idempotency, then profiles.
  perform 1 from public.profiles as profile
  where profile.id = v_profile_id
  for update;

  -- An empty patch is a success with no effect, so the update below is a no-op
  -- rather than a special case.
  update public.profiles as profile
  set name = case when v_patch ? 'name'
                  then v_patch ->> 'name' else profile.name end,
      nickname = case when v_patch ? 'nickname'
                      then v_patch ->> 'nickname' else profile.nickname end,
      position = case when v_patch ? 'position'
                      then v_patch ->> 'position' else profile.position end,
      dominant_foot = case when v_patch ? 'dominant_foot'
                           then v_patch ->> 'dominant_foot' else profile.dominant_foot end,
      shirt_number = case when v_patch ? 'shirt_number'
                          then (v_patch ->> 'shirt_number')::int else profile.shirt_number end
  where profile.id = v_profile_id;

  v_outcome := jsonb_build_object('logical_result', 'profile_updated');

  perform private.complete_idempotency(
    v_actor_key, 'update_profile', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object(
    'outcome', v_outcome,
    'current', private.profile_projection(v_profile_id));
end;
$function$;

comment on function public.update_profile(uuid, uuid, uuid, text, integer, integer, jsonb) is
  'Internal RPC of the exclusive gateway. Writes only the keys present in the patch and returns a fresh projection instead of echoing them.';

-- ---------------------------------------------------------------------------
-- accept_policies
-- ---------------------------------------------------------------------------
-- docs/13-contratos-funcoes.md section 5.2. The operation fails closed when the
-- catalogue does not hold exactly one mandatory version of each type: without
-- that, "accepted everything mandatory" would be indistinguishable from
-- "nothing is mandatory yet".

create or replace function public.accept_policies(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_versions jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_profile_id uuid;
  v_actor_key text;
  v_acquired record;
  v_item jsonb;
  v_document_type text;
  v_version text;
  v_sort_key bytea;
  v_previous_sort_key bytea;
  v_source text;
  v_accepted jsonb := '[]'::jsonb;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);

  v_profile_id := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id);
  v_actor_key := 'profile:' || v_profile_id::text;

  select * into v_acquired
  from private.acquire_idempotency(
    v_actor_key, 'accept_policies', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  if not v_acquired.acquired then
    return jsonb_build_object(
      'outcome', v_acquired.outcome,
      'current', private.policy_state(v_profile_id));
  end if;

  if (select count(*) from private.policy_documents as document
      where document.mandatory and document.document_type = 'terms') <> 1
     or (select count(*) from private.policy_documents as document
         where document.mandatory and document.document_type = 'privacy') <> 1 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  if p_versions is null
     or jsonb_typeof(p_versions) <> 'array'
     or jsonb_array_length(p_versions) not between 1 and 2 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  for v_item in
    select value from jsonb_array_elements(p_versions) with ordinality
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

    if v_document_type not in ('terms', 'privacy') then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;

    -- Canonical byte order, which also rejects duplicates. It is the same
    -- ordering the outcome validator enforces, so a valid input can always
    -- produce a valid outcome.
    v_sort_key := convert_to(v_document_type, 'UTF8')
      || '\x00'::bytea
      || convert_to(v_version, 'UTF8');
    if v_previous_sort_key is not null and v_sort_key <= v_previous_sort_key then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    v_previous_sort_key := v_sort_key;

    -- Unknown, superseded or non-mandatory versions are all the same error: the
    -- client does not get to learn which versions exist in the catalogue.
    if not exists (
      select 1 from private.policy_documents as document
      where document.document_type = v_document_type
        and document.version = v_version
        and document.mandatory
    ) then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;

    -- Source is derived by the server, never by the payload.
    v_source := case
      when exists (
        select 1 from public.policy_acceptances as acceptance
        where acceptance.profile_id = v_profile_id
          and acceptance.document_type = v_document_type
      ) then 'reauth'
      else 'signup'
    end;

    insert into public.policy_acceptances (profile_id, document_type, version, source)
    values (v_profile_id, v_document_type, v_version, v_source)
    on conflict (profile_id, document_type, version) do nothing;

    v_accepted := v_accepted || jsonb_build_array(
      jsonb_build_object('document_type', v_document_type, 'version', v_version));
  end loop;

  v_outcome := jsonb_build_object(
    'accepted', v_accepted,
    'logical_result', 'policies_accepted');

  perform private.complete_idempotency(
    v_actor_key, 'accept_policies', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object(
    'outcome', v_outcome,
    'current', private.policy_state(v_profile_id));
end;
$function$;

comment on function public.accept_policies(uuid, uuid, uuid, text, integer, integer, jsonb) is
  'Internal RPC of the exclusive gateway. Records which mandatory versions the actor accepted; it never returns or stores the integral text of a document.';

-- ---------------------------------------------------------------------------
-- revoke_current_session
-- ---------------------------------------------------------------------------
-- docs/13-contratos-funcoes.md section 5.5. This is the titular own security
-- action, so a suspended or banned account may call it, and an already revoked
-- session is a success rather than an error. expires_at covers the maximum
-- session lifetime, not the access token expiry: with refresh rotation the same
-- session_id keeps minting tokens, so a denylist row that expired with the
-- token would silently resurrect a revoked session.

create or replace function public.revoke_current_session(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_profile_id uuid;
  v_actor_key text;
  v_acquired record;
  v_lifetime_seconds bigint;
  v_revoked_at timestamptz;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);

  v_profile_id := private.require_actor_context(
    p_actor_auth_user_id, p_actor_session_id, true, true);
  v_actor_key := 'profile:' || v_profile_id::text;

  select * into v_acquired
  from private.acquire_idempotency(
    v_actor_key, 'revoke_current_session', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  if not v_acquired.acquired then
    return jsonb_build_object(
      'outcome', v_acquired.outcome,
      'current', jsonb_build_object('session_active', false));
  end if;

  select limits.limit_value
  into v_lifetime_seconds
  from private.app_limits as limits
  where limits.limit_key = 'auth_session_max_lifetime_seconds';

  if v_lifetime_seconds is null or v_lifetime_seconds <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  -- on conflict do nothing preserves the original expires_at, so a second call
  -- can never shorten a denial that is already in force.
  insert into private.revoked_auth_sessions (session_id, profile_id, expires_at)
  values (
    p_actor_session_id,
    v_profile_id,
    now() + (v_lifetime_seconds::text || ' seconds')::interval
  )
  on conflict (session_id) do nothing;

  select revoked.revoked_at
  into v_revoked_at
  from private.revoked_auth_sessions as revoked
  where revoked.session_id = p_actor_session_id;

  v_outcome := jsonb_build_object(
    'session_id', p_actor_session_id::text,
    'revoked_at',
      to_char(v_revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'logical_result', 'session_revoked');

  perform private.complete_idempotency(
    v_actor_key, 'revoke_current_session', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object(
    'outcome', v_outcome,
    'current', jsonb_build_object('session_active', false));
end;
$function$;

comment on function public.revoke_current_session(uuid, uuid, uuid, text, integer, integer) is
  'Internal RPC of the exclusive gateway. Adds the caller own session to the denylist without shortening an existing denial, and never returns expires_at.';

-- ---------------------------------------------------------------------------
-- Execution boundary
-- ---------------------------------------------------------------------------
-- docs/10-schema-db.md section 11 and docs/13-contratos-funcoes.md section 0.1:
-- no mutating RPC grants EXECUTE to public, anon or authenticated. Only the
-- administrative role behind the secret key receives a nominal grant, and only
-- on this closed allowlist. There is no generic administrative API and no free
-- DML for the Edge: 0004 already removed every table and sequence privilege
-- that role had.

revoke all on function
  public.complete_profile(uuid, uuid, uuid, text, integer, integer, jsonb)
  from public, anon, authenticated;
revoke all on function
  public.update_profile(uuid, uuid, uuid, text, integer, integer, jsonb)
  from public, anon, authenticated;
revoke all on function
  public.accept_policies(uuid, uuid, uuid, text, integer, integer, jsonb)
  from public, anon, authenticated;
revoke all on function
  public.revoke_current_session(uuid, uuid, uuid, text, integer, integer)
  from public, anon, authenticated;

grant execute on function
  public.complete_profile(uuid, uuid, uuid, text, integer, integer, jsonb)
  to service_role;
grant execute on function
  public.update_profile(uuid, uuid, uuid, text, integer, integer, jsonb)
  to service_role;
grant execute on function
  public.accept_policies(uuid, uuid, uuid, text, integer, integer, jsonb)
  to service_role;
grant execute on function
  public.revoke_current_session(uuid, uuid, uuid, text, integer, integer)
  to service_role;

commit;
