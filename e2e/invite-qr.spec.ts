import { test, expect, type Page } from './support/csp';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import jsQR from 'jsqr';
import sharp from 'sharp';
import { inviteQrMatrix } from '../src/features/groups/invite-qr';
import { assertAccessible, localEnvironment } from './support/local-stack';

const env = localEnvironment();
const password = 'Synthetic-qr-test-2026';
const origin = 'http://127.0.0.1:4173';
const prefix = `qr-${Date.now()}-${process.pid}`;
type Actor = { id: string; email: string; token: string; profileId: string };
let owner: Actor;
let joiner: Actor;
let groupId: string;
let inviteId: string;
let share: { share_url: string; code: string };
const actors: Actor[] = [];

async function jsonRequest(url: string, data: unknown, headers: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  expect(response.ok).toBe(true);
  return response.json();
}
async function edge(actor: Actor, operation: string, input: object) {
  return jsonRequest(`${env.functionsUrl}/groups/${operation}`, input, {
    Authorization: `Bearer ${actor.token}`,
  });
}
async function actor(label: string): Promise<Actor> {
  const email = `${prefix}-${label}@colete.test`;
  const user = await jsonRequest(
    `${env.apiUrl}/auth/v1/admin/users`,
    { email, password, email_confirm: true, user_metadata: { name: `Pessoa ${label}` } },
    { apikey: env.secretKey, Authorization: `Bearer ${env.secretKey}` },
  );
  // Keep cleanup possible even if profile setup fails.
  const subject = { id: user.id, email, token: '', profileId: '' };
  actors.push(subject);
  const session = await jsonRequest(
    `${env.apiUrl}/auth/v1/token?grant_type=password`,
    { email, password },
    { apikey: env.publishableKey },
  );
  subject.token = session.access_token;
  const profile = await jsonRequest(
    `${env.functionsUrl}/identity/complete_profile`,
    { request_id: crypto.randomUUID(), profile: { name: `Pessoa ${label}` } },
    { Authorization: `Bearer ${subject.token}` },
  );
  subject.profileId = profile.data.outcome.profile_id;
  return subject;
}
async function login(page: Page, subject = owner) {
  await page.goto('/entrar');
  await page.getByTestId('login-email').fill(subject.email);
  await page.getByTestId('login-password').fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).tap();
  await expect(page.getByRole('heading', { name: 'Grupos', level: 1 })).toBeVisible();
}

test.beforeAll(async () => {
  owner = await actor('owner');
  joiner = await actor('joiner');
  const created = await edge(owner, 'create_group', {
    name: 'Grupo câmera sintética',
    request_id: crypto.randomUUID(),
  });
  groupId = created.data.outcome.group_id;
  inviteId = created.data.outcome.invite_id;
  share = (await edge(owner, 'get_invite_share_link', { invite_id: inviteId })).data;
});
test.afterAll(async () => {
  if (!actors.length) return;
  const db = new pg.Client({ connectionString: env.dbUrl });
  await db.connect();
  try {
    const ids = actors.map((subject) => subject.id);
    const profiles = (
      await db.query('select id from public.profiles where auth_user_id=any($1::uuid[])', [ids])
    ).rows.map((row: { id: string }) => row.id);
    await db.query('begin');
    for (const table of ['private.invite_rate_limits', 'private.revoked_auth_sessions'])
      await db.query(`delete from ${table} where profile_id=any($1::uuid[])`, [profiles]);
    await db.query('delete from private.idempotency_records where actor_id=any($1::uuid[])', [
      profiles,
    ]);
    await db.query(
      'delete from public.group_invites where group_id in (select id from public.groups where owner_id=any($1::uuid[]))',
      [profiles],
    );
    await db.query(
      'delete from public.group_members where profile_id=any($1::uuid[]) or group_id in (select id from public.groups where owner_id=any($1::uuid[]))',
      [profiles],
    );
    await db.query('delete from public.groups where owner_id=any($1::uuid[])', [profiles]);
    await db.query('delete from public.profiles where id=any($1::uuid[])', [profiles]);
    await db.query('commit');
    for (const id of ids) {
      const response = await fetch(`${env.apiUrl}/auth/v1/admin/users/${id}`, {
        method: 'DELETE',
        headers: { apikey: env.secretKey, Authorization: `Bearer ${env.secretKey}` },
      });
      expect(response.ok || response.status === 404).toBe(true);
    }
    await db.query(
      "delete from auth.audit_log_entries where payload->>'actor_id'=any($1::text[]) or payload->>'actor_username'=any($2::text[])",
      [ids, actors.map((subject) => subject.email)],
    );
    expect(
      (
        await db.query('select count(*)::int as count from auth.users where id=any($1::uuid[])', [
          ids,
        ])
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await db.query('select count(*)::int as count from public.groups where id=$1', [groupId]))
        .rows[0].count,
    ).toBe(0);
  } finally {
    await db.end();
  }
});

