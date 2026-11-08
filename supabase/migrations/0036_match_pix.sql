-- Pix manual do piloto (noite/plano-pix-manual.md, versão 3; decisões do César
-- de 06/11 e 07/11/2026, e decisões por delegação de 07/11 a revisar).
-- Revisa a D63-G: o Pix entra no piloto como corte do docs/13 §1.3.1, sem
-- comprovante, T0/T1, claims ou ciclos. A D30 recebe corte: o Pix trava no
-- primeiro pagamento marcado ou «a devolver» pendente, não em T0.
--
-- A chave chega já cifrada pelo Edge (AES-256-GCM, PIX_KEY_ENC_KEY_V1); o
-- banco nunca vê a chave aberta. Nome e cidade do recebedor ficam em claro,
-- como no docs/10. Append-only.
begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Tabela: uma linha por racha que já teve Pix
-- ---------------------------------------------------------------------------
-- A linha nunca é apagada por RPC: remover e expurgar marcam purged. Assim o
-- racha sabe que já teve Pix (trava da CN1) e a próxima inclusão sabe que é
-- uma troca (aviso «Pix alterado»).
create table private.match_payment_secrets (
  match_id uuid primary key references private.matches(id) on delete cascade,
  state text not null check (state in ('active', 'purged')),
  pix_key_type text not null check (pix_key_type in ('cpf', 'cnpj', 'email', 'phone', 'random')),
  pix_key_ciphertext bytea,
  pix_key_key_version smallint,
  pix_key_last4 text check (char_length(pix_key_last4) between 1 and 4),
  pix_receiver_name text check (pix_receiver_name ~ '^[A-Z0-9]([A-Z0-9 ]{0,23}[A-Z0-9])?$'),
  pix_receiver_city text check (pix_receiver_city ~ '^[A-Z0-9]([A-Z0-9 ]{0,13}[A-Z0-9])?$'),
  set_by uuid references public.profiles(id),
  set_at timestamptz not null,
  replaced boolean not null default false,
  purged_at timestamptz,
  check ((state = 'active'
          and pix_key_ciphertext is not null and octet_length(pix_key_ciphertext) >= 29
          and pix_key_key_version = 1 and pix_key_last4 is not null
          and pix_receiver_name is not null and pix_receiver_city is not null
          and set_by is not null and purged_at is null)
      or (state = 'purged'
          and pix_key_ciphertext is null and pix_key_key_version is null
          and pix_key_last4 is null and pix_receiver_name is null
          and pix_receiver_city is null and set_by is null and purged_at is not null))
);
-- Tabela privada de serviço: sem RLS e sem grants, por default privileges da 0004.
comment on table private.match_payment_secrets is
  'Pix do racha (0036). Cifra do Edge, nunca a chave aberta. Escrita por set_match_pix, pelos gatilhos de expurgo e por purge_match_pix; leitura só por get_payment_instructions.';
create index match_payment_secrets_set_by_idx
  on private.match_payment_secrets(set_by) where state = 'active';

insert into private.idempotency_operations
  (operation, family, outcome_shape, id_keys, resource_type, resource_key) values
  ('set_match_pix','group','ids',array['group_id','match_id'],'group','group_id');
insert into private.idempotency_operation_results(operation,logical_result) values
  ('set_match_pix','pix_set'), ('set_match_pix','pix_removed'),
  ('set_match_pix','pix_remove_unchanged');

-- Fim da vida útil do Pix: 60 dias depois do fim do racha ou do cancelamento.
create function private.match_pix_expired(p_match private.matches)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select coalesce(p_match.canceled_at, p_match.ends_at) <= now() - interval '60 days';
$function$;
revoke all on function private.match_pix_expired(private.matches)
  from public, anon, authenticated, service_role;

