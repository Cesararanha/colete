import { expect, test, type APIRequestContext, type Browser, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';

import {
  assertAccessible,
  createVerifiedUser,
  localEnvironment,
  runWorker,
} from './support/local-stack';
import { handledObserver } from './support/observers';

// PR K (item 6 do feedback do César, 19/10/2026): the person changes and
// removes their own photo; the owner changes the group's. A photo picked with
// GPS in its Exif reaches the server re-encoded, at 512 px, with no metadata.
// A co-member sees the photo, a stranger does not, not even by the object's
// direct address; the organizer has no way to the group photo.

const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-fotos-2026';
const prefix = `fotos-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_FOTOS_SCREENSHOTS_DIR'];
const ZONE = 'America/Sao_Paulo';
type Actor = { authId: string; profileId: string; token: string; email: string; name: string };

test.use({ timezoneId: ZONE, colorScheme: 'dark' });

/** Captures at 390 px, the width of the prévia, then restore the project viewport. */
async function shot(page: Page, project: string, file: string) {
  if (project !== 'mobile-chromium' || !screenshotRoot || !existsSync(screenshotRoot)) return;
  const previous = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const height = Math.max(
    0,
    ...(await page
      .locator('[data-testid="authenticated-main"]:visible')
      .evaluateAll((elements) => elements.map((element) => element.scrollHeight))),
  );
  await page.setViewportSize({ width: 390, height: Math.max(844, height + 180) });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(screenshotRoot, file), scale: 'css' });
  await page.setViewportSize(previous);
}

async function photoWithGps(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 90, b: 40 } },
  })
    .withExif({
      IFD0: { Make: 'Colete E2E Camera', Model: 'GPS Fixture' },
      IFD3: {
        GPSLatitudeRef: 'S',
        GPSLatitude: '23/1 33/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '46/1 38/1 0/1',
      },
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}
async function cleanPhoto(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 140, b: 90 } } })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Any Exif segment, and the GPS directory pointer (tag 0x8825) inside it. */
function exifOf(bytes: Buffer) {
  const exif = bytes.indexOf('Exif\0\0', 0, 'latin1');
  if (exif < 0) return { exif: false, gps: false };
  const tiff = exif + 6;
  const little = bytes.readUInt16BE(tiff) === 0x4949;
  const u16 = (at: number) => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
  const u32 = (at: number) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  const ifd = tiff + u32(tiff + 4);
  let gps = false;
  for (let entry = 0; entry < u16(ifd); entry += 1) gps ||= u16(ifd + 2 + entry * 12) === 0x8825;
  return { exif: true, gps };
}

async function createActor(request: APIRequestContext, label: string, name: string, ids: string[]) {
  const email = `${prefix}-${label}@colete.test`;
  const { id } = await createVerifiedUser(request, env, { email, name, password });
  ids.push(id);
  const signed = await request.post(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
    data: { email, password },
    headers: { apikey: env.publishableKey },
  });
  expect(signed.status()).toBe(200);
  const session = (await signed.json()) as { access_token: string };
  const profiled = await request.post(`${env.functionsUrl}/identity/complete_profile`, {
    data: { request_id: crypto.randomUUID(), profile: { name } },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  expect(profiled.status()).toBe(200);
  const outcome = (await profiled.json()) as { data: { outcome: { profile_id: string } } };
  return {
    authId: id,
    profileId: outcome.data.outcome.profile_id,
    token: session.access_token,
    email,
    name,
  } satisfies Actor;
}

async function call(
  request: APIRequestContext,
  actor: Actor,
  operation: string,
  data: Record<string, unknown>,
  read = false,
) {
  const response = await request.post(`${env.functionsUrl}/groups/${operation}`, {
    data: read ? data : { request_id: crypto.randomUUID(), ...data },
    headers: { Authorization: `Bearer ${actor.token}` },
  });
  return { status: response.status(), body: (await response.json()) as Record<string, any> };
}
async function gateway(
  request: APIRequestContext,
  actor: Actor,
  operation: string,
  data: Record<string, unknown>,
  read = false,
) {
  const result = await call(request, actor, operation, data, read);
  expect(result.status, `${operation}: ${JSON.stringify(result.body)}`).toBe(200);
  return result.body['data'] as Record<string, any>;
}

async function storedObject(bucket: string, objectPath: string) {
  const response = await fetch(`${env.apiUrl}/storage/v1/object/${bucket}/${objectPath}`, {
    headers: { apikey: env.secretKey, Authorization: `Bearer ${env.secretKey}` },
  });
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

async function cleanActors(authIds: string[], db: pg.Client, request: APIRequestContext) {
  if (authIds.length === 0) return;
  const ids = (
    await db.query('select id from public.profiles where auth_user_id = any($1::uuid[])', [authIds])
  ).rows.map((row: { id: string }) => row.id);
  const groups = (
    await db.query('select id from public.groups where owner_id = any($1::uuid[])', [ids])
  ).rows.map((row: { id: string }) => row.id);
  for (const [bucket, owners] of [
    ['avatars', ids],
    ['group-photos', groups],
  ] as const) {
    const names = (
      await db.query(
        `select name from storage.objects where bucket_id = $1
          and split_part(name, '/', 1) = any($2::text[])`,
        [bucket, owners],
      )
    ).rows.map((row: { name: string }) => row.name);
    if (names.length > 0) {
      await request.delete(`${env.apiUrl}/storage/v1/object/${bucket}`, {
        data: { prefixes: names },
        headers: { apikey: env.secretKey, Authorization: `Bearer ${env.secretKey}` },
      });
    }
  }
  await db.query('begin');
  try {
    await db.query(
      `delete from private.external_effects where resource_id in (
         select id from private.photo_uploads
          where profile_id = any($1::uuid[]) or group_id = any($2::uuid[]))`,
      [ids, groups],
    );
    await db.query(
      'delete from private.photo_uploads where profile_id = any($1::uuid[]) or group_id = any($2::uuid[])',
      [ids, groups],
    );
    await db.query('delete from private.invite_rate_limits where profile_id = any($1::uuid[])', [
      ids,
    ]);
    await db.query('delete from private.idempotency_records where actor_id = any($1::uuid[])', [
      ids,
    ]);
    await db.query(
      `delete from private.match_players where profile_id = any($1::uuid[]) or match_id in
         (select id from private.matches where group_id = any($2::uuid[]))`,
      [ids, groups],
    );
    for (const statement of [
      'delete from private.matches where group_id = any($1::uuid[])',
      'delete from public.group_invites where group_id = any($1::uuid[])',
      'delete from public.group_members where group_id = any($1::uuid[])',
      'delete from public.groups where id = any($1::uuid[])',
    ])
      await db.query(statement, [groups]);
    await db.query('delete from public.profiles where id = any($1::uuid[])', [ids]);
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
  for (const id of authIds) {
    const response = await fetch(`${env.apiUrl}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: env.secretKey, Authorization: `Bearer ${env.secretKey}` },
    });
    expect([200, 204, 404]).toContain(response.status);
  }
}

