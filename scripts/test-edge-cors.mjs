import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { startDirectEdge } from './local-edge-runtime.mjs';
import { corsFixture } from './cors-fixture.mjs';

const ORIGIN = 'https://colete.example.invalid';
const HEADERS = 'authorization, apikey, content-type, x-client-info';
const configuration = { APP_ALLOWED_ORIGINS: ORIGIN, COLETE_LOCAL_STACK: undefined };
let checks = 0;
function headers(response, origin, method) {
  assert.ok(
    response.headers
      .get('vary')
      .split(',')
      .some((part) => part.trim().toLowerCase() === 'origin'),
  );
  const actual = Object.fromEntries(
    [...response.headers].filter(([name]) => name.startsWith('access-control')),
  );
  assert.deepEqual(
    actual,
    origin
      ? {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': method,
          'access-control-allow-headers': HEADERS,
          'access-control-max-age': '600',
        }
      : {},
  );
}
function raw(baseUrl, method, target, headerLines, body) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname);
    const chunks = [];
    const timer = setTimeout(() => socket.destroy(new Error('raw request timeout')), 15000);
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('latin1');
      const split = text.indexOf('\r\n\r\n');
      const head = split < 0 ? text : text.slice(0, split);
      let rest = split < 0 ? '' : text.slice(split + 4);
      const [statusLine, ...lines] = head.split('\r\n');
      const headers = {};
      for (const line of lines) {
        const i = line.indexOf(':');
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        headers[k] = headers[k] === undefined ? v : `${headers[k]} | ${v}`;
      }
      if ((headers['transfer-encoding'] ?? '').toLowerCase() === 'chunked') {
        let decoded = '';
        for (;;) {
          const eol = rest.indexOf('\r\n');
          const size = parseInt(rest.slice(0, eol), 16);
          if (!(size > 0)) break;
          decoded += rest.slice(eol + 2, eol + 2 + size);
          rest = rest.slice(eol + 2 + size + 2);
        }
        rest = decoded;
      }
      resolve({
        status: Number(statusLine.split(' ')[1]),
        headers,
        body: Buffer.from(rest, 'latin1').toString('utf8'),
      });
    });
    const parts = [Buffer.from(`${method} ${target} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n`)];
    for (const [k, v] of headerLines) {
      parts.push(
        Buffer.concat([
          Buffer.from(`${k}: `),
          Buffer.isBuffer(v) ? v : Buffer.from(v, 'latin1'),
          Buffer.from('\r\n'),
        ]),
      );
    }
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
    if (body !== undefined) parts.push(Buffer.from(`content-length: ${payload.length}\r\n`));
    parts.push(Buffer.from('connection: close\r\n\r\n'), payload);
    // No half-close: the Docker port proxy drops the upstream on client FIN.
    socket.write(Buffer.concat(parts));
  });
}

