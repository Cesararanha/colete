import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { checkStaging, configuration, protectedTables } from './staging-check.mjs';
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
    if (u.pathname === '/rest/v1/') {
      status = 403;
      body = { message: 'Access to schema is forbidden' };
    } else if (u.pathname.startsWith('/rest/v1/rpc/')) {
      status = 401;
      body = { code: '42501' };
    } else if (u.pathname.startsWith('/rest/v1/')) {
      status = 401;
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
    'Anonymous RPC denied: create_group',
    (u, o, s) => {
      if (u.pathname === '/rest/v1/rpc/create_group') s.status = 200;
    },
  ],
  [
    'Anonymous table denied: profiles',
    (u, o, s) => {
      if (u.pathname === '/rest/v1/profiles') {
        s.status = 200;
        s.body = [];
      }
    },
  ],
  [
    'Anonymous table denied: profiles',
    (u, o, s) => {
      if (u.pathname === '/rest/v1/profiles') {
        s.status = 404;
        s.body.code = 'unrelated';
      }
    },
  ],
  [
    'Edge without session: identity',
    (u, o, s) => {
      if (
        u.pathname === '/functions/v1/identity/complete_profile' &&
        o.method === 'POST' &&
        o.headers.Origin === env.STAGING_APP_ORIGIN
      )
        s.status = 200;
    },
  ],
  [
    'CORS approved: identity',
    (u, o, s) => {
      if (
        u.pathname === '/functions/v1/identity/complete_profile' &&
        o.method === 'OPTIONS' &&
        o.headers?.Origin === env.STAGING_APP_ORIGIN
      )
        delete s.headers['Access-Control-Allow-Origin'];
    },
  ],
  [
    'CORS denied: identity',
    (u, o, s) => {
      if (
        u.pathname === '/functions/v1/identity/complete_profile' &&
        o.method === 'OPTIONS' &&
        o.headers?.Origin === 'https://denied.example.invalid'
      )
        s.headers['Access-Control-Allow-Origin'] = o.headers.Origin;
    },
  ],
  [
    'CORS approved: identity',
    (u, o, s) => {
      if (
        u.pathname === '/functions/v1/identity/complete_profile' &&
        o.method === 'OPTIONS' &&
        o.headers?.Origin === env.STAGING_APP_ORIGIN
      )
        s.headers['Access-Control-Allow-Origin'] = '*';
    },
  ],
  [
    'CORS approved: identity',
    (u, o, s) => {
      if (
        u.pathname === '/functions/v1/identity/complete_profile' &&
        o.method === 'OPTIONS' &&
        o.headers?.Origin === env.STAGING_APP_ORIGIN
      )
        s.headers['Access-Control-Allow-Credentials'] = 'true';
    },
  ],
  [
    'PWA security headers and HTML cache',
    (u, o, s) => {
      if (u.origin === env.STAGING_APP_ORIGIN && u.pathname === '/') s.headers = {};
    },
  ],
  [
    'PWA security headers and HTML cache',
    (u, o, s) => {
      if (s.headers['Content-Security-Policy'])
        s.headers['Content-Security-Policy'] += "; script-src 'self' 'unsafe-inline'";
    },
  ],
  [
    'Service worker served without cache',
    (u, o, s) => {
      if (u.pathname === '/sw.js') s.headers['Cache-Control'] = 'max-age=3600';
    },
  ],
  [
    'Service worker served without cache',
    (u, o, s) => {
      if (u.pathname === '/sw.js') s.headers['Content-Type'] = 'text/html';
    },
  ],
  [
    'Manifest served without cache',
    (u, o, s) => {
      if (u.pathname === '/manifest.webmanifest') s.body.display = 'browser';
    },
  ],
])
  test(`specific failure: ${label}`, async () => {
    const results = await checkStaging(env, fake(mutate));
    assert.equal(results.find((r) => r.name === label)?.ok, false, label);
    assert.deepEqual(
      results.filter((r) => !r.ok).map((r) => r.name),
      [label],
    );
  });
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
  assert.equal(config.routes[0].headers['Cache-Control'], 'no-store');
  assert.deepEqual(config.routes.at(-3), { handle: 'filesystem' });
  assert.equal(config.routes.at(-2).status, 404);
  assert.equal(config.routes.at(-2).headers['Cache-Control'], 'no-store');
  assert.ok(new RegExp(config.routes.at(-2).src).test('/_expo/static/missing.js'));
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
      ).find((r) => r.name === 'PWA security headers and HTML cache')?.ok === false,
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
      ).find((r) => r.name === 'Worker rejects missing cron secret without CORS')?.ok === false,
    ),
  );