async function login(page: Page, actor: Actor) {
  await page.goto('/entrar');
  await page.getByTestId('login-email').fill(actor.email);
  await page.getByTestId('login-password').fill(password);
  const response = handledObserver(
    page.waitForResponse(
      (item) =>
        new URL(item.url()).pathname === '/auth/v1/token' && item.request().method() === 'POST',
    ),
  );
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Grupos', level: 1 })).toBeVisible();
}
async function pageFor(browser: Browser, actor: Actor, like: Page) {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:4173',
    colorScheme: 'dark',
    locale: 'pt-BR',
    timezoneId: ZONE,
    viewport: like.viewportSize(),
  });
  const page = await context.newPage();
  await login(page, actor);
  return page;
}

/** Presses `trigger`, answers the PWA file chooser with `bytes`. */
async function choosePhoto(page: Page, trigger: string, bytes: Buffer, name = 'foto.jpg') {
  const chooser = handledObserver(page.waitForEvent('filechooser'));
  await page.getByTestId(trigger).click();
  await (await chooser).setFiles({ name, mimeType: 'image/jpeg', buffer: bytes });
}

async function setup(request: APIRequestContext, authIds: string[]) {
  const owner = await createActor(request, 'owner', 'Ana Dona', authIds);
  const organizer = await createActor(request, 'organizer', 'Bia Org', authIds);
  const member = await createActor(request, 'member', 'Caio Jogador', authIds);
  const stranger = await createActor(request, 'stranger', 'Duda Fora', authIds);
  const created = await gateway(request, owner, 'create_group', { name: 'Racha das Fotos' });
  const { group_id: groupId, invite_id: inviteId } = created['outcome'];
  const share = await gateway(
    request,
    owner,
    'get_invite_share_link',
    { invite_id: inviteId },
    true,
  );
  for (const actor of [organizer, member]) {
    await gateway(request, actor, 'join_by_code', { code: share['code'] });
    await gateway(request, owner, 'approve_member', {
      group_id: groupId,
      profile_id: actor.profileId,
      approve: true,
    });
  }
  await gateway(request, owner, 'set_role', {
    group_id: groupId,
    profile_id: organizer.profileId,
    role: 'organizer',
  });
  return { owner, organizer, member, stranger, groupId: groupId as string };
}

