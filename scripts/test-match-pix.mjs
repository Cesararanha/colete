// 0036: Pix manual through the real Edge with real GoTrue sessions. Proves what
// pgTAP cannot: the open key never reaches the database, the idempotency
// records or the Edge logs; the HMAC is over the normalised open form (two
// spellings of one key replay; a different key conflicts); the read opens the
// sealed key for an unpaid starter, with no-store, and refuses a revoked
// session; without PIX_KEY_ENC_KEY_V1 the set answers INTERNAL before any RPC
// and the read only to whom may read; a pg_dump of the whole local database
// carries the key in no form and the receiver only in its two columns; and
// set_match_pix races leave_group and set_match_payment without breaking the
// lock.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { assertDistinctConnections, awaitLockWait, track } from './lock-barrier.mjs';
import { startDirectEdge } from './local-edge-runtime.mjs';
import { localWorkerCronSecret } from './local-worker-test-config.mjs';

const output = execFileSync('./node_modules/.bin/supabase', ['status', '-o', 'env'], {
  encoding: 'utf8',
  env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const localValue = (name) => output.match(new RegExp(`^${name}="([^"]+)"$`, 'm'))?.[1];
const apiUrl = localValue('API_URL');
const functionsUrl = localValue('FUNCTIONS_URL');
const secret = localValue('SECRET_KEY');
const publishable = localValue('PUBLISHABLE_KEY');
const url = localValue('DB_URL');
assert.ok(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'local database only');

const clients = Object.fromEntries(
  ['observer', 'first', 'second'].map((key) => [
    key,
    new pg.Client({ connectionString: url, application_name: `colete_pix_${key}` }),
  ]),
);
await Promise.all(Object.values(clients).map((client) => client.connect()));
const { observer: db, first, second } = clients;
const pids = await assertDistinctConnections(clients, 'pix barriers');
// C2-P3-1: corrida leave_group x set_match_pix, fora do Edge, com commits reais.
const RACE_GROUP = '37200000-0000-4000-8000-000000000002';
const RACE_MATCH = '37300000-0000-4000-8000-000000000003';
const RACE_OWNER = '37100000-0000-4000-8000-000000000001';
const RACE_ORGANIZER = '37100000-0000-4000-8000-000000000002';
const RACE_PLAYER = '37100000-0000-4000-8000-000000000003';
const raceAuth = (profile) => profile.replace('37100000', '37000000');
const RACE_CIPHER = Buffer.alloc(32, 0xab).toString('base64');
const RACE_OLD_CIPHER = Buffer.alloc(32, 0xcd);

const GROUP = '37200000-0000-4000-8000-000000000001';
const MATCH = '37300000-0000-4000-8000-000000000001';
const ENDED = '37300000-0000-4000-8000-000000000002';
// CPF de exemplo com dígitos válidos; o banco só pode ver a cifra.
const CPF_FORMATTED = '529.982.247-25';
const CPF = '52998224725';
const OTHER_EMAIL = 'pix.colete@example.com';
const request = () => crypto.randomUUID();
const startedAt = new Date().toISOString();

const users = [];
async function realUser(label) {
  const password = `Synthetic-pix-${label}-2026`;
  const email = `pix-http-${label}-${Date.now()}@colete.test`;
  const created = await fetch(`${apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  assert.equal(created.status, 200);
  const authId = (await created.json()).id;
  const user = { authId, profileId: undefined, token: undefined };
  users.push(user);
  const signed = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: publishable, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(signed.status, 200);
  user.token = (await signed.json()).access_token;
  const profile = await post(functionsUrl, user, 'identity/complete_profile', {
    request_id: request(),
    profile: { name: `Synthetic pix ${label}` },
  });
  assert.equal(profile.status, 200);
  user.profileId = profile.body.data.outcome.profile_id;
  return user;
}

async function post(base, user, route, body) {
  const response = await fetch(`${base}/${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${user.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
}
const setPix = (user, pix, id = request(), base = functionsUrl) =>
  post(base, user, 'groups/set_match_pix', { request_id: id, match_id: MATCH, pix });
const readPix = (user, match = MATCH, base = functionsUrl) =>
  post(base, user, 'groups/get_payment_instructions', { match_id: match });
const pixBody = (key, type = 'cpf') => ({
  type,
  key,
  receiver_name: 'Dona do Racha',
  receiver_city: 'São Paulo',
});
function expectError(result, status, code, label) {
  assert.equal(result.status, status, `${label}: ${result.text}`);
  assert.equal(result.body.error?.code, code, label);
}
const keyForms = [CPF, CPF_FORMATTED, OTHER_EMAIL].flatMap((key) => [
  key,
  Buffer.from(key).toString('hex'),
  Buffer.from(key).toString('base64').replace(/=+$/, ''),
]);
// N4: the receiver may live only in the two columns of match_payment_secrets.
const receiverForms = ['dona do racha', 'sao paulo', 'são paulo'];
function assertNoKey(text, label) {
  for (const form of keyForms) {
    assert.ok(!text.includes(form), `${label} must not carry the open key`);
  }
}
function assertNoReceiver(text, label) {
  const lower = text.toLowerCase();
  for (const form of receiverForms) {
    assert.ok(!lower.includes(form), `${label} must not carry the receiver`);
  }
}

let runtime;
try {
  const organizer = await realUser('organizer');
  const player = await realUser('player');
  const payer = await realUser('payer');
  await db.query('begin');
  await db.query(
    `insert into public.groups(id,name,owner_id) values($1,'Synthetic pix group',$2)`,
    [GROUP, organizer.profileId],
  );
  await db.query(
    `insert into public.group_members(group_id,profile_id,role,status) values
      ($1,$2,'organizer','active'),($1,$3,'player','active'),($1,$4,'player','active')`,
    [GROUP, organizer.profileId, player.profileId, payer.profileId],
  );
  await db.query(
    `insert into private.matches(id,group_id,starts_at,ends_at,timezone,location_name,field_slots,field_price,created_by)
     values ($1,$3,date_trunc('minute',now())+interval '2 days',date_trunc('minute',now())+interval '2 days 90 minutes',
             'America/Sao_Paulo','Arena',4,17.5,$4),
            ($2,$3,now()-interval '61 days 2 hours',now()-interval '61 days','America/Sao_Paulo','Arena',4,17.5,$4)`,
    [MATCH, ENDED, GROUP, organizer.profileId],
  );
  await db.query(
    `insert into private.match_players(match_id,profile_id,status,queue_seq) values
      ($1,$2,'starter',nextval('private.match_queue_seq')),($1,$3,'starter',nextval('private.match_queue_seq'))`,
    [MATCH, player.profileId, payer.profileId],
  );
  await db.query(
    `insert into auth.users(id,email) values ($1,'pix37-race-owner@example.invalid'),
      ($2,'pix37-race-org@example.invalid'),($3,'pix37-race-player@example.invalid')`,
    [raceAuth(RACE_OWNER), raceAuth(RACE_ORGANIZER), raceAuth(RACE_PLAYER)],
  );
  await db.query(
    `insert into public.profiles(id,auth_user_id,name,account_status) values
      ($1,$2,'Race owner','active'),($3,$4,'Race org','active'),($5,$6,'Race player','active')`,
    [
      RACE_OWNER,
      raceAuth(RACE_OWNER),
      RACE_ORGANIZER,
      raceAuth(RACE_ORGANIZER),
      RACE_PLAYER,
      raceAuth(RACE_PLAYER),
    ],
  );
  await db.query(`insert into public.groups(id,name,owner_id) values($1,'Synthetic pix race',$2)`, [
    RACE_GROUP,
    RACE_OWNER,
  ]);
  await db.query(
    `insert into public.group_members(group_id,profile_id,role,status) values
      ($1,$2,'player','active'),($1,$3,'organizer','active'),($1,$4,'player','active')`,
    [RACE_GROUP, RACE_OWNER, RACE_ORGANIZER, RACE_PLAYER],
  );
  await db.query(
    `insert into private.matches(id,group_id,starts_at,ends_at,timezone,location_name,field_slots,field_price,created_by)
     values ($1,$2,now()+interval '2 days',now()+interval '2 days 90 minutes','America/Sao_Paulo','Arena',4,10,$3)`,
    [RACE_MATCH, RACE_GROUP, RACE_OWNER],
  );
  await db.query(
    `insert into private.match_players(match_id,profile_id,status,queue_seq)
     values ($1,$2,'starter',nextval('private.match_queue_seq'))`,
    [RACE_MATCH, RACE_PLAYER],
  );
  await db.query('commit');

  // Validação no Edge: motivo fixo, sem eco da chave.
  for (const [pix, field] of [
    [pixBody('529.982.247-26'), 'pix.key'],
    [pixBody(CPF, 'boleto'), 'pix.type'],
    [{ ...pixBody(CPF), receiver_name: '***' }, 'pix.receiver_name'],
    [{ ...pixBody(CPF), extra: 'x' }, 'pix'],
  ]) {
    const refused = await setPix(organizer, pix);
    expectError(refused, 422, 'VALIDATION', `invalid ${field}`);
    assert.ok(Object.keys(refused.body.error.fields ?? {}).includes(field), field);
    assert.ok(!refused.text.includes('529.982.247-26'), 'a refused key is not echoed');
  }
  console.log('ok - Edge validation refuses with fixed reasons and never echoes the key');

  // Inclusão e as duas grafias da mesma chave sob o mesmo request_id.
  const setRequest = request();
  const created = await setPix(organizer, pixBody(CPF_FORMATTED), setRequest);
  assert.equal(created.status, 200, created.text);
  assert.deepEqual(created.body.data.outcome, {
    group_id: GROUP,
    logical_result: 'pix_set',
    match_id: MATCH,
  });
  assertNoKey(created.text, 'the set response');
  const sameKey = await setPix(organizer, pixBody(CPF), setRequest);
  assert.equal(sameKey.status, 200, sameKey.text);
  assert.deepEqual(sameKey.body.data, created.body.data);
  expectError(
    await setPix(organizer, pixBody(OTHER_EMAIL, 'email'), setRequest),
    409,
    'IDEMPOTENCY_CONFLICT',
    'a different key under the same request_id',
  );
  console.log(
    'ok - HMAC over the normalised open key: two spellings replay, another key conflicts',
  );

  // O banco tem só a cifra: nem a tabela nem a idempotência guardam a chave.
  const stored = (
    await db.query(
      `select pix_key_type, pix_key_last4, pix_receiver_name, pix_receiver_city, octet_length(pix_key_ciphertext) n,
              encode(pix_key_ciphertext,'hex') hex, encode(pix_key_ciphertext,'escape') raw
         from private.match_payment_secrets where match_id=$1`,
      [MATCH],
    )
  ).rows[0];
  assert.deepEqual(
    [stored.pix_key_type, stored.pix_key_last4, stored.pix_receiver_name, stored.pix_receiver_city],
    ['cpf', '4725', 'DONA DO RACHA', 'SAO PAULO'],
  );
  assert.equal(stored.n, 12 + CPF.length + 16, 'nonce, ciphertext of the key, tag');
  assertNoKey(stored.hex, 'the ciphertext hex');
  assertNoKey(stored.raw, 'the ciphertext bytes');
  const records = (
    await db.query(
      `select coalesce(string_agg(to_jsonb(r)::text, ' '), '') t from private.idempotency_records r where actor_id=$1`,
      [organizer.profileId],
    )
  ).rows[0].t;
  assert.ok(records.includes('set_match_pix'), 'the operation was recorded');
  assertNoKey(records, 'the idempotency records');
  console.log('ok - the database holds only the AES-GCM envelope; idempotency keeps no key');

  // Censo do dump: o banco inteiro, não só as duas tabelas. A chave não aparece
  // em nenhuma forma; nome e cidade só no COPY de match_payment_secrets.
  const dump = execFileSync(
    'docker',
    ['exec', 'supabase_db_colete', 'pg_dump', '-U', 'postgres', '--data-only', 'postgres'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  );
  assert.ok(dump.includes('COPY private.match_payment_secrets'), 'the dump covers the Pix table');
  assertNoKey(dump, 'the database dump');
  const pixBlock = dump.match(/^COPY private\.match_payment_secrets [^\n]*\n[\s\S]*?^\\\.$/m)?.[0];
  assert.ok(pixBlock?.includes('DONA DO RACHA'), 'the receiver is in the Pix COPY block');
  const outsidePix = dump.replace(pixBlock, '');
  assertNoReceiver(outsidePix, 'the dump outside match_payment_secrets');
  console.log(
    'ok - pg_dump of the whole database: no key in text, formatted, hex or base64; receiver only in its columns',
  );

  // Leitura: jogador confirmado e não pago recebe a chave aberta.
  const read = await readPix(player);
  assert.equal(read.status, 200, read.text);
  assert.deepEqual(
    { ...read.body.data, set_at: typeof read.body.data.set_at },
    {
      type: 'cpf',
      key: CPF,
      receiver_name: 'DONA DO RACHA',
      receiver_city: 'SAO PAULO',
      amount: '17.50',
      set_by_name: 'Synthetic pix organizer',
      set_at: 'string',
      replaced: false,
    },
  );
  assert.ok(!read.text.includes('ciphertext') && !read.text.includes('last4'), 'no envelope');
  assert.match(read.headers.get('cache-control') ?? '', /no-store/, 'the read is never cached');
  expectError(await readPix(organizer, ENDED), 404, 'PIX_NOT_CONFIGURED', 'ended 61 days ago');
  console.log(
    'ok - an unpaid starter reads the opened key with no-store; nothing else of the envelope leaves',
  );

  // Pagamento marcado: o pagador não lê; trocar e remover travam.
  await db.query(
    `update private.match_players set paid=true,payment_marked_by=$3,payment_marked_at=now()
      where match_id=$1 and profile_id=$2`,
    [MATCH, payer.profileId, organizer.profileId],
  );
  expectError(await readPix(payer), 403, 'FORBIDDEN', 'a paid player');
  expectError(await setPix(organizer, pixBody(OTHER_EMAIL, 'email')), 409, 'PIX_LOCKED', 'replace');
  expectError(await setPix(organizer, null), 409, 'PIX_LOCKED', 'remove');
  expectError(await setPix(player, null), 404, 'NOT_FOUND', 'a player cannot manage the Pix');
  await db.query(
    `update private.match_players set paid=false,payment_marked_by=null,payment_marked_at=null
      where match_id=$1 and profile_id=$2`,
    [MATCH, payer.profileId],
  );
  const replaced = await setPix(organizer, pixBody(OTHER_EMAIL, 'email'));
  assert.equal(replaced.body.data?.outcome.logical_result, 'pix_set', replaced.text);
  const reread = await readPix(payer);
  assert.equal(reread.body.data?.key, OTHER_EMAIL);
  assert.equal(reread.body.data?.replaced, true);
  console.log('ok - payment locks replace and remove; unmarked, the replacement is flagged');

  // Sem o segredo, as duas operações falham INTERNAL antes da RPC.
  runtime = await startDirectEdge({ PIX_KEY_ENC_KEY_V1: undefined });
  const before = (
    await db.query('select count(*)::int n from private.idempotency_records where actor_id=$1', [
      organizer.profileId,
    ])
  ).rows[0].n;
  expectError(
    await setPix(organizer, pixBody(CPF), request(), runtime.url),
    500,
    'INTERNAL',
    'set without the secret',
  );
  expectError(
    await readPix(player, MATCH, runtime.url),
    500,
    'INTERNAL',
    'read without the secret',
  );
  // The read authorises in the RPC first: whoever may not read keeps the same
  // answer without the secret.
  await db.query(
    `update private.match_players set paid=true,payment_marked_by=$3,payment_marked_at=now()
      where match_id=$1 and profile_id=$2`,
    [MATCH, payer.profileId, organizer.profileId],
  );
  expectError(
    await readPix(payer, MATCH, runtime.url),
    403,
    'FORBIDDEN',
    'a paid player without the secret',
  );
  await db.query(
    `update private.match_players set paid=false,payment_marked_by=null,payment_marked_at=null
      where match_id=$1 and profile_id=$2`,
    [MATCH, payer.profileId],
  );
  const removedWithout = await setPix(organizer, null, request(), runtime.url);
  assert.equal(
    removedWithout.body.data?.outcome.logical_result,
    'pix_removed',
    removedWithout.text,
  );
  const after = (
    await db.query('select count(*)::int n from private.idempotency_records where actor_id=$1', [
      organizer.profileId,
    ])
  ).rows[0].n;
  assert.equal(after, before + 1, 'only the removal reached the database');
  await runtime.stop();
  runtime = undefined;
  expectError(await readPix(organizer), 404, 'PIX_NOT_CONFIGURED', 'after removal');
  console.log(
    'ok - without PIX_KEY_ENC_KEY_V1, set answers INTERNAL before any RPC, read only to whom may read; removal still works',
  );

  // Worker real: o job existe e roda com o segredo de cron local.
  await db.query(`delete from private.job_runs where job_name='purge_match_pix'
    and scheduled_for > clock_timestamp() - interval '2 days'`);
  const worker = await fetch(`${functionsUrl}/worker/purge_match_pix`, {
    method: 'POST',
    headers: {
      apikey: publishable,
      Authorization: `Bearer ${localWorkerCronSecret()}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(worker.status, 200, 'worker purge_match_pix');
  assert.equal(
    (
      await db.query(
        `select status from private.job_runs where job_name='purge_match_pix' order by id desc limit 1`,
      )
    ).rows[0]?.status,
    'succeeded',
  );
  console.log('ok - purge_match_pix runs through the real worker');

  // Corrida leave_group x set_match_pix nas duas ordens: a trava do grupo
  // serializa as duas; nenhuma ordem deixa Pix ativo de quem saiu, e nenhuma
  // termina em deadlock.
  const raceRpc = (client, sql, actor, args) =>
    client.query(`select public.${sql} as r`, [
      raceAuth(actor),
      '37900000-0000-4000-8000-000000000000',
      crypto.randomUUID(),
      'a'.repeat(64),
      1,
      1,
      ...args,
    ]);
  const racePix = {
    type: 'cpf',
    ciphertext: RACE_CIPHER,
    key_version: 1,
    last4: '4725',
    receiver_name: 'ORG',
    receiver_city: 'SAO PAULO',
  };
  const setRace = (client) =>
    raceRpc(client, 'set_match_pix($1,$2,$3,$4,$5,$6,$7::uuid,$8::jsonb)', RACE_ORGANIZER, [
      RACE_MATCH,
      JSON.stringify(racePix),
    ]);
  const leaveRace = (client) =>
    raceRpc(client, 'leave_group($1,$2,$3,$4,$5,$6,$7::uuid)', RACE_ORGANIZER, [RACE_GROUP]);
  const raceState = async () =>
    (
      await db.query('select state from private.match_payment_secrets where match_id=$1', [
        RACE_MATCH,
      ])
    ).rows[0]?.state ?? 'none';
  for (const leaveFirst of [true, false]) {
    await db.query('begin');
    await db.query('delete from private.match_payment_secrets where match_id=$1', [RACE_MATCH]);
    await db.query(
      "update public.group_members set status='active',removed_at=null where group_id=$1 and profile_id=$2",
      [RACE_GROUP, RACE_ORGANIZER],
    );
    await db.query('commit');
    await first.query('begin');
    await first.query('set local role service_role');
    await second.query('begin');
    await second.query('set local role service_role');
    if (leaveFirst) await leaveRace(first);
    else await setRace(first);
    const trailing = track(leaveFirst ? setRace(second) : leaveRace(second));
    await awaitLockWait(
      db,
      trailing,
      pids.second,
      pids.first,
      `${leaveFirst ? 'leave' : 'set'} first`,
      'colete_pix_',
    );
    await first.query('commit');
    const result = await trailing.settled;
    if (leaveFirst) {
      assert.equal(result.status, 'rejected', 'set after leave is refused');
      assert.equal(result.reason.message, 'NOT_FOUND');
      await second.query('rollback');
      assert.equal(await raceState(), 'none');
    } else {
      assert.equal(result.status, 'fulfilled', `leave after set concludes: ${result.reason}`);
      await second.query('commit');
      assert.equal(await raceState(), 'purged', 'the leave purged the Pix just set');
    }
  }
  console.log(
    'ok - leave_group x set_match_pix in both orders: observed wait, real COMMIT, no deadlock, no Pix left behind',
  );

  // Corrida set_match_payment x set_match_pix nas duas ordens: pagar antes
  // trava a troca; trocar antes deixa o Pix novo e o pagamento depois dele.
  const payRace = (client) =>
    raceRpc(client, 'set_match_payment($1,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9)', RACE_ORGANIZER, [
      RACE_MATCH,
      RACE_PLAYER,
      true,
    ]);
  const payState = async () =>
    (
      await db.query(
        `select encode(secret.pix_key_ciphertext,'base64') cipher, secret.state,
                secret.set_at, player.paid, player.payment_marked_at
           from private.match_payment_secrets secret
           join private.match_players player on player.match_id = secret.match_id
          where secret.match_id=$1 and player.profile_id=$2`,
        [RACE_MATCH, RACE_PLAYER],
      )
    ).rows[0];
  for (const payFirst of [true, false]) {
    await db.query('begin');
    await db.query(
      "update public.group_members set status='active',removed_at=null where group_id=$1 and profile_id=$2",
      [RACE_GROUP, RACE_ORGANIZER],
    );
    await db.query(
      `update private.match_players set paid=false,payment_marked_by=null,payment_marked_at=null
        where match_id=$1 and profile_id=$2`,
      [RACE_MATCH, RACE_PLAYER],
    );
    await db.query('delete from private.match_payment_secrets where match_id=$1', [RACE_MATCH]);
    await db.query(
      `insert into private.match_payment_secrets (match_id, state, pix_key_type, pix_key_ciphertext,
         pix_key_key_version, pix_key_last4, pix_receiver_name, pix_receiver_city, set_by, set_at)
       values ($1,'active','cpf',$2,1,'0001',$4,$5,$3,now() - interval '1 hour')`,
      [RACE_MATCH, RACE_OLD_CIPHER, RACE_ORGANIZER, racePix.receiver_name, racePix.receiver_city],
    );
    await db.query('commit');
    await first.query('begin');
    await first.query('set local role service_role');
    await second.query('begin');
    await second.query('set local role service_role');
    if (payFirst) await payRace(first);
    else await setRace(first);
    const trailing = track(payFirst ? setRace(second) : payRace(second));
    await awaitLockWait(
      db,
      trailing,
      pids.second,
      pids.first,
      `${payFirst ? 'pay' : 'replace'} first`,
      'colete_pix_',
    );
    await first.query('commit');
    const result = await trailing.settled;
    const state = await payState();
    if (payFirst) {
      assert.equal(result.status, 'rejected', 'replace after a payment is refused');
      assert.equal(result.reason.message, 'PIX_LOCKED');
      await second.query('rollback');
      assert.equal(state.cipher, RACE_OLD_CIPHER.toString('base64'), 'the paid Pix is unchanged');
      assert.equal(state.paid, true);
    } else {
      assert.equal(result.status, 'fulfilled', `payment after replace concludes: ${result.reason}`);
      await second.query('commit');
      const after = await payState();
      assert.equal(after.cipher, RACE_CIPHER, 'the replacement stands');
      assert.equal(after.state, 'active');
      assert.equal(after.paid, true);
      assert.ok(after.set_at <= after.payment_marked_at, 'the payment comes after the replacement');
    }
  }
  console.log(
    'ok - set_match_payment x set_match_pix in both orders: observed wait, pay first locks, replace first stands',
  );

  // Sessão revogada pelo HTTP real: a leitura recusa UNAUTHENTICATED.
  const revoked = await post(functionsUrl, player, 'identity/revoke_current_session', {
    request_id: request(),
  });
  assert.equal(revoked.status, 200, revoked.text);
  const again = await setPix(organizer, pixBody(CPF));
  assert.equal(again.body.data?.outcome.logical_result, 'pix_set', again.text);
  const deniedRead = await readPix(player);
  expectError(deniedRead, 401, 'UNAUTHENTICATED', 'a revoked session reads');
  assert.equal(Object.hasOwn(deniedRead.body, 'data'), false);
  assertNoKey(deniedRead.text, 'the revoked read');
  console.log('ok - a revoked session cannot read the Pix over HTTP');
  // Nenhum log do stack carrega a chave aberta.
  for (const service of ['edge_runtime', 'rest', 'db', 'kong', 'auth']) {
    const logs = execFileSync(
      'sh',
      ['-c', 'docker logs --since "$1" "$2" 2>&1', 'sh', startedAt, `supabase_${service}_colete`],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    assertNoKey(logs, `the ${service} logs`);
    assertNoReceiver(logs, `the ${service} logs`);
  }
  console.log('ok - no container log of the local stack carries the open key or the receiver');
} finally {
  if (runtime) await runtime.stop();
  await Promise.allSettled([first, second].map((client) => client.query('rollback')));
  await db.query('rollback').catch(() => {});
  await db.query('begin');
  const ids = [
    ...users.map((user) => user.profileId).filter(Boolean),
    RACE_OWNER,
    RACE_ORGANIZER,
    RACE_PLAYER,
  ];
  await db.query('delete from private.idempotency_records where actor_id = any($1::uuid[])', [ids]);
  await db.query(`delete from private.job_runs where job_name='purge_match_pix'`);
  await db.query(`delete from private.retention_runs where policy='purge_match_pix'`);
  const groups = [GROUP, RACE_GROUP];
  const inGroups = 'select id from private.matches where group_id = any($1::uuid[])';
  await db.query(`delete from private.match_payment_secrets where match_id in (${inGroups})`, [
    groups,
  ]);
  await db.query(`delete from private.match_players where match_id in (${inGroups})`, [groups]);
  await db.query('delete from private.matches where group_id = any($1::uuid[])', [groups]);
  await db.query('delete from public.group_members where group_id = any($1::uuid[])', [groups]);
  await db.query('delete from public.groups where id = any($1::uuid[])', [groups]);
  await db.query('delete from private.revoked_auth_sessions where profile_id = any($1::uuid[])', [
    ids,
  ]);
  await db.query('delete from public.profiles where id = any($1::uuid[])', [ids]);
  await db.query("delete from auth.users where id::text like '37000000-%'");
  await db.query('commit');
  for (const user of users) {
    const removed = await fetch(`${apiUrl}/auth/v1/admin/users/${user.authId}`, {
      method: 'DELETE',
      headers: { apikey: secret, Authorization: `Bearer ${secret}` },
    });
    assert.ok([200, 204, 404].includes(removed.status));
  }
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from private.match_payment_secrets where match_id::text like '37300000-%'",
      )
    ).rows[0].n,
    0,
  );
  await Promise.allSettled(Object.values(clients).map((client) => client.end()));
}
console.log('ok - no Pix fixture residue');
