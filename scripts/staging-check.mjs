// Read-only checks. Run by the human operator, never with an administrative key.
import { pathToFileURL } from 'node:url';
import { inlineHashes, supabaseOrigin, securityHeaders } from './staging-headers.mjs';

export const protectedTables = ['profiles', 'groups', 'group_members', 'group_invites'];
export const protectedFunctions = [
  'complete_profile',
  'revoke_current_session',
  'delete_account',
  'request_data_export',
  'get_own_data_exports',
  'create_group',
  'rename_group',
  'issue_group_invite',
  'create_match',
  'worker_begin_job',
];
export function configuration(env) {
  const api = supabaseOrigin(env.EXPO_PUBLIC_SUPABASE_URL);
  const key = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))
    throw new Error('Only a publishable key is accepted');
  const app = supabaseOrigin(env.STAGING_APP_ORIGIN);
  const share = supabaseOrigin(env.INVITE_SHARE_URL_BASE);
  if (app !== env.STAGING_APP_ORIGIN || share !== env.INVITE_SHARE_URL_BASE || share !== app)
    throw new Error(
      'App and invite base must be the same exact HTTPS origin without trailing slash',
    );
  return { api, key, app, share };
}
export async function checkStaging(env, fetcher = fetch) {
  const config = configuration(env);
  const results = [];
  const check = async (name, action) => {
    try {
      if (!(await action())) throw new Error('check failed');
      results.push({ name, ok: true });
    } catch {
      results.push({ name, ok: false });
    } // Never log response bodies, keys, identities or URLs.
  };
  const headers = { apikey: config.key };
  // Complete named signatures reach the permission check, not PGRST202.
  // Null transport/actor values cannot execute a domain mutation if grants regress.
  const transport = Object.fromEntries(
    [
      'p_actor_auth_user_id',
      'p_actor_session_id',
      'p_request_id',
      'p_input_hmac',
      'p_canonical_version',
      'p_hash_key_version',
    ].map((name) => [name, null]),
  );
  const extras = {
    complete_profile: { p_profile: {} },
    create_group: {
      p_name: null,
      p_invite_id: null,
      p_token_version: null,
      p_nonce_hex: null,
      p_token_digest: null,
      p_code_digest: null,
    },
    rename_group: { p_group_id: null, p_name: null },
    issue_group_invite: {
      p_group_id: null,
      p_new_invite_id: null,
      p_token_version: null,
      p_nonce_hex: null,
      p_token_digest: null,
      p_code_digest: null,
    },
  };
  for (const name of protectedFunctions)
    await check(`Anonymous RPC denied: ${name}`, async () => {
      const response = await fetcher(`${config.api}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          name === 'worker_begin_job'
            ? { p_job_name: null }
            : name === 'get_own_data_exports'
              ? {}
              : { ...transport, ...extras[name] },
        ),
      });
      return response.status === 401 && (await response.json()).code === '42501';
    });
  for (const table of protectedTables)
    await check(`Anonymous table denied: ${table}`, async () => {
      const response = await fetcher(`${config.api}/rest/v1/${table}?select=*&limit=0`, {
        headers,
      });
      if (response.status !== 401) return false;
      return (await response.json()).code === '42501';
    });
  const endpoints = [
    'identity/complete_profile',
    'groups/create_group',
    'data-exports/00000000-0000-4000-8000-000000000001/content',
  ];
  for (const endpoint of endpoints) {
    const url = `${config.api}/functions/v1/${endpoint}`;
    const method = endpoint.startsWith('data-exports/') ? 'GET' : 'POST';
    await check(`Edge without session: ${endpoint.split('/')[0]}`, async () => {
      const response = await fetcher(url, {
        method,
        headers: { ...headers, Origin: config.app, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      return (
        response.status === 401 &&
        (await response.json()).error?.code === 'UNAUTHENTICATED' &&
        response.headers.get('access-control-allow-origin') === config.app
      );
    });
    for (const allowed of [true, false])
      await check(
        `CORS ${allowed ? 'approved' : 'denied'}: ${endpoint.split('/')[0]}`,
        async () => {
          const response = await fetcher(url, {
            method: 'OPTIONS',
            headers: {
              Origin: allowed ? config.app : 'https://denied.example.invalid',
              'Access-Control-Request-Method': method,
              'Access-Control-Request-Headers': 'authorization,apikey,content-type,x-client-info',
            },
          });
          const cors = [...response.headers.keys()].filter((key) =>
            key.startsWith('access-control-'),
          );
          if (!allowed) return cors.length === 0;
          return (
            response.status === 204 &&
            response.headers.get('access-control-allow-origin') === config.app &&
            response.headers
              .get('vary')
              ?.split(',')
              .map((v) => v.trim().toLowerCase())
              .includes('origin') &&
            !response.headers.has('access-control-allow-credentials')
          );
        },
      );
    await check(`Real denied-origin response: ${endpoint.split('/')[0]}`, async () => {
      const response = await fetcher(url, {
        method,
        headers: {
          ...headers,
          Origin: 'https://denied.example.invalid',
          'Content-Type': 'application/json',
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      return (
        response.status === 401 &&
        ![...response.headers.keys()].some((key) => key.startsWith('access-control-'))
      );
    });
  }
  await check('Worker rejects missing cron secret without CORS', async () => {
    const response = await fetcher(`${config.api}/functions/v1/worker/health_check_jobs`, {
      method: 'POST',
      headers: { ...headers, Origin: config.app, 'Content-Type': 'application/json' },
      body: '{}',
    });
    return (
      response.status === 401 &&
      (await response.json()).error === 'UNAUTHENTICATED' &&
      ![...response.headers.keys()].some((key) => key.startsWith('access-control-'))
    );
  });
  await check(
    'Operator input: HTTPS invite base equals the app origin',
    async () => config.share === config.app,
  );
  await check('PWA security headers and HTML cache', async () => {
    const response = await fetcher(config.app, { redirect: 'error' });
    const csp = response.headers.get('content-security-policy') ?? '';
    const entries = csp
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter(([key]) => key)
      .map(([key, ...values]) => [key, values]);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) return false;
    const directives = Object.fromEntries(entries);
    const hashes = [...new Set(inlineHashes(await response.text()))].sort();
    const expected = securityHeaders(config.api, hashes);
    const expectedDirectives = Object.fromEntries(
      expected['Content-Security-Policy'].split('; ').map((entry) => {
        const [name, ...values] = entry.split(/\s+/);
        return [name, values];
      }),
    );
    return (
      response.status === 200 &&
      ['X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy'].every(
        (name) => response.headers.get(name) === expected[name],
      ) &&
      response.headers.get('cache-control') === 'no-store' &&
      Object.keys(directives).length === Object.keys(expectedDirectives).length &&
      Object.entries(expectedDirectives).every(([name, values]) => {
        const actual = directives[name];
        return (
          actual &&
          actual.length === values.length &&
          [...actual].sort().every((value, index) => value === [...values].sort()[index])
        );
      })
    );
  });
  await check('Service worker served without cache', async () => {
    const response = await fetcher(`${config.app}/sw.js`, { redirect: 'error' });
    return (
      response.ok &&
      /javascript/.test(response.headers.get('content-type') ?? '') &&
      response.headers.get('cache-control')?.includes('no-store') &&
      (await response.text()).includes('isCacheablePublicAsset')
    );
  });
  await check('Manifest served without cache', async () => {
    const response = await fetcher(`${config.app}/manifest.webmanifest`, { redirect: 'error' });
    return (
      response.ok &&
      response.headers.get('cache-control')?.includes('no-store') &&
      (await response.json()).display === 'standalone'
    );
  });
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = await checkStaging(process.env);
    for (const result of results) console.log(`${result.ok ? 'OK' : 'FAIL'} ${result.name}`);
    process.exitCode = results.every((result) => result.ok) ? 0 : 1;
  } catch {
    console.error(
      'FAIL configuration: use HTTPS origins and a publishable key; never use service_role',
    );
    process.exitCode = 1;
  }
}