test('the person changes and removes their photo; it reaches the server without GPS; only co-members see it', async ({
  page,
  request,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const { owner, member, stranger, groupId } = await setup(request, authIds);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      if (!error.message.includes('Minified React error #418')) pageErrors.push(error.message);
    });

    await login(page, owner);
    await page.getByTestId('profile-avatar-link').click();
    const button = page.getByTestId('profile-photo-button');
    await expect(button).toHaveAccessibleName('Foto de perfil');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button.getByTestId('avatar-photo')).toHaveCount(0);
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('profile-photo-choose')).toHaveAccessibleName('Trocar foto');
    // No photo yet: nothing to remove.
    await expect(page.getByTestId('profile-photo-remove')).toHaveCount(0);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'perfil-opcoes.png');

    // A failed send says so and keeps the current photo: the signed upload
    // never reaches Storage.
    await page.route('**/storage/v1/object/upload/sign/**', (route) => route.abort('failed'));
    await choosePhoto(page, 'profile-photo-choose', await cleanPhoto(300, 300));
    await expect(page.getByTestId('profile-photo-error')).toHaveText(
      'A foto não foi enviada. Confira a conexão e tente de novo.',
    );
    await page.unroute('**/storage/v1/object/upload/sign/**');
    await expect(button.getByTestId('avatar-photo')).toHaveCount(0);
    expect(
      (await db.query('select photo_url from public.profiles where id = $1', [owner.profileId]))
        .rows[0].photo_url,
    ).toBeNull();
    await shot(page, testInfo.project.name, 'perfil-erro.png');

    // A camera photo with GPS in its Exif, larger than 512 px. The swap is
    // held back a moment so the sending state can be seen.
    const original = await photoWithGps(1600, 1200);
    expect(exifOf(original)).toEqual({ exif: true, gps: true });
    await page.route('**/functions/v1/groups/set_profile_photo', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.continue();
    });
    const swapped = handledObserver(
      page.waitForResponse((item) => item.url().endsWith('/groups/set_profile_photo')),
    );
    const uploaded = handledObserver(
      page.waitForRequest(
        (item) => item.method() === 'PUT' && item.url().includes('/upload/sign/avatars/'),
      ),
    );
    await choosePhoto(page, 'profile-photo-choose', original);
    await expect(page.getByTestId('profile-photo-status')).toHaveText('Enviando foto…');
    await shot(page, testInfo.project.name, 'perfil-enviando.png');
    const sent = await uploaded;
    expect(sent.headers()['content-type']).toBe('image/jpeg');
    expect((await swapped).status()).toBe(200);
    await page.unroute('**/functions/v1/groups/set_profile_photo');
    await expect(page.getByTestId('profile-photo-status')).toHaveText('Foto atualizada.');
    await expect(button.getByTestId('avatar-photo')).toHaveCount(1);
    await expect(page.getByTestId('profile-avatar-link').getByTestId('avatar-photo')).toHaveCount(
      1,
    );
    await expect(page.getByTestId('profile-photo-remove')).toHaveAccessibleName('Remover foto');
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'perfil-com-foto.png');

    // What the server keeps: the path it chose, a 512 px JPEG and no Exif.
    const stored = (
      await db.query('select photo_url from public.profiles where id = $1', [owner.profileId])
    ).rows[0].photo_url as string;
    expect(stored).toMatch(new RegExp(`^${owner.profileId}/[0-9a-f-]{36}\\.jpg$`, 'u'));
    const bytes = await storedObject('avatars', stored);
    expect(exifOf(bytes)).toEqual({ exif: false, gps: false });
    const metadata = await sharp(bytes).metadata();
    expect({ format: metadata.format, width: metadata.width, height: metadata.height }).toEqual({
      format: 'jpeg',
      width: 512,
      height: 384,
    });
    expect(metadata.exif).toBeUndefined();

    // The co-member sees the photo in the group; the stranger gets no URL and
    // cannot read the object by its address, even with the member's signed path.
    const memberPage = await pageFor(browser, member, page);
    // The list asks for the group icons first; the detail asks for the members.
    const urls = handledObserver(
      memberPage.waitForResponse(async (item) => {
        if (!item.url().endsWith('/groups/get_photo_urls')) return false;
        const answer = (await item.json()) as { data?: { profiles?: Record<string, string> } };
        return typeof answer.data?.profiles?.[owner.profileId] === 'string';
      }),
    );
    await memberPage.getByTestId('group-list-card').click();
    const photoAnswer = (await (await urls).json()) as {
      data: { profiles: Record<string, string> };
    };
    const signed = photoAnswer.data.profiles[owner.profileId];
    expect(signed).toMatch(/^\/storage\/v1\/object\/sign\/avatars\//u);
    await expect(memberPage.getByTestId('avatar-photo').first()).toBeVisible();
    await shot(memberPage, testInfo.project.name, 'grupo-membro-foto.png');
    const strangerUrls = await gateway(
      request,
      stranger,
      'get_photo_urls',
      { profile_ids: [owner.profileId], group_ids: [groupId] },
      true,
    );
    expect(strangerUrls).toEqual({ expires_in: 300, self: null, profiles: {}, groups: {} });
    for (const route of [`object/avatars/${stored}`, `object/authenticated/avatars/${stored}`]) {
      const direct = await fetch(`${env.apiUrl}/storage/v1/${route}`, {
        headers: { apikey: env.publishableKey, Authorization: `Bearer ${stranger.token}` },
      });
      expect(direct.status, route).not.toBe(200);
    }
    const publicRead = await fetch(`${env.apiUrl}/storage/v1/object/public/avatars/${stored}`);
    expect(publicRead.status).not.toBe(200);

    // Remove: the initials come back, and the worker deletes the object.
    await page.getByTestId('profile-photo-remove').click();
    await expect(page.getByTestId('profile-photo-status')).toHaveText('Foto removida.');
    await expect(button.getByTestId('avatar-photo')).toHaveCount(0);
    await expect(button).toContainText('AD');
    await expect(page.getByTestId('profile-photo-remove')).toHaveCount(0);
    await shot(page, testInfo.project.name, 'perfil-sem-foto.png');
    expect(
      (await db.query('select photo_url from public.profiles where id = $1', [owner.profileId]))
        .rows[0].photo_url,
    ).toBeNull();
    await runWorker(request, env, db);
    expect(
      (
        await db.query(
          `select count(*)::integer as n from storage.objects where bucket_id = 'avatars' and name = $1`,
          [stored],
        )
      ).rows[0].n,
    ).toBe(0);

    expect(pageErrors).toEqual([]);
    await memberPage.context().close();
  } finally {
    await cleanActors(authIds, db, request);
    await db.end();
  }
});