type CameraProbe = {
  mode: string;
  tracks: MediaStreamTrack[];
  stops: number;
  requests: number;
  frameReads: number;
  frameSizes: number[];
  release: (() => void) | null;
};
declare global {
  interface Window {
    __qrCameraProbe: CameraProbe;
  }
}

/** Camera API/video transport only are replaced: actual canvas pixels enter the production jsQR decoder.
 * captureStream intentionally does not depend on the production Permissions-Policy;
 * device validation with camera=(self) belongs to the human post-merge gate.
 */
async function simulateCamera(page: Page, value: string, mode = 'qr') {
  const matrix = inviteQrMatrix(value);
  await page.addInitScript(
    ({ matrix, mode }) => {
      const state: CameraProbe = {
        mode,
        tracks: [],
        stops: 0,
        requests: 0,
        frameReads: 0,
        frameSizes: [],
        release: null,
      };
      window.__qrCameraProbe = state;
      // Simulate the entire camera transport, not the decoder. Linux WebKit's
      // media backend cannot reliably play canvas MediaStreams like macOS does.
      // Actual canvas pixels still enter production drawImage/getImageData/jsQR;
      // actual MediaStream tracks still prove stop/readyState, including clones.
      const sources = new WeakMap<MediaStream, HTMLCanvasElement>();
      const attached = new WeakMap<
        HTMLMediaElement,
        { stream: MediaStream; canvas: HTMLCanvasElement }
      >();
      const sourceProperty = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'srcObject',
      )!;
      const readyProperty = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'readyState',
      )!;
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        configurable: true,
        get() {
          return attached.get(this)?.stream ?? sourceProperty.get!.call(this);
        },
        set(stream: MediaStream | null) {
          const canvas = stream === null ? undefined : sources.get(stream);
          if (stream && canvas) {
            attached.set(this, { stream, canvas });
            if (this instanceof HTMLVideoElement) this.poster = canvas.toDataURL();
          } else {
            attached.delete(this);
            this.removeAttribute('poster');
            sourceProperty.set!.call(this, stream);
          }
        },
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
        configurable: true,
        get() {
          return attached.has(this) ? 4 : readyProperty.get!.call(this);
        },
      });
      for (const [name, side] of [
        ['videoWidth', 'width'],
        ['videoHeight', 'height'],
      ] as const) {
        const original = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, name)!;
        Object.defineProperty(HTMLVideoElement.prototype, name, {
          configurable: true,
          get() {
            return attached.get(this)?.canvas[side] ?? original.get!.call(this);
          },
        });
      }
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        return attached.has(this) ? Promise.resolve() : originalPlay.call(this);
      };
      const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (
        image: CanvasImageSource,
        ...coordinates: number[]
      ) {
        const source = image instanceof HTMLVideoElement ? attached.get(image)?.canvas : undefined;
        return Reflect.apply(originalDraw, this, [source ?? image, ...coordinates]);
      };
      const originalPixels = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (
        ...args: Parameters<typeof originalPixels>
      ) {
        state.frameReads += 1;
        state.frameSizes.push(Math.max(this.canvas.width, this.canvas.height));
        if (state.mode === 'decode-error') throw new Error('Synthetic camera failure');
        return originalPixels.apply(this, args);
      };
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async (constraints: MediaStreamConstraints) => {
            state.requests += 1;
            if (constraints.audio !== false) throw new Error('Unexpected audio request');
            if (state.mode === 'denied') throw new DOMException('', 'NotAllowedError');
            if (state.mode === 'missing') throw new DOMException('', 'NotFoundError');
            const canvas = document.createElement('canvas');
            canvas.width = 960;
            canvas.height = 720;
            const context = canvas.getContext('2d')!;
            const draw = () => {
              context.fillStyle = '#ffffff';
              context.fillRect(0, 0, canvas.width, canvas.height);
              if (state.mode === 'qr') {
                const scale = Math.floor(640 / (matrix.length + 8));
                context.fillStyle = '#000000';
                matrix.forEach((row, y) =>
                  row.forEach((dark, x) => {
                    if (dark)
                      context.fillRect(120 + (x + 4) * scale, 40 + (y + 4) * scale, scale, scale);
                  }),
                );
              }
            };
            draw();
            const stream = canvas.captureStream(10);
            stream.addTrack(stream.getVideoTracks()[0]!.clone());
            sources.set(stream, canvas);
            const tick = setInterval(draw, 100);
            stream.getTracks().forEach((track) => {
              const stop = track.stop.bind(track);
              track.stop = () => {
                state.stops += 1;
                clearInterval(tick);
                stop();
              };
              state.tracks.push(track);
            });
            if (state.mode === 'late')
              await new Promise<void>((resolve) => {
                state.release = resolve;
              });
            return stream;
          },
        },
      });
    },
    { matrix, mode },
  );
}
async function stopped(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const probe = window.__qrCameraProbe;
        return (
          probe.tracks.length > 0 &&
          probe.tracks.every((track) => track.readyState === 'ended') &&
          probe.stops >= probe.tracks.length
        );
      }),
    )
    .toBe(true);
  const reads = await page.evaluate(() => window.__qrCameraProbe.frameReads);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__qrCameraProbe.frameReads)).toBe(reads);
}
async function capture(page: Page, name: string, project: string) {
  const root = process.env.COLETE_QR_SCREENSHOTS_DIR;
  if (root) {
    mkdirSync(root, { recursive: true });
    await page.screenshot({ path: path.join(root, `${project}-${name}.png`), fullPage: true });
  }
}
async function privateCensus(page: Page, markers: string[]) {
  return page.evaluate(async (markers) => {
    const values = [
      location.href,
      document.referrer,
      JSON.stringify(history.state),
      document.title,
      ...Object.keys(localStorage).map((key) => `${key}:${localStorage.getItem(key)}`),
      ...Object.keys(sessionStorage).map((key) => `${key}:${sessionStorage.getItem(key)}`),
    ];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        values.push(request.url);
        const response = await cache.match(request);
        if (response) values.push(await response.text());
      }
    }
    return markers.every((marker) => values.every((value) => !value.includes(marker)));
  }, markers);
}