test('new project denies OpenAPI but passes; checker never requests its schema', async () => {
  const paths = [];
  const fetcher = fake();
  assert.equal((await fetcher(env.EXPO_PUBLIC_SUPABASE_URL + '/rest/v1/')).status, 403);
  const results = await checkStaging(env, (url, options) => {
    paths.push(new URL(url).pathname);
    return fetcher(url, options);
  });
  assert.ok(results.every((r) => r.ok));
  assert.ok(!paths.includes('/rest/v1/'));
  assert.equal(paths.filter((p) => p.startsWith('/rest/v1/rpc/')).length, 9);
});

for (const code of ['PGRST205', 'PGRST202', '42P01', 'unrelated'])
  test(`missing table is not a denial: ${code}`, async () => {
    const results = await checkStaging(
      env,
      fake((u, o, s) => {
        if (u.pathname === '/rest/v1/profiles') {
          s.status = 404;
          s.body = { code };
        }
      }),
    );
    assert.equal(results.find((r) => r.name === 'Anonymous table denied: profiles').ok, false);
    assert.equal(results.filter((r) => !r.ok).length, 1);
  });

test('RPC signature must not be reported as permission denied', async () => {
  const results = await checkStaging(
    env,
    fake((u, o, s) => {
      if (u.pathname === '/rest/v1/rpc/create_group') {
        s.status = 404;
        s.body = { code: 'PGRST202' };
      }
    }),
  );
  assert.equal(results.find((r) => r.name === 'Anonymous RPC denied: create_group').ok, false);
});

test('denied preflight is isolated from the denied real response', async () => {
  const results = await checkStaging(
    env,
    fake((u, o, s) => {
      if (
        u.pathname === '/functions/v1/identity/complete_profile' &&
        o.method === 'OPTIONS' &&
        o.headers.Origin !== env.STAGING_APP_ORIGIN
      )
        s.headers['Access-Control-Allow-Origin'] = o.headers.Origin;
    }),
  );
  assert.deepEqual(
    results.filter((r) => !r.ok).map((r) => r.name),
    ['CORS denied: identity'],
  );
});

test('approved preflight requires Vary Origin independently', async () => {
  const results = await checkStaging(
    env,
    fake((u, o, s) => {
      if (
        u.pathname === '/functions/v1/identity/complete_profile' &&
        o.method === 'OPTIONS' &&
        o.headers.Origin === env.STAGING_APP_ORIGIN
      )
        delete s.headers.Vary;
    }),
  );
  assert.deepEqual(
    results.filter((r) => !r.ok).map((r) => r.name),
    ['CORS approved: identity'],
  );
});

const expectedCsp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://api.example.invalid " +
  "wss://api.example.invalid; manifest-src 'self'; worker-src 'self'; object-src 'none'; " +
  "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";
