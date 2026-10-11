// Read-only checks. Run by the human operator, never with an administrative key.
import { pathToFileURL } from 'node:url';
import { inlineHashes, supabaseOrigin } from './staging-headers.mjs';

export const protectedTables = [
  'profiles',
  'groups',
  'group_memberships',
  'group_invites',
  'data_exports',
];
export const protectedFunctions = [
  'complete_profile',
  'revoke_current_session',
  'delete_account',
  'request_data_export',
  'create_group',
  'rename_group',
  'issue_group_invite',
  'dispatch_worker_job',
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
  return { api, key, app };
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
  let schema;
  await check('PostgREST >= 16.3', async () => {
    const response = await fetcher(`${config.api}/rest/v1/`, { headers });
    if (!response.ok) return false;
    schema = await response.json();
    const match = /^([0-9]+)\.([0-9]+)(?:\.[0-9]+)?/.exec(schema.info?.version ?? '');
    return !!match && (+match[1] > 16 || (+match[1] === 16 && +match[2] >= 3));
  });
  await check(
    'Sensitive RPCs absent from the anonymous OpenAPI schema',
    async () =>
      !!schema?.paths &&
      protectedFunctions.every((name) => !Object.hasOwn(schema.paths, `/rpc/${name}`)),
  );
  for (const table of protectedTables)
    await check(`Anonymous table denied: ${table}`, async () => {
      const response = await fetcher(`${config.api}/rest/v1/${table}?select=*&limit=0`, {
        headers,
      });
      if (![401, 403, 404].includes(response.status)) return false;
      const code = (await response.json()).code;
      return code === '42501' || code === 'PGRST205';
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
  await check('HTTPS invite base equals the app origin', async () => true);
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
    const htmlHashes = inlineHashes(await response.text());
    const script = directives['script-src'] ?? [];
    const connect = directives['connect-src'] ?? [];
    return (
      response.ok &&
      response.headers.get('x-content-type-options') === 'nosniff' &&
      response.headers.get('referrer-policy') === 'no-referrer' &&
      response.headers.get('cache-control')?.includes('no-store') &&
      response.headers.get('permissions-policy')?.includes('camera=()') &&
      script.includes("'self'") &&
      script.every((value) => value === "'self'" || /^'sha256-[A-Za-z0-9+/]{43}='$/.test(value)) &&
      htmlHashes.every((hash) => script.includes(hash)) &&
      connect.length === 3 &&
      !script.includes("'unsafe-inline'") &&
      !script.includes("'unsafe-eval'") &&
      connect.includes(config.api) &&
      connect.includes(config.api.replace(/^http/, 'ws')) &&
      directives['object-src']?.join(' ') === "'none'" &&
      directives['frame-ancestors']?.join(' ') === "'none'" &&
      ['default-src', 'base-uri', 'form-action', 'manifest-src', 'worker-src'].every(
        (name) => directives[name]?.join(' ') === "'self'",
      ) &&
      Object.hasOwn(directives, 'upgrade-insecure-requests')
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