test('QR is readable, updates on regeneration, and disappears after revocation', async ({
  page,
}, info) => {
  await login(page);
  await page.goto(`/grupos/${groupId}/convites`);
  await expect(page.getByTestId('invite-qr-code')).toBeVisible();
  async function decoded() {
    const png = await page.getByTestId('invite-qr-code').screenshot();
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
  }
  expect((await decoded()) === share.share_url).toBe(true);
  await assertAccessible(page);
  await capture(page, 'convites', info.project.name);
  await page.getByRole('button', { name: 'Regenerar convite', exact: true }).tap();
  await expect
    .poll(async () => (await page.getByTestId('invite-link').innerText()) !== share.share_url)
    .toBe(true);
  await expect(page.getByTestId('invite-code')).toBeVisible();
  const changed = (await edge(owner, 'get_invite_share_link', { invite_id: inviteId })).data;
  await expect.poll(async () => (await decoded()) === changed.share_url).toBe(true);
  await page.getByRole('button', { name: 'Revogar convite', exact: true }).tap();
  await page.getByRole('button', { name: 'Confirmar revogação', exact: true }).tap();
  await expect(page.getByTestId('invite-qr-code')).toHaveCount(0);
  await page.getByRole('button', { name: 'Emitir novo convite', exact: true }).tap();
  await expect(page.getByTestId('invite-qr-code')).toBeVisible();
  // Following tests use this live occasion.
  const listing = await page.getByTestId('invite-link').innerText();
  share = { share_url: listing, code: await page.getByTestId('invite-code').innerText() };
});