test('the owner changes the group photo; members see it in the list, the detail and the Agenda; the organizer cannot', async ({
  page,
  request,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const { owner, organizer, member, groupId } = await setup(request, authIds);
    const start = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 2 * 86_400_000);
    await gateway(request, owner, 'create_match', {
      group_id: groupId,
      config: {
        starts_at: start.toISOString(),
        ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(),
        timezone: ZONE,
        location_name: 'Arena das Fotos',
        location_address: null,
        description: null,
        latitude: null,
        longitude: null,
        field_slots: 14,
        field_price: '15.00',
      },
    });

    // The organizer reaches the screen by address and finds no photo control.
    const organizerPage = await pageFor(browser, organizer, page);
    await organizerPage.goto(`/grupos/${groupId}/icone`);
    await expect(organizerPage.getByTestId('appearance-owner-only')).toBeVisible();
    await expect(organizerPage.getByTestId('group-photo-choose')).toHaveCount(0);
    await expect(organizerPage.getByRole('heading', { name: 'Foto do grupo' })).toHaveCount(0);
    const forced = await call(request, organizer, 'begin_photo_upload', {
      target: 'group',
      group_id: groupId,
    });
    expect(forced.status).toBe(403);
    expect(forced.body['error']['code']).toBe('OWNER_ONLY');

    await login(page, owner);
    await page.goto(`/grupos/${groupId}/icone`);
    await expect(page.getByRole('heading', { level: 2, name: 'Foto do grupo' })).toBeVisible();
    await expect(page.getByTestId('group-photo-choose')).toHaveAccessibleName('Escolher foto');
    await expect(page.getByTestId('group-photo-remove')).toHaveCount(0);
    const preview = page.getByTestId('appearance-preview');
    await expect(preview.getByTestId('group-photo')).toHaveCount(0);
    const swapped = handledObserver(
      page.waitForResponse((item) => item.url().endsWith('/groups/set_group_photo')),
    );
    await choosePhoto(page, 'group-photo-choose', await cleanPhoto(900, 900));
    expect((await swapped).status()).toBe(200);
    await expect(page.getByTestId('group-photo-status')).toHaveText('Foto atualizada.');
    await expect(preview.getByTestId('group-photo')).toBeVisible();
    await expect(page.getByTestId('group-photo-remove')).toHaveAccessibleName('Remover foto');
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'grupo-foto-dono.png');
    const stored = (await db.query('select photo_url from public.groups where id = $1', [groupId]))
      .rows[0].photo_url as string;
    expect(stored).toMatch(new RegExp(`^${groupId}/[0-9a-f-]{36}\\.jpg$`, 'u'));
    expect((await sharp(await storedObject('group-photos', stored)).metadata()).width).toBe(512);

    const memberPage = await pageFor(browser, member, page);
    const listCard = memberPage.getByTestId('group-list-card');
    await expect(listCard.getByTestId('group-photo')).toBeVisible();
    await shot(memberPage, testInfo.project.name, 'grupos-lista-foto.png');
    await listCard.click();
    await expect(
      memberPage.getByTestId('group-detail-card').getByTestId('group-photo'),
    ).toBeVisible();
    await shot(memberPage, testInfo.project.name, 'grupo-detalhe-foto.png');
    await memberPage
      .getByRole('navigation', { name: 'Navegação principal' })
      .getByRole('link', { name: 'Agenda' })
      .click();
    const card = memberPage
      .getByTestId('authenticated-main')
      .filter({ has: memberPage.getByRole('heading', { level: 1, name: 'Agenda' }) })
      .getByTestId('match-list-card');
    await expect(card.getByTestId('group-photo')).toBeVisible();
    await assertAccessible(memberPage);
    await shot(memberPage, testInfo.project.name, 'agenda-foto.png');

    // Removed: the icon is back for everyone.
    await page.getByTestId('group-photo-remove').click();
    await expect(page.getByTestId('group-photo-status')).toHaveText('Foto removida.');
    await expect(preview.getByTestId('group-photo')).toHaveCount(0);
    await expect(preview.locator('[data-group-icon="ball"]')).toHaveCount(1);
    await memberPage.goto('/grupos');
    await expect(memberPage.getByTestId('group-list-card').getByTestId('group-photo')).toHaveCount(
      0,
    );

    await organizerPage.context().close();
    await memberPage.context().close();
  } finally {
    await cleanActors(authIds, db, request);
    await db.end();
  }
});
