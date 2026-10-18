import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTION,
  CACHE_TTL_MS,
  DEFAULT_USER_AGENT,
  dispatchGeocode,
  locationIqUrl,
  normaliseAddressQuery,
  parseSearchResults,
  MIN_UPSTREAM_GAP_MS,
  type AddressResult,
  type GeocodeDependencies,
} from './geocode.ts';

const ACTOR = {
  authUserId: '23000000-0000-4000-8000-000000000001',
  sessionId: '23900000-0000-4000-8000-000000000001',
};
// A fake key: it must never show in a report, an answer or a log line.
const FAKE_KEY = 'pk.fake-locationiq-key-0000';
const PLACES = [
  { display_name: 'Arena da Vila, Rua Um, São Paulo', lat: '-23.550519', lon: '-46.633309' },
  { display_name: 'Arena da Vila, Rua Dois, Campinas', lat: '-22.90556', lon: '-47.06083' },
];

// The gate answers the milliseconds until the reserved slot, or null when the
// queue is too long, and the slot spacing (2000 ms since 0024).
const SPACING_MS = 2_000;
const TOLERANCE_MS = SPACING_MS - MIN_UPSTREAM_GAP_MS;
// gateDelays[i] is how long the i-th spending gate takes to
// come back; oversleep is added to every sleep, as a late timer would.
function harness(
  options: {
    granted?: (number | null)[];
    gateDelays?: number[];
    oversleep?: number;
    upstream?: () => Promise<Response>;
    spacing?: number;
    apiKey?: string;
  } = {},
) {
  const granted = [...(options.granted ?? [0])];
  const gateDelays = [...(options.gateDelays ?? [])];
  const rpcCalls: Record<string, unknown>[] = [];
  const upstreamCalls: { url: string; init: RequestInit; at: number }[] = [];
  const sleeps: number[] = [];
  const reports: string[] = [];
  let clock = 1_000_000;
  const deps: GeocodeDependencies = {
    actor: ACTOR,
    cache: new Map<string, { expires: number; results: AddressResult[] }>(),
    callRpc: async (name, parameters) => {
      expect(name).toBe('geocode_reserve');
      rpcCalls.push(parameters);
      const spacing = options.spacing ?? SPACING_MS;
      if (parameters['p_spend'] === false) return { data: { wait_ms: 0, spacing_ms: spacing } };
      // The database answers at the start of the round trip; the reply then
      // travels for gateDelay before this instance sees it.
      const wait = granted.length > 0 ? granted.shift()! : null;
      clock += gateDelays.shift() ?? 0;
      return { data: { wait_ms: wait, spacing_ms: spacing } };
    },
    fetchUpstream: async (url, init) => {
      upstreamCalls.push({ url, init, at: clock });
      return options.upstream ? options.upstream() : Response.json(PLACES);
    },
    apiKey: options.apiKey ?? FAKE_KEY,
    userAgent: DEFAULT_USER_AGENT,
    now: () => clock,
    clock: () => clock,
    report: (code) => {
      reports.push(code);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms + (options.oversleep ?? 0);
    },
  };
  return {
    deps,
    rpcCalls,
    upstreamCalls,
    sleeps,
    reports,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('address search through the Edge (human decision of 17/10/2026)', () => {
  it('asks LocationIQ for five Brazilian results in Portuguese, naming Colete', async () => {
    const run = harness();
    const answer = await dispatchGeocode(run.deps, { query: '  Arena   da Vila ' });
    expect(answer.status).toBe(200);
    expect(answer.body['data']).toEqual({
      attribution: ATTRIBUTION,
      results: [
        { label: 'Arena da Vila, Rua Um, São Paulo', latitude: -23.5505, longitude: -46.6333 },
        { label: 'Arena da Vila, Rua Dois, Campinas', latitude: -22.9056, longitude: -47.0608 },
      ],
    });
    expect(run.upstreamCalls).toHaveLength(1);
    const url = new URL(run.upstreamCalls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://us1.locationiq.com/v1/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      key: FAKE_KEY,
      q: 'Arena da Vila',
      format: 'json',
      addressdetails: '0',
      limit: '5',
      countrycodes: 'br',
      'accept-language': 'pt-BR',
    });
    const headers = run.upstreamCalls[0]!.init.headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/^Colete\//);
    expect(run.rpcCalls).toEqual([
      {
        p_actor_auth_user_id: ACTOR.authUserId,
        p_actor_session_id: ACTOR.sessionId,
        p_spend: true,
      },
    ]);
    expect(ATTRIBUTION).toBe('© OpenStreetMap');
    expect(JSON.stringify(answer.body)).not.toContain(FAKE_KEY);
  });

  it('fails closed without the key: unavailable, nothing leaves, the session still checked', async () => {
    const run = harness({ apiKey: '' });
    const answer = await dispatchGeocode(run.deps, { query: 'Arena da Vila' });
    expect(answer.status).toBe(200);
    expect(answer.body['data']).toEqual({
      attribution: ATTRIBUTION,
      results: [],
      unavailable: true,
    });
    expect(run.upstreamCalls).toHaveLength(0);
    expect(run.rpcCalls.map((call) => call['p_spend'])).toEqual([false]);
    expect(run.reports).toEqual(['GEOCODE_CONFIG_MISSING']);
    const revoked = harness({ apiKey: '' });
    revoked.deps = {
      ...revoked.deps,
      callRpc: async () => ({ error: { message: 'UNAUTHENTICATED', code: '28000' } }),
    };
    const refused = await dispatchGeocode(revoked.deps, { query: 'Arena da Vila' });
    expect((refused.body['error'] as { code: string }).code).toBe('UNAUTHENTICATED');
    expect(revoked.reports).toEqual([]);
  });

  it('answers LocationIQ "Unable to geocode" (404) as an empty search, and caches it', async () => {
    const run = harness({
      granted: [0, 0],
      upstream: async () => Response.json({ error: 'Unable to geocode' }, { status: 404 }),
    });
    const answer = await dispatchGeocode(run.deps, { query: 'Rua Inexistente 9' });
    expect(answer.status).toBe(200);
    expect(answer.body['data']).toEqual({ attribution: ATTRIBUTION, results: [] });
    expect(run.reports).toEqual([]);
    await dispatchGeocode(run.deps, { query: 'Rua Inexistente 9' });
    expect(run.upstreamCalls).toHaveLength(1);
    // A 404 that is not the no-match answer is a failure, not an empty search.
    const other = harness({ upstream: async () => new Response('gone', { status: 404 }) });
    const failed = await dispatchGeocode(other.deps, { query: 'Rua Um' });
    expect(failed.body['data']).toMatchObject({ results: [], unavailable: true });
    expect(other.reports).toEqual(['GEOCODE_UPSTREAM_HTTP_404']);
    // Only the 404 status means no match, whatever the body says.
    const server = harness({
      upstream: async () => Response.json({ error: 'Unable to geocode' }, { status: 500 }),
    });
    const broken = await dispatchGeocode(server.deps, { query: 'Rua Um' });
    expect(broken.body['data']).toMatchObject({ results: [], unavailable: true });
    expect(server.reports).toEqual(['GEOCODE_UPSTREAM_HTTP_500']);
  });

  it('serves a repeated search from the short cache, still checking the session', async () => {
    const run = harness({ granted: [0, 0] });
    await dispatchGeocode(run.deps, { query: 'Arena da Vila' });
    const again = await dispatchGeocode(run.deps, { query: 'arena  DA vila' });
    expect(again.status).toBe(200);
    expect(run.upstreamCalls).toHaveLength(1);
    expect(run.rpcCalls.map((call) => call['p_spend'])).toEqual([true, false]);
    run.advance(CACHE_TTL_MS + 1);
    await dispatchGeocode(run.deps, { query: 'Arena da Vila' });
    expect(run.upstreamCalls).toHaveLength(2);
  });

  it('waits for the reserved slot and calls within the tolerance after it', async () => {
    const run = harness({ granted: [600] });
    const start = 1_000_000;
    expect((await dispatchGeocode(run.deps, { query: 'Rua Um' })).status).toBe(200);
    expect(run.upstreamCalls).toHaveLength(1);
    const at = run.upstreamCalls[0]!.at;
    expect(at).toBeGreaterThanOrEqual(start + 600);
    expect(at).toBeLessThanOrEqual(start + 600 + TOLERANCE_MS);
  });

  it('answers RATE_LIMITED without calling when the queue is too long', async () => {
    const busy = harness({ granted: [null] });
    const answer = await dispatchGeocode(busy.deps, { query: 'Rua Um' });
    expect(answer.status).toBe(429);
    expect(answer.body['error']).toMatchObject({ code: 'RATE_LIMITED', retry_after: 2 });
    expect(busy.upstreamCalls).toHaveLength(0);
  });

  it('abandons a slot whose gate answer came back late, and asks for a new one', async () => {
    // Review of #72: a reply delayed by 1350 ms must not call in the next slot.
    const run = harness({ granted: [0, 1_250], gateDelays: [1_350, 5] });
    expect((await dispatchGeocode(run.deps, { query: 'Rua Um' })).status).toBe(200);
    expect(run.rpcCalls.filter((call) => call['p_spend'] === true)).toHaveLength(2);
    expect(run.upstreamCalls).toHaveLength(1);
    // Second slot reserved at 1_001_355 + 1250 ms: the call is inside its window.
    const second = 1_000_000 + 1_350 + 1_250;
    expect(run.upstreamCalls[0]!.at).toBeGreaterThanOrEqual(second);
    expect(run.upstreamCalls[0]!.at).toBeLessThanOrEqual(second + TOLERANCE_MS);
  });

  it('still searches when the gate round trip takes 300 to 800 ms, as on the real server', async () => {
    // Ajustes do teste do César: on staging the RPC round trip often passes
    // 250 ms, which left the old window empty on every attempt.
    for (const delay of [300, 450, 600, 800]) {
      const run = harness({ granted: [0, 0, 0], gateDelays: [delay, delay, delay] });
      const answer = await dispatchGeocode(run.deps, { query: 'Rua Um' });
      expect(answer.status, `round trip ${delay} ms`).toBe(200);
      expect(run.upstreamCalls, `round trip ${delay} ms`).toHaveLength(1);
    }
  });

  it('never calls when every gate answer or wake-up is late', async () => {
    const slow = harness({ granted: [0, 0, 0], gateDelays: [1_100, 1_100, 1_100] });
    expect((await dispatchGeocode(slow.deps, { query: 'Rua Um' })).status).toBe(429);
    expect(slow.upstreamCalls).toHaveLength(0);
    expect(slow.reports).toEqual(['GEOCODE_SLOT_LATE']);
    const sleepy = harness({ granted: [500, 500, 500], oversleep: TOLERANCE_MS + 50 });
    expect((await dispatchGeocode(sleepy.deps, { query: 'Rua Um' })).status).toBe(429);
    expect(sleepy.upstreamCalls).toHaveLength(0);
  });

  it('treats a body that fails mid-read as unavailable and never caches it', async () => {
    const broken = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('[{"display_name":"Aren'));
              controller.error(new DOMException('timed out', 'TimeoutError'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const run = harness({ granted: [0, 0], upstream: broken });
    const first = await dispatchGeocode(run.deps, { query: 'Arena da Vila' });
    expect(first.status).toBe(200);
    expect(first.body['data']).toMatchObject({ results: [], unavailable: true });
    await dispatchGeocode(run.deps, { query: 'Arena da Vila' });
    expect(run.upstreamCalls).toHaveLength(2);
  });

  it('refuses a revoked session or a player before anything leaves the Edge', async () => {
    for (const code of ['UNAUTHENTICATED', 'NOT_ORGANIZER']) {
      const run = harness();
      run.deps = {
        ...run.deps,
        callRpc: async () => ({ error: { message: code, code: '28000' } }),
      };
      const answer = await dispatchGeocode(run.deps, { query: 'Arena da Vila' });
      expect((answer.body['error'] as { code: string }).code).toBe(code);
      expect(run.upstreamCalls).toHaveLength(0);
    }
  });

  it('never echoes the searched text in a refusal', async () => {
    const run = harness();
    const secret = 'Rua Segredo 123\u202e';
    const answer = await dispatchGeocode(run.deps, { query: secret });
    expect(answer.status).toBe(422);
    expect(JSON.stringify(answer.body)).not.toContain('Segredo');
    expect(run.rpcCalls).toHaveLength(0);
    expect(run.upstreamCalls).toHaveLength(0);
  });

  it('answers an empty, unavailable list when LocationIQ fails, and does not cache it', async () => {
    const run = harness({
      granted: [0, 0],
      upstream: async () => new Response('busy', { status: 503 }),
    });
    const answer = await dispatchGeocode(run.deps, { query: 'Arena da Vila' });
    expect(answer.status).toBe(200);
    expect(answer.body['data']).toEqual({
      attribution: ATTRIBUTION,
      results: [],
      unavailable: true,
    });
    await dispatchGeocode(run.deps, { query: 'Arena da Vila' });
    expect(run.upstreamCalls).toHaveLength(2);
  });

  it('names the real cause of an unavailable search, never the query or the key', async () => {
    const cases: [() => Promise<Response>, string][] = [
      [
        async () => Response.json({ error: 'Invalid key' }, { status: 401 }),
        'GEOCODE_UPSTREAM_HTTP_401',
      ],
      [
        async () => Response.json({ error: 'Access restricted' }, { status: 403 }),
        'GEOCODE_UPSTREAM_HTTP_403',
      ],
      [
        async () => Response.json({ error: 'Rate Limited Day' }, { status: 429 }),
        'GEOCODE_UPSTREAM_HTTP_429',
      ],
      [async () => new Response('blocked', { status: 403 }), 'GEOCODE_UPSTREAM_HTTP_403'],
      [async () => new Response('slow down', { status: 429 }), 'GEOCODE_UPSTREAM_HTTP_429'],
      [
        async () => {
          throw new DOMException('timed out', 'TimeoutError');
        },
        'GEOCODE_UPSTREAM_TIMEOUT',
      ],
      [
        async () => {
          // A runtime error may carry the URL, and with it the key.
          throw new TypeError(`error sending request for url (${locationIqUrl(FAKE_KEY, 'x')})`);
        },
        'GEOCODE_UPSTREAM_NETWORK',
      ],
      [async () => new Response('not json', { status: 200 }), 'GEOCODE_UPSTREAM_BODY'],
      [async () => Response.json({ error: 'x' }), 'GEOCODE_UPSTREAM_BODY'],
    ];
    for (const [upstream, code] of cases) {
      const run = harness({ upstream });
      const answer = await dispatchGeocode(run.deps, { query: 'Rua Secreta 77' });
      expect(answer.body['data']).toMatchObject({ results: [], unavailable: true });
      expect(run.reports).toEqual([code]);
      expect(run.reports.join()).not.toContain('Secreta');
      expect(run.reports.join()).not.toContain(FAKE_KEY);
      expect(JSON.stringify(answer.body)).not.toContain(FAKE_KEY);
    }
    const busy = harness({ granted: [null] });
    await dispatchGeocode(busy.deps, { query: 'Rua Um' });
    expect(busy.reports).toEqual(['GEOCODE_SLOT_BUSY']);
  });

  it('refuses to call when the gate spacing leaves no tolerance', async () => {
    for (const spacing of [1_000, 900]) {
      const run = harness({ spacing });
      const answer = await dispatchGeocode(run.deps, { query: 'Rua Um' });
      expect(answer.status).toBe(500);
      expect(run.upstreamCalls).toHaveLength(0);
    }
  });

  it('accepts only the query key', async () => {
    const run = harness();
    const answer = await dispatchGeocode(run.deps, { query: 'Arena', latitude: 1 });
    expect(answer.status).toBe(422);
    expect(run.upstreamCalls).toHaveLength(0);
  });
});

describe('query and result shapes', () => {
  it.each([
    ['ab', 'refused'],
    ['abc', 'abc'],
    ['  Rua\u3000Um  ', 'Rua Um'],
    ['x'.repeat(161), 'refused'],
    ['Rua\tUm', 'refused'],
    [12, 'refused'],
  ])('query %j → %j', (input, expected) => {
    let result: string;
    try {
      result = normaliseAddressQuery(input);
    } catch {
      result = 'refused';
    }
    expect(result).toBe(expected);
  });

  it('keeps at most five distinct, valid places', () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      display_name: `Lugar ${index}`,
      lat: '-23.5',
      lon: '-46.6',
    }));
    expect(parseSearchResults(many)).toHaveLength(5);
    expect(
      parseSearchResults([
        { display_name: 'Repetido', lat: '1', lon: '2' },
        { display_name: 'Repetido', lat: '1', lon: '2' },
        { display_name: 'Fora', lat: '91', lon: '0' },
        { display_name: 'Número', lat: 1, lon: 2 },
        { display_name: 'NaN', lat: 'x', lon: '2' },
      ]),
    ).toEqual([{ label: 'Repetido', latitude: 1, longitude: 2 }]);
    expect(parseSearchResults({ error: 'x' })).toEqual([]);
  });

  it('puts the key and the query only in the LocationIQ query string', () => {
    const url = locationIqUrl('k&y', 'Rua & Cia');
    expect(url).toContain('q=Rua+%26+Cia');
    expect(url).toContain('key=k%26y');
  });
});