test('generator equals the fixed complete policy, independent of checker and fake', () => {
  assert.equal(
    securityHeaders(env.EXPO_PUBLIC_SUPABASE_URL, [])['Content-Security-Policy'],
    expectedCsp,
  );
});
for (const directive of expectedCsp.split('; ').map((s) => s.split(' ')[0]))
  for (const change of ['remove', 'loosen', 'restrict'])
    test(`exact CSP ${directive}: ${change}`, async () => {
      const results = await checkStaging(
        env,
        fake((u, o, s) => {
          if (u.origin !== env.STAGING_APP_ORIGIN || u.pathname !== '/') return;
          s.headers['Content-Security-Policy'] = s.headers['Content-Security-Policy']
            .split('; ')
            .flatMap((entry) => {
              if (!entry.startsWith(directive + ' ') && entry !== directive) return [entry];
              return change === 'remove'
                ? []
                : [
                    directive +
                      (change === 'loosen'
                        ? ' *'
                        : entry === directive + " 'none'"
                          ? " 'none' 'none'"
                          : " 'none'"),
                  ];
            })
            .join('; ');
        }),
      );
      assert.deepEqual(
        results.filter((r) => !r.ok).map((r) => r.name),
        ['PWA security headers and HTML cache'],
      );
    });
for (const header of ['X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy'])
  test(`independent security header: ${header}`, async () => {
    const results = await checkStaging(
      env,
      fake((u, o, s) => {
        if (u.origin === env.STAGING_APP_ORIGIN && u.pathname === '/') delete s.headers[header];
      }),
    );
    assert.deepEqual(
      results.filter((r) => !r.ok).map((r) => r.name),
      ['PWA security headers and HTML cache'],
    );
  });

test('inline hashes retain whitespace bytes and omit empty/whitespace scripts', () => {
  const content = '\n  abc(); \n';
  const expected = "'sha256-" + createHash('sha256').update(content).digest('base64') + "'";
  assert.deepEqual(inlineHashes(`<script>${content}</script><script> </script><script></script>`), [
    expected,
  ]);
});

for (const bad of [
  'https://*',
  'https://*.example.com',
  'https://example.com/path',
  'https://example.com/?q=1',
  'https://user:password@example.com',
  'http://example.com',
  'https://example.com/',
  'https://example.com#fragment',
  ' https://example.com',
  'https://EXAMPLE.com',
  'https://-invalid.example.com',
])
  test(`build rejects non-exact HTTPS origin: ${bad}`, () => {
    assert.throws(() => supabaseOrigin(bad));
    const result = spawnSync(process.execPath, ['scripts/build-staging.mjs'], {
      env: {
        ...process.env,
        EXPO_PUBLIC_SUPABASE_URL: bad,
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture',
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes('Starting Metro'));
  });

test('operator share input mismatch fails before network; it does not certify Edge secret', () => {
  assert.throws(() =>
    configuration({ ...env, INVITE_SHARE_URL_BASE: 'https://other.example.com' }),
  );
  assert.equal(configuration(env).share, env.STAGING_APP_ORIGIN);
});

test('Vercel Git deploys main automatically and disables all preview branches', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  assert.deepEqual(config.git.deploymentEnabled, { main: true, '*': false });
  assert.equal(config.framework, null);
  assert.equal(config.buildCommand, 'npm run build:web:staging');
  assert.equal(config.installCommand, 'npm ci');
  assert.equal(config.outputDirectory, undefined);
});

test('known tables match current public migrations; exports use their authenticated projection', async () => {
  assert.deepEqual(protectedTables, ['profiles', 'groups', 'group_members', 'group_invites']);
  const requests = [];
  const fetcher = fake();
  const results = await checkStaging(env, (url, options) => {
    requests.push({ path: new URL(url).pathname, options });
    return fetcher(url, options);
  });
  assert.ok(results.every((r) => r.ok));
  const projection = requests.find((r) => r.path === '/rest/v1/rpc/get_own_data_exports');
  assert.equal(projection.options.method, 'POST');
  assert.deepEqual(JSON.parse(projection.options.body), {});
  assert.ok(
    !requests.some(
      (r) => r.path === '/rest/v1/data_exports' || r.path === '/rest/v1/group_memberships',
    ),
  );
});