-- Trava da P2: pagamento marcado ou «a devolver» pendente.
create function private.match_has_real_payment(p_match_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select exists(select 1 from private.match_players where match_id = p_match_id and paid)
      or exists(select 1 from private.match_refunds r join private.match_players p
        on p.id = r.match_player_id where p.match_id = p_match_id and r.status = 'refund_due');
$function$;
revoke all on function private.match_has_real_payment(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- set_match_pix(match_id, pix|null, request_id)
-- ---------------------------------------------------------------------------
-- p_pix: null remove; senão { type, ciphertext (base64), key_version, last4,
-- receiver_name, receiver_city }, já validado e cifrado pelo Edge. O HMAC de
-- idempotência foi calculado sobre a forma aberta, antes da cifra.
create function public.set_match_pix(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_match_id uuid, p_pix jsonb
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
  v_group_id uuid;
  v_match private.matches%rowtype;
  v_secret private.match_payment_secrets%rowtype;
  v_cipher bytea;
  v_result text;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_pix is not null and jsonb_typeof(p_pix) = 'null' then
    p_pix := null;
  end if;
  if p_match_id is null or (p_pix is not null and jsonb_typeof(p_pix) <> 'object') then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  if p_pix is not null then
    if (select array_agg(k order by k) from jsonb_object_keys(p_pix) k)
       is distinct from array['ciphertext','key_version','last4','receiver_city',
                              'receiver_name','type']
       or p_pix->>'type' not in ('cpf','cnpj','email','phone','random')
       or jsonb_typeof(p_pix->'key_version') <> 'number' or (p_pix->>'key_version') <> '1'
       or char_length(coalesce(p_pix->>'last4','')) not between 1 and 4
       or coalesce(p_pix->>'receiver_name','') !~ '^[A-Z0-9]([A-Z0-9 ]{0,23}[A-Z0-9])?$'
       or coalesce(p_pix->>'receiver_city','') !~ '^[A-Z0-9]([A-Z0-9 ]{0,13}[A-Z0-9])?$'
       or coalesce(p_pix->>'ciphertext','') !~ '^[A-Za-z0-9+/]+={0,2}$' then
      raise exception using errcode = '22023', message = 'PIX_INVALID';
    end if;
    v_cipher := decode(p_pix->>'ciphertext', 'base64');
    -- nonce de 12 bytes + ao menos 1 byte de texto + tag de 16 bytes.
    if octet_length(v_cipher) < 29 then
      raise exception using errcode = '22023', message = 'PIX_INVALID';
    end if;
  end if;
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'set_match_pix', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  v_group_id := private.lock_match_context(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id, p_match_id);

  -- M2-D20: só a perda de autoridade no grupo conserva o desfecho, sem current.
  -- Membro sem papel, ex-membro, pendente e estranho recebem NOT_FOUND (1.4).
  begin
    if v_group_id is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
    if private.match_actor_authority(v_group_id, v_actor_id) not in ('owner', 'organizer') then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
    perform private.require_group_not_suspended(v_group_id);
  exception
    when sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm in ('NOT_FOUND', 'GROUP_SUSPENDED') then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  select * into strict v_match from private.matches where id = p_match_id;
  if v_match.canceled_at is not null then
    raise exception using errcode = 'P0001', message = 'MATCH_CANCELED';
  end if;

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome);
  end if;

  -- Racha terminado há menos de 60 dias aceita (pagamento depois do jogo).
  if private.match_pix_expired(v_match) then
    raise exception using errcode = 'P0001', message = 'PIX_PURGED';
  end if;

  select * into v_secret from private.match_payment_secrets
  where match_id = p_match_id for no key update;

  if p_pix is null then
    if v_secret.state is distinct from 'active' then
      v_result := 'pix_remove_unchanged';
    else
      if private.match_has_real_payment(p_match_id) then
        raise exception using errcode = 'P0001', message = 'PIX_LOCKED';
      end if;
      update private.match_payment_secrets
      set state = 'purged', pix_key_ciphertext = null, pix_key_key_version = null,
          pix_key_last4 = null, pix_receiver_name = null, pix_receiver_city = null,
          set_by = null, purged_at = now()
      where match_id = p_match_id;
      v_result := 'pix_removed';
    end if;
  else
    -- CN1 (a): com pago, só inclui em racha que nunca teve Pix.
    if v_secret.match_id is not null and private.match_has_real_payment(p_match_id) then
      raise exception using errcode = 'P0001', message = 'PIX_LOCKED';
    end if;
    insert into private.match_payment_secrets as secret
      (match_id, state, pix_key_type, pix_key_ciphertext, pix_key_key_version, pix_key_last4,
       pix_receiver_name, pix_receiver_city, set_by, set_at, replaced, purged_at)
    values (p_match_id, 'active', p_pix->>'type', v_cipher, 1, p_pix->>'last4',
       p_pix->>'receiver_name', p_pix->>'receiver_city', v_actor_id, now(), false, null)
    on conflict (match_id) do update
    set state = 'active', pix_key_type = excluded.pix_key_type,
        pix_key_ciphertext = excluded.pix_key_ciphertext, pix_key_key_version = 1,
        pix_key_last4 = excluded.pix_key_last4, pix_receiver_name = excluded.pix_receiver_name,
        pix_receiver_city = excluded.pix_receiver_city, set_by = excluded.set_by,
        set_at = excluded.set_at, replaced = true, purged_at = null;
    v_result := 'pix_set';
  end if;

  v_outcome := jsonb_build_object('group_id', v_group_id::text,
    'logical_result', v_result, 'match_id', p_match_id::text);
  perform private.complete_group_idempotency(
    v_actor_key, 'set_match_pix', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome);
end;
$function$;
revoke all on function public.set_match_pix(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_match_pix(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- get_payment_instructions(match_id) — corte do docs/13 §1.3.1
-- ---------------------------------------------------------------------------
-- Lê: organizador ativo, ou jogador confirmado e não pago (também com o racha
-- iniciado ou terminado, P12 da 1.1). Cancelado não lê. Quem não pode ler
-- recebe FORBIDDEN igual com ou sem Pix. Devolve a cifra; o Edge decifra.
create function public.get_payment_instructions(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_match_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_match private.matches%rowtype;
  v_authority text;
  v_secret private.match_payment_secrets%rowtype;
  v_name text;
begin
  if p_match_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  perform 1 from public.profiles p where p.id = v_actor for no key update;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);

  select m.* into v_match from private.matches m
  join public.groups g on g.id = m.group_id and g.archived_at is null
  join public.group_members gm on gm.group_id = m.group_id and gm.profile_id = v_actor
   and gm.status = 'active'
  where m.id = p_match_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;

  v_authority := private.match_actor_authority(v_match.group_id, v_actor);
  if v_match.canceled_at is not null
     or (v_authority not in ('owner', 'organizer') and not exists (
       select 1 from private.match_players
       where match_id = p_match_id and profile_id = v_actor
         and status = 'starter' and not paid)) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  select * into v_secret from private.match_payment_secrets
  where match_id = p_match_id and state = 'active';
  -- A regra dos 60 dias vale sem esperar o worker (C-P3-1).
  if not found or private.match_pix_expired(v_match) then
    raise exception using errcode = 'P0002', message = 'PIX_NOT_CONFIGURED';
  end if;

  select case when pr.account_status in ('deletion_pending', 'deleted') then null
              else coalesce(pr.nickname, pr.name) end
    into v_name
  from public.profiles pr where pr.id = v_secret.set_by;

  return jsonb_build_object(
    'type', v_secret.pix_key_type,
    'ciphertext', encode(v_secret.pix_key_ciphertext, 'base64'),
    'key_version', v_secret.pix_key_key_version,
    'receiver_name', v_secret.pix_receiver_name,
    'receiver_city', v_secret.pix_receiver_city,
    'amount', to_char(v_match.field_price, 'FM999999990.00'),
    'set_by_name', v_name,
    'set_at', v_secret.set_at,
    'replaced', v_secret.replaced);
end;
$function$;
revoke all on function public.get_payment_instructions(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_payment_instructions(uuid,uuid,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Expurgo
-- ---------------------------------------------------------------------------
create function private.purge_match_pix_rows(p_match_ids uuid[])
returns integer
language plpgsql
volatile
set search_path = ''
as $function$
declare v_count integer;
begin
  -- Every purge path (job, deletion request, membership and group triggers)
  -- comes through here and locks in match_id order first, so two of them that
  -- share rows wait instead of deadlocking.
  perform 1 from private.match_payment_secrets
  where match_id = any(p_match_ids) and state = 'active'
  order by match_id
  for update;
  update private.match_payment_secrets
  set state = 'purged', pix_key_ciphertext = null, pix_key_key_version = null,
      pix_key_last4 = null, pix_receiver_name = null, pix_receiver_city = null,
      set_by = null, purged_at = now()
  where match_id = any(p_match_ids) and state = 'active';
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
revoke all on function private.purge_match_pix_rows(uuid[])
  from public, anon, authenticated, service_role;

-- N5 e C-P2-2: quem gravou o Pix e deixou de ser dono ou organizador ativo do
-- grupo perde o Pix, qualquer que seja o caminho (leave_group, remove_member,
-- set_role, transfer_ownership, saída na exclusão de conta).
create function private.purge_match_pix_without_authority(p_group_id uuid)
returns integer
language plpgsql
volatile
set search_path = ''
as $function$
begin
  return private.purge_match_pix_rows(array(
    select secret.match_id
    from private.match_payment_secrets secret
    join private.matches m on m.id = secret.match_id
    join public.groups g on g.id = m.group_id
    where m.group_id = p_group_id and secret.state = 'active'
      and not (g.archived_at is null and (g.owner_id = secret.set_by or exists (
        select 1 from public.group_members gm
        where gm.group_id = g.id and gm.profile_id = secret.set_by
          and gm.status = 'active' and gm.role = 'organizer')))));
end;
$function$;
revoke all on function private.purge_match_pix_without_authority(uuid)
  from public, anon, authenticated, service_role;

create function private.purge_match_pix_on_membership_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.purge_match_pix_without_authority(new.group_id);
  return null;
end;
$function$;
revoke all on function private.purge_match_pix_on_membership_change()
  from public, anon, authenticated, service_role;
create trigger group_members_purge_match_pix
  after update of status, role on public.group_members
  for each row
  when (old.status is distinct from new.status or old.role is distinct from new.role)
  execute function private.purge_match_pix_on_membership_change();

-- Troca de dono e arquivamento (delete_group, grupo solo na exclusão de conta):
-- N7 expurga todo o Pix do grupo arquivado.
create function private.purge_match_pix_on_group_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.purge_match_pix_without_authority(new.id);
  return null;
end;
$function$;
revoke all on function private.purge_match_pix_on_group_change()
  from public, anon, authenticated, service_role;
create trigger groups_purge_match_pix
  after update of owner_id, archived_at on public.groups
  for each row
  when (old.owner_id is distinct from new.owner_id
        or old.archived_at is distinct from new.archived_at)
  execute function private.purge_match_pix_on_group_change();

-- P5: o pedido de exclusão expurga, na mesma transação, todo Pix gravado pela
-- pessoa, antes de qualquer passo do worker.
create function private.purge_match_pix_on_deletion_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.purge_match_pix_rows(array(
    select match_id from private.match_payment_secrets
    where set_by = new.profile_id and state = 'active'));
  return null;
end;
$function$;
revoke all on function private.purge_match_pix_on_deletion_request()
  from public, anon, authenticated, service_role;
create trigger deletion_requests_purge_match_pix
  after insert on private.deletion_requests
  for each row execute function private.purge_match_pix_on_deletion_request();

-- P3 e N3: 60 dias depois do fim ou do cancelamento, mesmo com «a devolver».
create function private.purge_match_pix()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_now timestamptz := now();
  v_ids uuid[];
  v_purged integer;
begin
  select coalesce(array_agg(secret.match_id), '{}') into v_ids
  from private.match_payment_secrets secret
  join private.matches m on m.id = secret.match_id
  where secret.state = 'active' and private.match_pix_expired(m);
  v_purged := private.purge_match_pix_rows(v_ids);
  insert into private.retention_runs
    (policy, window_start, window_end, scanned, purged, failed, started_at, finished_at)
  values ('purge_match_pix', v_now - interval '60 days', v_now,
          cardinality(v_ids), v_purged, 0, v_started_at, clock_timestamp());
  return jsonb_build_object('scanned', cardinality(v_ids), 'purged', v_purged);
end;
$function$;
revoke all on function private.purge_match_pix()
  from public, anon, authenticated, service_role;

-- Corpos da 0031; o expurgo do Pix entra no slot diário dos outros expurgos
-- de retenção do grupo, e o despacho ganha o ramo do job novo.
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
  elsif p_job_name in ('purge_removed_memberships', 'purge_terminal_group_invites',
                       'purge_ratings', 'purge_match_pix') then
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
  elsif v_run.job_name='purge_ratings' then
    v_result:=private.purge_ratings();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_match_pix' then
    v_result:=private.purge_match_pix();
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
select cron.schedule('colete_v1_purge_match_pix', '53 3 * * *',
  $$select private.invoke_worker_cron('purge_match_pix');$$);

commit;
