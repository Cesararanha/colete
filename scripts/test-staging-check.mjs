import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStaging, configuration } from './staging-check.mjs';
import {
  deploymentConfiguration,
  securityHeaders,
  inlineHashes,
  cacheControl,
  supabaseOrigin,
} from './staging-headers.mjs';
const env = {
  EXPO_PUBLIC_SUPABASE_URL: 'https://api.example.invalid',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture',
  STAGING_APP_ORIGIN: 'https://app.example.invalid',
  INVITE_SHARE_URL_BASE: 'https://app.example.invalid',
};
function fake(mutate = () => {}) {
  return async (url, options = {}) => {
    const u = new URL(url);
    let status = 200,
      body = {},
      headers = {};
    if (u.pathname === '/rest/v1/') body = { info: { version: '16.3.0' }, paths: {} };
    else if (u.pathname.startsWith('/rest/v1/')) {
      status = 403;
      body = { code: '42501' };
    } else if (u.pathname.startsWith('/functions/v1/worker/')) {
      status = 401;
      body = { error: 'UNAUTHENTICATED' };
    } else if (u.pathname.startsWith('/functions/v1/')) {
      if (options.method === 'OPTIONS') {
        status = 204;
        body = null;
      } else {
        status = 401;
        body = { error: { code: 'UNAUTHENTICATED' } };
      }
      if (options.headers.Origin === env.STAGING_APP_ORIGIN)
        headers = { 'Access-Control-Allow-Origin': env.STAGING_APP_ORIGIN, Vary: 'Origin' };
    } else if (u.pathname === '/sw.js') {
      body = 'const isCacheablePublicAsset = () => false';
      headers = { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' };
    } else if (u.pathname === '/manifest.webmanifest') {
      body = { display: 'standalone' };
      headers = { 'Cache-Control': 'no-store' };
    } else {
      body = '<script>abc</script>';
      headers = {
        ...securityHeaders(env.EXPO_PUBLIC_SUPABASE_URL, inlineHashes('<script>abc</script>')),
        'Cache-Control': 'no-store',
      };
    }
    const state = { status, body, headers };
    mutate(u, options, state);
    return new Response(
      state.body === null
        ? null
        : typeof state.body === 'string'
          ? state.body
          : JSON.stringify(state.body),
      { status: state.status, headers: state.headers },
    );
  };
}
test('all read-only checks pass against the complete fake deployment', async () =>
  assert.ok((await checkStaging(env, fake())).every((r) => r.ok)));
for (const key of ['sb_secret_fixture', 'service_role', 'eyJhbGciOiJIUzI1NiJ9.fixture.fixture', ''])
  test(`reject unsafe credential ${key.split('.')[0]}`, () =>
    assert.throws(() => configuration({ ...env, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key })));
for (const [label, mutate] of [
  [
    'old PostgREST',
    (u, o, s) => {
      if (u.pathname === '/rest/v1/') s.body.info.version = '16.2.9';
    },
  ],
  [
    'missing version',
    (u, o, s) => {
      if (u.pathname === '/rest/v1/') delete s.body.info;
    },
  ],
  [
    'exposed internal RPC',
    (u, o, s) => {
      if (u.pathname === '/rest/v1/') s.body.paths['/rpc/create_group'] = {};
    },
  ],
  [
    'table accessible',
    (u, o, s) => {
      if (u.pathname === '/rest/v1/profiles') {
        s.status = 200;
        s.body = [];
      }
    },
  ],
  [
    'unrelated 404',
    (u, o, s) => {
      if (u.pathname === '/rest/v1/profiles') {
        s.status = 404;
        s.body.code = 'unrelated';
      }
    },
  ],
  [
    'Edge authenticates anonymous caller',
    (u, o, s) => {
      if (u.pathname.startsWith('/functions/') && o.method !== 'OPTIONS') s.status = 200;
    },
  ],
  [
    'allowed origin absent',
    (u, o, s) => {
      if (o.headers?.Origin === env.STAGING_APP_ORIGIN)
        delete s.headers['Access-Control-Allow-Origin'];
    },
  ],
  [
    'denied origin reflected',
    (u, o, s) => {
      if (o.headers?.Origin === 'https://denied.example.invalid')
        s.headers['Access-Control-Allow-Origin'] = o.headers.Origin;
    },
  ],
  [
    'CORS wildcard',
    (u, o, s) => {
      if (o.headers?.Origin) s.headers['Access-Control-Allow-Origin'] = '*';
    },
  ],
  [
    'CORS credentials',
    (u, o, s) => {
      if (o.method === 'OPTIONS') s.headers['Access-Control-Allow-Credentials'] = 'true';
    },
  ],
  [
    'missing security headers',
    (u, o, s) => {
      if (u.origin === env.STAGING_APP_ORIGIN && u.pathname === '/') s.headers = {};
    },
  ],
  [
    'unsafe script CSP',
    (u, o, s) => {
      if (s.headers['Content-Security-Policy'])
        s.headers['Content-Security-Policy'] += "; script-src 'self' 'unsafe-inline'";
    },
  ],
  [
    'cached service worker',
    (u, o, s) => {
      if (u.pathname === '/sw.js') s.headers['Cache-Control'] = 'max-age=3600';
    },
  ],
  [
    'HTML fallback instead of worker',
    (u, o, s) => {
      if (u.pathname === '/sw.js') s.headers['Content-Type'] = 'text/html';
    },
  ],
  [
    'invalid manifest',
    (u, o, s) => {
      if (u.pathname === '/manifest.webmanifest') s.body.display = 'browser';
    },
  ],
])
  test(label, async () => assert.ok((await checkStaging(env, fake(mutate))).some((r) => !r.ok)));
test('network errors are sanitized and fail', async () =>
  assert.ok(
    (
      await checkStaging(env, async () => {
        throw new Error('secret');
      })
    ).some((r) => !r.ok),
  ));
for (const bad of [
  'http://app.example.invalid',
  'https://app.example.invalid/',
  'https://app.example.invalid/path',
])
  test(`reject app origin ${bad}`, () =>
    assert.throws(() => configuration({ ...env, STAGING_APP_ORIGIN: bad })));
test('hashes exact inline bytes and omits external scripts', () =>
  assert.deepEqual(inlineHashes('<script>abc</script><script src="x.js"></script>'), [
    "'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='",
  ]));
test('deployment excludes fixture origins and requires HTTPS', () => {
  assert.throws(() =>
    securityHeaders(env.EXPO_PUBLIC_SUPABASE_URL, [], { directOrigins: ['http://127.0.0.1:1'] }),
  );
  assert.throws(() => supabaseOrigin('http://example.invalid'));
});
test('hashed assets immutable; HTML and worker never cached', () => {
  assert.match(cacheControl('/_expo/static/a.js'), /immutable/);
  assert.equal(cacheControl('/join'), 'no-store');
  assert.equal(cacheControl('/sw.js'), 'no-store');
});

test('deployment maps exported HTML routes and keeps fallback and shared security headers', () => {
  const config = deploymentConfiguration(
    env.EXPO_PUBLIC_SUPABASE_URL,
    ["'sha256-fixture'"],
    ['index.html', 'entrar.html', 'grupos/index.html'],
  );
  assert.equal(config.overrides['entrar.html'].path, 'entrar');
  assert.equal(config.overrides['grupos/index.html'].path, 'grupos');
  assert.equal(
    config.routes[0].headers['Content-Security-Policy'],
    securityHeaders(env.EXPO_PUBLIC_SUPABASE_URL, ["'sha256-fixture'"])['Content-Security-Policy'],
  );
  assert.deepEqual(config.routes.at(-2), { handle: 'filesystem' });
  assert.deepEqual(config.routes.at(-1), { src: '/(.*)', dest: '/index.html' });
});

for (const [name, mutate] of [
  [
    'script hashes mismatch the HTML',
    (s) => {
      s.body = '<script>different</script>';
    },
  ],
  [
    'unsafe CSP hidden by duplicate safe directive',
    (s) => {
      s.headers['Content-Security-Policy'] =
        "script-src 'unsafe-eval'; " + s.headers['Content-Security-Policy'];
    },
  ],
  [
    'additional connect origin',
    (s) => {
      s.headers['Content-Security-Policy'] = s.headers['Content-Security-Policy'].replace(
        "connect-src 'self'",
        "connect-src 'self' https://evil.example.invalid",
      );
    },
  ],
])
  test(name, async () =>
    assert.ok(
      (
        await checkStaging(
          env,
          fake((u, o, state) => {
            if (u.origin === env.STAGING_APP_ORIGIN && u.pathname === '/') mutate(state);
          }),
        )
      ).some((r) => !r.ok),
    ),
  );

for (const [name, mutate] of [
  [
    'worker accepts missing credential',
    (s) => {
      s.status = 200;
    },
  ],
  [
    'worker unexpectedly has CORS',
    (s) => {
      s.headers['Access-Control-Allow-Origin'] = env.STAGING_APP_ORIGIN;
    },
  ],
])
  test(name, async () =>
    assert.ok(
      (
        await checkStaging(
          env,
          fake((u, o, s) => {
            if (u.pathname.startsWith('/functions/v1/worker/')) mutate(s);
          }),
        )
      ).some((r) => !r.ok),
    ),
  );
