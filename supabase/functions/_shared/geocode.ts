// The address search of the create-match form (Rachas: usabilidade, human
// decision of 17/10/2026). The app never calls the search service: it asks
// this gateway, which asks LocationIQ (OpenStreetMap data, answers in the
// Nominatim shape; human decision of 18/10/2026, after Nominatim refused the
// Supabase addresses with 403), on the free plan (5,000 searches a day, 2 a
// second, the "Search by LocationIQ.com" credit shown with the results):
//   - one search per press, never an autocomplete (the app sends on press);
//   - the access key from the LOCATIONIQ_API_KEY secret; without it the
//     search is unavailable and nothing leaves the Edge;
//   - a User-Agent that names Colete;
//   - at most one request per second for the whole app, under the plan's two:
//     public.geocode_reserve
//     (0024) reserves slots 2000 ms apart on the single row of
//     private.geocode_throttle, shared by every Edge instance, and this file
//     calls only within spacing - 1000 ms after its slot (see dispatchGeocode);
//   - a short in-memory cache, so a repeated search does not go out again;
//   - the attribution travels with the results and the app shows it.
// The searched text and the key are never logged, never echoed in an error
// or a response and never put in a URL of the app; they leave only in the
// query string to LocationIQ, and that URL is never logged either.
// The gate also checks the session (a revoked one is refused) and lets only
// an owner or organizer of an active group search, the people who create
// matches.
import {
  GatewayError,
  defaultMessage,
  fromDatabaseError,
  httpStatusFor,
  validation,
} from './errors.ts';
import type { ErrorCode } from './errors.ts';
import type { ActorContext } from './gateway.ts';

export const GEOCODE_OPERATIONS = ['search_address'] as const;
export type GeocodeOperation = (typeof GEOCODE_OPERATIONS)[number];
export function isGeocodeOperation(value: string): value is GeocodeOperation {
  return (GEOCODE_OPERATIONS as readonly string[]).includes(value);
}

/** The US region of the forward search (https://docs.locationiq.com/reference/search). */
export const LOCATIONIQ_SEARCH_URL = 'https://us1.locationiq.com/v1/search';
export const DEFAULT_USER_AGENT =
  'Colete/0.1 (app de racha; +https://github.com/Cesararanha/colete)';
export const ATTRIBUTION = '© OpenStreetMap';
export const MAX_RESULTS = 5;
export const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
/** LocationIQ answers in well under a second, but has slow moments. */
export const UPSTREAM_TIMEOUT_MS = 8_000;
/**
 * The smallest gap between two upstream calls, for the whole app. The gate
 * answers its slot spacing; the Edge calls only within spacing - this gap
 * after its slot, so two calls are at least this far apart (0024).
 */
export const MIN_UPSTREAM_GAP_MS = 1_000;
/** Fresh slots asked for before answering RATE_LIMITED. */
const SLOT_ATTEMPTS = 3;