const fixture = await corsFixture();
let runtime;
try {
  runtime = await startDirectEdge(configuration);
  const owner = await fixture.actor(runtime.url);
  const census = async () =>
    (
      await fixture.db.query(`select
    (select count(*) from private.idempotency_records)::integer as idempotency,
    (select count(*) from private.invite_rate_limits)::integer as rate,
    (select count(*) from private.external_effects)::integer as effects,
    (select count(*) from private.job_runs)::integer as jobs,
    (select count(*) from public.profiles)::integer as profiles,
    (select count(*) from public.groups)::integer as groups,
    (select count(*) from public.group_members)::integer as members,
    (select count(*) from public.group_invites)::integer as invites,
    (select count(*) from public.privacy_requests)::integer as privacy,
    (select count(*) from auth.sessions)::integer as sessions,
    (select count(*) from auth.audit_log_entries)::integer as auth_audit`)
    ).rows[0];
  const before = await census();
  for (const [route, method] of [
    ['identity/complete_profile', 'POST'],
    ['groups/create_group', 'POST'],
    ['data-exports/00000000-0000-4000-8000-000000000001/content', 'GET'],
  ]) {
    for (const [origin, requestedMethod, requestedHeaders, allowed] of [
      [ORIGIN, method, HEADERS, true],
      ['https://evil.example.invalid', method, HEADERS, false],
      [undefined, method, HEADERS, false],
      ['https://sub.colete.example.invalid', method, HEADERS, false],
      [`${ORIGIN}:8443`, method, HEADERS, false],
      ['http://colete.example.invalid', method, HEADERS, false],
      [`${ORIGIN}.evil.com`, method, HEADERS, false],
      ['https://COLETE.example.invalid', method, HEADERS, false],
      ['HTTPS://colete.example.invalid', method, HEADERS, false],
      [`${ORIGIN}.`, method, HEADERS, false],
      [`${ORIGIN}, https://evil.example.invalid`, method, HEADERS, false],
      ['null', method, HEADERS, false],
      [ORIGIN, 'post', HEADERS, false],
      [ORIGIN, 'DELETE', HEADERS, false],
      [ORIGIN, method, 'x-unexpected', false],
    ]) {
      const response = await fetch(`${runtime.url}/${route}`, {
        method: 'OPTIONS',
        headers: {
          ...(origin ? { Origin: origin } : {}),
          Authorization: `Bearer ${owner.token}`,
          'content-type': 'application/json',
          'Access-Control-Request-Method': requestedMethod,
          'Access-Control-Request-Headers': requestedHeaders,
        },
        body: JSON.stringify(
          route.startsWith('groups/')
            ? { request_id: crypto.randomUUID(), name: 'Preflight must not create a group' }
            : { request_id: crypto.randomUUID(), profile: { name: 'Preflight fixture' } },
        ),
      });
      assert.equal(response.status, 204, `${route}: preflight must run before authentication`);
      assert.equal(await response.text(), '');
      headers(response, allowed ? ORIGIN : undefined, method);
      checks++;
    }
  }
  for (const [route, method] of [
    ['identity/complete_profile', 'POST'],
    ['groups/create_group', 'POST'],
    ['data-exports/00000000-0000-4000-8000-000000000001/content', 'GET'],
  ]) {
    const response = await raw(
      runtime.url,
      'OPTIONS',
      `/${route}`,
      [
        ['Origin', ORIGIN],
        ['Origin', 'https://evil.example.invalid'],
        ['Authorization', `Bearer ${owner.token}`],
        ['content-type', 'application/json'],
        ['Access-Control-Request-Method', method],
        ['Access-Control-Request-Headers', HEADERS],
      ],
      JSON.stringify({ request_id: crypto.randomUUID(), name: 'Repeated origin fixture' }),
    );
    assert.equal(response.status, 204, `${route}: repeated Origin preflight`);
    headers(
      new Response(null, { status: response.status, headers: response.headers }),
      undefined,
      method,
    );
    checks++;
  }
  assert.deepEqual(await census(), before, 'all preflights have zero database effects');
  console.log(
    'ok - 48 credentialed direct preflights, strict origins/methods/headers, database census unchanged',
  );
  const worker = await fetch(`${runtime.url}/worker/process_external_effects`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN },
  });
  assert.equal(worker.status, 405);
  assert.deepEqual(
    [...worker.headers].filter(([key]) => key.startsWith('access-control')),
    [],
  );
  const workerPost = await fetch(`${runtime.url}/worker/process_external_effects`, {
    method: 'POST',
    headers: { Origin: ORIGIN },
  });
  assert.equal(workerPost.status, 401);
  assert.deepEqual(
    [...workerPost.headers].filter(([key]) => key.startsWith('access-control')),
    [],
  );
  console.log('ok - worker OPTIONS denied and POST unauthenticated, no CORS');

  const call = async (route, body, token, status, code, origin = ORIGIN, method = 'POST') => {
    const response = await fetch(`${runtime.url}/${route}`, {
      method,
      headers: {
        ...(origin ? { Origin: origin } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, status, `${route}: expected ${status}`);
    headers(response, origin === ORIGIN ? origin : undefined, method === 'GET' ? 'GET' : 'POST');
    const result = await response.json();
    if (code) assert.equal(result.error.code, code);
    checks++;
    return result;
  };
  await call('identity/complete_profile', {}, undefined, 401, 'UNAUTHENTICATED');
  await call('groups/create_group', {}, undefined, 401, 'UNAUTHENTICATED');
  await call('groups/unknown', {}, undefined, 404, 'NOT_FOUND');
  await call(
    'data-exports/00000000-0000-4000-8000-000000000001/content',
    {},
    undefined,
    401,
    'UNAUTHENTICATED',
    ORIGIN,
    'GET',
  );
  await call('data-exports/unknown/content', {}, undefined, 404, 'NOT_FOUND', ORIGIN, 'GET');
  await call(
    'identity/complete_profile',
    {},
    undefined,
    401,
    'UNAUTHENTICATED',
    'https://evil.example.invalid',
  );
  await call('identity/complete_profile', {}, undefined, 401, 'UNAUTHENTICATED', '');
  const other = await fixture.actor(runtime.url);
  await call('identity/update_profile', {}, owner.token, 422, 'VALIDATION');
  await call(
    'identity/update_profile',
    { request_id: crypto.randomUUID(), patch: { name: 'CORS updated fixture' } },
    owner.token,
    200,
  );
  for (const origin of [
    'https://evil.example.invalid',
    'https://COLETE.example.invalid',
    'HTTPS://colete.example.invalid',
    `${ORIGIN}.`,
    `${ORIGIN}, https://evil.example.invalid`,
    'null',
  ]) {
    await call(
      'identity/update_profile',
      { request_id: crypto.randomUUID(), patch: { name: 'Denied-origin successful fixture' } },
      owner.token,
      200,
      undefined,
      origin,
    );
  }
  const repeatedSuccess = await raw(
    runtime.url,
    'POST',
    '/identity/update_profile',
    [
      ['Origin', ORIGIN],
      ['Origin', 'https://evil.example.invalid'],
      ['Authorization', `Bearer ${owner.token}`],
      ['content-type', 'application/json'],
    ],
    JSON.stringify({ request_id: crypto.randomUUID(), patch: { name: 'Repeated origin success' } }),
  );
  assert.equal(repeatedSuccess.status, 200, 'authenticated real 200 with repeated Origin');
  headers(new Response(null, { status: 200, headers: repeatedSuccess.headers }), undefined, 'POST');
  checks++;
  const requestId = crypto.randomUUID();
  const created = await call(
    'groups/create_group',
    { request_id: requestId, name: 'CORS group' },
    owner.token,
    200,
  );
  const groupId = created.data.outcome.group_id;
  await call(
    'groups/create_group',
    { request_id: requestId, name: 'Different group' },
    owner.token,
    409,
    'IDEMPOTENCY_CONFLICT',
  );
  await call(
    'groups/rename_group',
    { request_id: crypto.randomUUID(), group_id: groupId, name: 'Denied group' },
    other.token,
    403,
    'NOT_MEMBER',
  );
  await fixture.db.query('update public.groups set archived_at=now() where id=$1', [groupId]);
  await call(
    'groups/rename_group',
    { request_id: crypto.randomUUID(), group_id: groupId, name: 'Archived group' },
    owner.token,
    410,
    'GROUP_ARCHIVED',
  );
  const exportId = crypto.randomUUID();
  const privacyId = crypto.randomUUID();
  const storagePath = `exports/${owner.profileId}/${exportId}.zip`;
  const bytes = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  let uploaded = false;
  try {
    await fixture.db.query(
      "insert into public.privacy_requests(id,profile_id,kind) values($1,$2,'access')",
      [privacyId, owner.profileId],
    );
    await fixture.db.query(
      `insert into private.data_exports(id,privacy_request_id,profile_id,status,storage_path,content_digest,ready_at,expires_at)
      values($1,$2,$3,'ready',$4,$5,now(),now()+interval '1 hour')`,
      [
        exportId,
        privacyId,
        owner.profileId,
        storagePath,
        crypto.createHash('sha256').update(bytes).digest('hex'),
      ],
    );
    const upload = await fetch(
      `${fixture.env.apiUrl}/storage/v1/object/data-exports/${storagePath}`,
      {
        method: 'POST',
        headers: { apikey: fixture.env.secretKey, 'content-type': 'application/zip' },
        body: bytes,
      },
    );
    assert.equal(upload.status, 200, 'synthetic ZIP fixture upload');
    uploaded = true;
    const response = await fetch(`${runtime.url}/data-exports/${exportId}/content`, {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${owner.token}` },
    });
    assert.equal(response.status, 200, 'real export handler success');
    headers(response, ORIGIN, 'GET');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.equal(
      response.headers.get('content-disposition'),
      `attachment; filename="colete-${exportId}.zip"`,
    );
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      bytes,
      'CORS wrapper preserves the stream bytes',
    );
    checks++;
    await call(
      `data-exports/${exportId}/content`,
      {},
      owner.token,
      410,
      'EXPORT_EXPIRED',
      ORIGIN,
      'GET',
    );
  } finally {
    if (uploaded) {
      const removed = await fetch(`${fixture.env.apiUrl}/storage/v1/object/data-exports`, {
        method: 'DELETE',
        headers: { apikey: fixture.env.secretKey, 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: [storagePath] }),
      });
      assert.equal(removed.status, 200, 'synthetic ZIP fixture cleanup');
    }
    await fixture.db.query('delete from private.external_effects where resource_id=$1', [exportId]);
    await fixture.db.query('delete from private.data_exports where id=$1', [exportId]);
    await fixture.db.query('delete from public.privacy_requests where id=$1', [privacyId]);
  }
  console.log(
    'ok - real export 200 stream bytes, one-shot 410, private no-store and disposition retained',
  );
  const limit = (
    await fixture.db.query(
      "select * from private.app_limits where limit_key='invite_attempts_per_hour'",
    )
  ).rows[0];
  try {
    await fixture.db.query(
      "update private.app_limits set limit_value=1 where limit_key='invite_attempts_per_hour'",
    );
    await call(
      'groups/preview_group_by_code',
      { code: 'INVALID' },
      other.token,
      400,
      'CODE_INVALID',
    );
    await call(
      'groups/preview_group_by_code',
      { code: 'INVALID' },
      other.token,
      429,
      'RATE_LIMITED',
    );
    await fixture.db.query(
      "delete from private.app_limits where limit_key='invite_attempts_per_hour'",
    );
    await call(
      'groups/preview_group_by_code',
      { code: 'INVALID' },
      other.token,
      503,
      'RATE_LIMIT_UNAVAILABLE',
    );
  } finally {
    await fixture.db.query(
      `insert into private.app_limits select * from jsonb_populate_record(null::private.app_limits,$1::jsonb) on conflict (limit_key) do update set limit_value=excluded.limit_value`,
      [JSON.stringify(limit)],
    );
  }
  console.log(
    'ok - real Auth/database responses 200/401/403/404/409/410/422/429/503 preserve CORS and envelopes',
  );
  await runtime.stop();
  runtime = undefined;
  runtime = await startDirectEdge({ ...configuration, IDEMPOTENCY_HMAC_KEY_V1: undefined });
  await call(
    'identity/update_profile',
    { request_id: crypto.randomUUID(), patch: { name: 'Missing HMAC fixture' } },
    owner.token,
    500,
    'INTERNAL',
  );
  console.log('ok - real handler 500 with missing synthetic HMAC retains CORS');
  await runtime.stop();
  runtime = undefined;
  for (const invalid of [
    undefined,
    '',
    '*',
    `${ORIGIN}/path`,
    `${ORIGIN},*`,
    `${ORIGIN},`,
    `${ORIGIN},https://co lete.example.invalid`,
  ]) {
    runtime = await startDirectEdge({
      APP_ALLOWED_ORIGINS: invalid,
      COLETE_LOCAL_STACK: undefined,
    });
    for (const method of ['OPTIONS', 'POST']) {
      const response = await fetch(`${runtime.url}/identity/complete_profile`, {
        method,
        headers: {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': HEADERS,
        },
      });
      assert.equal(response.status, method === 'OPTIONS' ? 204 : 401);
      headers(response, undefined, 'POST');
      checks++;
    }
    await runtime.stop();
    runtime = undefined;
  }
  runtime = await startDirectEdge({
    APP_ALLOWED_ORIGINS: `  ${ORIGIN}  , https://other.example.invalid  `,
    COLETE_LOCAL_STACK: undefined,
  });
  const trimmed = await fetch(`${runtime.url}/identity/complete_profile`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(trimmed.status, 204, 'outer item whitespace is removed');
  headers(trimmed, ORIGIN, 'POST');
  checks++;
  console.log(
    `ok - missing/empty/wildcard/path/mixed invalid deployment configuration fails closed; ${checks} HTTP checks`,
  );
} finally {
  try {
    if (runtime) await runtime.stop();
  } finally {
    await fixture.close();
  }
}