test('lazy decoder reads a QR, stops tracks, confirms, and joins through the existing flow', async ({
  page,
}, info) => {
  await simulateCamera(page, share.share_url);
  const token = new URL(share.share_url).hash.slice(7);
  const markers = [token, share.code, share.code.replaceAll('-', '')];
  let leaked = false;
  let previewCount = 0;
  let joins = 0;
  let decoderRequests = 0;
  page.on('console', (message) => {
    if (markers.some((marker) => message.text().includes(marker))) leaked = true;
  });
  page.on('request', (request) => {
    if (
      markers.some(
        (marker) =>
          request.url().includes(marker) || (request.headers()['referer'] ?? '').includes(marker),
      )
    )
      leaked = true;
    const route = new URL(request.url()).pathname;
    if (/\.wasm$/u.test(route) || /(?:jsdelivr|unpkg)\./u.test(new URL(request.url()).hostname))
      leaked = true;
    if (route.includes('/preview_group_by_invite')) previewCount += 1;
    if (route.includes('/join_by_invite')) joins += 1;
    if (/\/jsQR-[^/]+\.js$/u.test(route)) decoderRequests += 1;
    const body = request.postData() ?? '';
    if (
      body.includes(token) &&
      ![
        '/functions/v1/groups/preview_group_by_invite',
        '/functions/v1/groups/join_by_invite',
      ].includes(route)
    )
      leaked = true;
  });
  await login(page, joiner);
  await page.goto('/join');
  expect(decoderRequests).toBe(0);
  await page.getByTestId('group-code').fill('bad');
  await page.getByTestId('preview-code').tap();
  await expect(page.getByTestId('group-code')).toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('read-invite-qr').tap();
  await expect(page.getByTestId('join-confirmation')).toBeVisible();
  await expect(page.getByTestId('group-code')).toHaveAttribute('aria-invalid', 'false');
  await expect(page.getByTestId('group-code')).toHaveValue('');
  await stopped(page);
  expect(decoderRequests).toBe(1);
  expect(previewCount).toBe(1);
  expect(joins).toBe(0);
  await assertAccessible(page);
  await capture(page, 'confirmacao', info.project.name);
  expect(await privateCensus(page, markers)).toBe(true);
  // Positive sentinels prove the census actually sees forbidden persistence.
  await page.evaluate((token) => localStorage.setItem('qr-canary', token), token);
  expect(await privateCensus(page, markers)).toBe(false);
  await page.evaluate(() => localStorage.removeItem('qr-canary'));
  await page.getByTestId('join-submit').tap();
  await expect(page.getByTestId('group-request-sent')).toBeVisible();
  expect(joins).toBe(1);
  expect(leaked).toBe(false);
  expect(await privateCensus(page, markers)).toBe(true);
});

test('foreign QR is rejected without opening, displaying, logging or transmitting its content', async ({
  page,
}) => {
  const foreign = `https://foreign.example.invalid/join#token=${'A'.repeat(88)}`;
  await simulateCamera(page, foreign);
  let leaked = false;
  page.on('console', (message) => {
    if (message.text().includes(foreign)) leaked = true;
  });
  page.on('request', (request) => {
    if (request.url().includes('foreign.example.invalid') || request.postData()?.includes(foreign))
      leaked = true;
  });
  await login(page);
  await page.goto('/join');
  await page.getByTestId('read-invite-qr').tap();
  await expect(page.getByTestId('invite-camera-error')).toHaveText(
    'Este QR não é um convite do Colete',
  );
  await expect(page.getByTestId('invite-camera-error-focus')).toBeFocused();
  await stopped(page);
  expect(
    await page
      .locator('body')
      .innerText()
      .then((text) => !text.includes(foreign)),
  ).toBe(true);
  expect(new URL(page.url()).pathname).toBe('/join');
  expect(leaked).toBe(false);
  expect(page.context().pages()).toHaveLength(1);
  expect(await privateCensus(page, [foreign])).toBe(true);
});

for (const mode of ['denied', 'missing', 'decode-error']) {
  test(`camera ${mode} offers typing with a stable message`, async ({ page }, info) => {
    await simulateCamera(page, share.share_url, mode);
    await login(page);
    await page.goto('/join');
    await page.getByTestId('read-invite-qr').tap();
    await expect(page.getByTestId('invite-camera-error')).toContainText(
      mode === 'denied' ? 'Permissão da câmera negada' : 'A câmera não está disponível',
    );
    await expect(page.getByTestId('invite-camera-error-focus')).toBeFocused();
    if (mode === 'decode-error') await stopped(page);
    await page.getByRole('button', { name: 'Digitar código', exact: true }).tap();
    await expect(page.getByTestId('group-code')).toBeFocused();
    await expect(page.getByTestId('invite-camera-error')).toHaveCount(0);
    await assertAccessible(page);
    await capture(page, `fallback-${mode}`, info.project.name);
    await page.getByTestId('group-code').fill(share.code);
    await page.getByTestId('preview-code').tap();
    await expect(page.getByTestId('join-confirmation')).toBeVisible();
  });
}