export interface AddressResult {
  readonly label: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface GeocodeDependencies {
  readonly actor: ActorContext;
  readonly callRpc: (
    name: string,
    parameters: Record<string, unknown>,
  ) => Promise<{
    data?: unknown;
    error?: { message?: string | null; code?: string | null } | null;
  }>;
  readonly fetchUpstream: (url: string, init: RequestInit) => Promise<Response>;
  /** The LocationIQ access key; empty when the secret is missing. */
  readonly apiKey: string;
  readonly userAgent: string;
  readonly now?: () => number;
  /** Monotonic milliseconds for the slot window; performance.now by default. */
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly cache?: Map<string, { expires: number; results: AddressResult[] }>;
  /**
   * Receives a fixed diagnostic code when a search ends unavailable or busy,
   * so the real cause shows in the function log. Never the query, the key,
   * the URL or an upstream body.
   */
  readonly report?: (code: string) => void;
}

const sharedCache = new Map<string, { expires: number; results: AddressResult[] }>();

/** Clears the shared cache; for tests. */
export function clearGeocodeCache(): void {
  sharedCache.clear();
}

/** NFC, controls and bidi marks refused, spaces collapsed, 3 to 160 code points. */
export function normaliseAddressQuery(value: unknown): string {
  if (typeof value !== 'string') throw validation('query', 'must be a string');
  const raw = value.normalize('NFC');
  if (/[\p{Cc}\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u.test(raw)) {
    throw validation('query', 'contains a forbidden control character');
  }
  const text = raw.replace(/[\p{Zs}\u2028\u2029]+/gu, ' ').trim();
  const length = [...text].length;
  if (length < 3 || length > 160)
    throw validation('query', 'must be between 3 and 160 code points');
  return text;
}

function roundCoordinate(value: number): number {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Up to five distinct places with a label and finite, in-range coordinates,
 * from a LocationIQ answer (the Nominatim shape).
 */
export function parseSearchResults(value: unknown): AddressResult[] {
  if (!Array.isArray(value)) return [];
  const results: AddressResult[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const label = record['display_name'];
    const latitude = Number(record['lat']);
    const longitude = Number(record['lon']);
    if (typeof label !== 'string' || typeof record['lat'] !== 'string') continue;
    if (typeof record['lon'] !== 'string') continue;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    const text = [...label.replace(/\s+/gu, ' ').trim()].slice(0, 160).join('');
    if (text.length < 2 || seen.has(text)) continue;
    seen.add(text);
    results.push({
      label: text,
      latitude: roundCoordinate(latitude),
      longitude: roundCoordinate(longitude),
    });
    if (results.length === MAX_RESULTS) break;
  }
  return results;
}

/**
 * The LocationIQ search URL: Brazil only, Portuguese labels, five results.
 * It carries the key and the query, so it never goes to a log or an answer.
 */
export function locationIqUrl(apiKey: string, query: string): string {
  const parameters = new URLSearchParams({
    key: apiKey,
    q: query,
    format: 'json',
    addressdetails: '0',
    limit: String(MAX_RESULTS),
    countrycodes: 'br',
    'accept-language': 'pt-BR',
  });
  return `${LOCATIONIQ_SEARCH_URL}?${parameters.toString()}`;
}

function failure(code: ErrorCode, requestId: string, extra: Record<string, unknown> = {}) {
  return {
    status: httpStatusFor(code),
    body: { error: { code, message: defaultMessage(code), ...extra }, request_id: requestId },
  };
}

function success(requestId: string, results: AddressResult[], unavailable = false) {
  return {
    status: 200,
    body: {
      data: { results, attribution: ATTRIBUTION, ...(unavailable ? { unavailable: true } : {}) },
      request_id: requestId,
    },
  };
}

export async function dispatchGeocode(
  deps: GeocodeDependencies,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const requestId = crypto.randomUUID();
  const now = deps.now ?? Date.now;
  const clock = deps.clock ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const cache = deps.cache ?? sharedCache;
  const report = deps.report ?? (() => {});
  try {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw validation('body', 'must be an object');
    }
    const input = body as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (key !== 'query') throw validation(key, 'unknown key');
    }
    const query = normaliseAddressQuery(input['query']);
    const key = query.toLocaleLowerCase('pt-BR');
    const cached = cache.get(key);
    const fresh = cached !== undefined && cached.expires > now() ? cached : undefined;

    // The gate always runs: it refuses a revoked session even for a cached
    // answer. Only a search that leaves for LocationIQ spends the slot.
    const gate = async (spend: boolean) => {
      const result = await deps.callRpc('geocode_reserve', {
        p_actor_auth_user_id: deps.actor.authUserId,
        p_actor_session_id: deps.actor.sessionId,
        p_spend: spend,
      });
      if (result.error !== undefined && result.error !== null)
        throw fromDatabaseError(result.error);
      const data = result.data as { wait_ms?: unknown; spacing_ms?: unknown } | null;
      const spacing = data?.spacing_ms;
      // A spacing that leaves no tolerance cannot keep the gap: refuse to call.
      if (typeof spacing !== 'number' || !Number.isInteger(spacing)) throw new Error('gate shape');
      if (spacing <= MIN_UPSTREAM_GAP_MS) throw new Error('gate spacing');
      const wait = data?.wait_ms;
      return {
        tolerance: spacing - MIN_UPSTREAM_GAP_MS,
        wait: typeof wait === 'number' && Number.isInteger(wait) && wait >= 0 ? wait : null,
      };
    };
    if (fresh !== undefined) {
      await gate(false);
      return success(requestId, fresh.results);
    }
    // Without the key the search fails closed: the session is still checked,
    // no slot is spent and nothing leaves the Edge.
    if (deps.apiKey.length === 0) {
      await gate(false);
      report('GEOCODE_CONFIG_MISSING');
      return success(requestId, [], true);
    }

    // The gate answers w, the whole milliseconds until the reserved slot
    // (rounded up; the true wait is in (w - 1, w]), and the slot spacing S.
    // The database computed w at some instant between t0 and t1 of this
    // clock, so the slot here is within [t0 + w - 1, t1 + w]. Calling no
    // earlier than t1 + w is never before the slot; calling no later than
    // t0 + w - 1 + T, with T = S - 1000 ms, is never past slot + T. Every call
    // is then within [slot, slot + T] and slots are S apart, so two calls are
    // at least S - T = 1000 ms apart. With S = 2000 ms (0024) a round trip
    // up to 999 ms still leaves a window; a slower one, or a late wake-up,
    // abandons the slot and reserves another. Nothing awaits between the last
    // check and the fetch below.
    let dispatched = false;
    for (let attempt = 0; attempt < SLOT_ATTEMPTS && !dispatched; attempt += 1) {
      const t0 = clock();
      const { wait, tolerance } = await gate(true);
      const t1 = clock();
      if (wait === null) {
        report('GEOCODE_SLOT_BUSY');
        return failure('RATE_LIMITED', requestId, { retry_after: 2 });
      }
      const earliest = t1 + wait;
      const latest = t0 + wait - 1 + tolerance;
      if (earliest > latest) continue;
      while (clock() < earliest) await sleep(Math.max(1, Math.ceil(earliest - clock())));
      if (clock() <= latest) dispatched = true;
    }
    if (!dispatched) {
      report('GEOCODE_SLOT_LATE');
      return failure('RATE_LIMITED', requestId, { retry_after: 2 });
    }

    let response: Response;
    try {
      response = await deps.fetchUpstream(locationIqUrl(deps.apiKey, query), {
        method: 'GET',
        headers: { 'User-Agent': deps.userAgent, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      // The error may carry the URL, and with it the key: only a fixed code.
      report(
        error instanceof DOMException && error.name === 'TimeoutError'
          ? 'GEOCODE_UPSTREAM_TIMEOUT'
          : 'GEOCODE_UPSTREAM_NETWORK',
      );
      return success(requestId, [], true);
    }
    // A body that times out or is not JSON is an unavailable answer, never an
    // empty search, and never cached (review of #72, P2).
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      report(response.ok ? 'GEOCODE_UPSTREAM_BODY' : `GEOCODE_UPSTREAM_HTTP_${response.status}`);
      return success(requestId, [], true);
    }
    // LocationIQ answers a search with no match as 404 "Unable to geocode":
    // an empty search, not an unavailable one. Any other refusal (401 key,
    // 403 access, 429 plan limit, 5xx) is unavailable.
    const noMatch =
      response.status === 404 &&
      typeof payload === 'object' &&
      payload !== null &&
      (payload as Record<string, unknown>)['error'] === 'Unable to geocode';
    if (!response.ok && !noMatch) {
      report(`GEOCODE_UPSTREAM_HTTP_${response.status}`);
      return success(requestId, [], true);
    }
    if (response.ok && !Array.isArray(payload)) {
      report('GEOCODE_UPSTREAM_BODY');
      return success(requestId, [], true);
    }
    const results = noMatch ? [] : parseSearchResults(payload);
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { expires: now() + CACHE_TTL_MS, results });
    return success(requestId, results);
  } catch (thrown) {
    if (thrown instanceof GatewayError) {
      return failure(
        thrown.code,
        requestId,
        thrown.fields === undefined ? {} : { fields: thrown.fields },
      );
    }
    return failure('INTERNAL', requestId);
  }
}