for (const ending of [
  'cancel',
  'typing',
  'navigation',
  'hidden',
  'pagehide',
  'video-error',
  'track-ended',
  'late',
]) {
  test(`all camera tracks stop on ${ending}`, async ({ page }, info) => {
    await simulateCamera(page, share.share_url, ending === 'late' ? 'late' : 'blank');
    await login(page);
    await page.goto('/join');
    await page.getByTestId('read-invite-qr').tap();
    await expect
      .poll(() => page.evaluate(() => window.__qrCameraProbe.tracks.length))
      .toBeGreaterThan(0);
    await expect(page.getByTestId('cancel-invite-camera')).toBeFocused();
    if (ending !== 'late') {
      await expect
        .poll(() => page.evaluate(() => window.__qrCameraProbe.frameReads))
        .toBeGreaterThan(0);
      const before = await page.evaluate(() => window.__qrCameraProbe.frameReads);
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => window.__qrCameraProbe.frameReads);
      expect(after - before).toBeLessThanOrEqual(5);
      expect(
        await page.evaluate(() => window.__qrCameraProbe.frameSizes.every((side) => side <= 480)),
      ).toBe(true);
    }
    if (ending === 'cancel') {
      await assertAccessible(page);
      await capture(page, 'camera', info.project.name);
      await page.getByTestId('cancel-invite-camera').tap();
    } else if (ending === 'typing')
      await page.getByRole('button', { name: 'Digitar código', exact: true }).tap();
    else if (ending === 'navigation')
      await page.getByRole('link', { name: 'Perfil', exact: true }).tap();
    else if (ending === 'pagehide')
      await page.evaluate((event) => window.dispatchEvent(new Event(event)), ending);
    else if (ending === 'hidden')
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    else if (ending === 'video-error')
      await page.locator('video').evaluate((video) => video.dispatchEvent(new Event('error')));
    else if (ending === 'track-ended')
      await page.evaluate(() =>
        window.__qrCameraProbe.tracks[0]!.dispatchEvent(new Event('ended')),
      );
    else {
      await page.getByTestId('cancel-invite-camera').tap();
      await page.evaluate(() => window.__qrCameraProbe.release?.());
    }
    await stopped(page);
    if (ending === 'cancel') {
      // Reopening creates a fresh stream; the previous track remains ended.
      await page.getByTestId('read-invite-qr').tap();
      await expect.poll(() => page.evaluate(() => window.__qrCameraProbe.tracks.length)).toBe(4);
      await page.getByTestId('cancel-invite-camera').tap();
      await stopped(page);
    }
  });
}

test('permission prompt blur keeps reader open and reads after permission is granted', async ({
  page,
}) => {
  await simulateCamera(page, share.share_url, 'late');
  await login(page);
  await page.goto('/join');
  await page.getByTestId('read-invite-qr').tap();
  await expect.poll(() => page.evaluate(() => window.__qrCameraProbe.release !== null)).toBe(true);
  await expect(page.getByTestId('cancel-invite-camera')).toBeFocused();
  expect(await page.evaluate(() => window.__qrCameraProbe.frameReads)).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.evaluate(() => window.__qrCameraProbe.release?.());
  await expect(page.getByTestId('invite-camera')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__qrCameraProbe.frameReads))
    .toBeGreaterThan(0);
  // Blur remains harmless after permission too; hidden/pagehide are the background signals.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByTestId('invite-camera')).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.__qrCameraProbe.tracks.every((track) => track.readyState === 'live'),
    ),
  ).toBe(true);
  await page.evaluate(() => {
    window.__qrCameraProbe.mode = 'qr';
  });
  await expect(page.getByTestId('join-confirmation')).toBeVisible();
  await stopped(page);
  await expect(page.getByTestId('invite-camera')).toHaveCount(0);
});
