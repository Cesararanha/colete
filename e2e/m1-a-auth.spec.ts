import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const { Client } = pg;
const repositoryRoot = process.cwd();
const supabaseBinary = path.join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
);
const runSuffix = `${Date.now()}-${process.pid}`;
const account = {
  email: `auth-e2e-${runSuffix}@colete.test`,
  name: 'Ana Acessível',
  password: 'Frase-segura-2026',
};

function localEnvironment() {
  const raw = execFileSync(supabaseBinary, ['status', '-o', 'env'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const read = (name: string) => {
    const value = raw.match(new RegExp(`^${name}="([^"]+)"$`, 'm'))?.[1];
    if (value === undefined) throw new Error(`supabase status did not expose ${name}`);
    return value;
  };
  return { dbUrl: read('DB_URL'), mailUrl: read('MAILPIT_URL') };
}

type MailpitSummary = { ID: string; To?: { Address?: string }[] };

async function messagesForRecipient(
  request: APIRequestContext,
  mailUrl: string,
  email: string,
): Promise<MailpitSummary[]> {
  const inbox = await request.get(`${mailUrl}/api/v1/messages`);
  if (!inbox.ok()) throw new Error('The local Mailpit inbox could not be read.');
  const payload = (await inbox.json()) as { messages?: MailpitSummary[] };
  return (payload.messages ?? []).filter((candidate) =>
    candidate.To?.some((recipient) => recipient.Address?.toLowerCase() === email.toLowerCase()),
  );
}

async function deleteMessagesForRecipient(
  request: APIRequestContext,
  mailUrl: string,
  email: string,
) {
  const ids = (await messagesForRecipient(request, mailUrl, email)).map((message) => message.ID);
  if (ids.length === 0) return;
  const removed = await request.delete(`${mailUrl}/api/v1/messages`, { data: { IDs: ids } });
  if (!removed.ok()) throw new Error('The local OTP message could not be removed from Mailpit.');
}

async function readLatestOtp(request: APIRequestContext, mailUrl: string, email: string) {
  return expect
    .poll(
      async () => {
        const message = (await messagesForRecipient(request, mailUrl, email))[0];
        if (message === undefined) return null;
        const detail = await request.get(`${mailUrl}/api/v1/message/${message.ID}`);
        if (!detail.ok()) return null;
        const content = (await detail.json()) as { HTML?: string; Text?: string };
        return `${content.Text ?? ''}\n${content.HTML ?? ''}`.match(/\b(\d{6})\b/u)?.[1] ?? null;
      },
      { intervals: [250, 500, 1_000], timeout: 15_000 },
    )
    .not.toBeNull()
    .then(async () => {
      const message = (await messagesForRecipient(request, mailUrl, email))[0];
      if (message === undefined) throw new Error('The OTP message disappeared from Mailpit.');
      const detail = (await (
        await request.get(`${mailUrl}/api/v1/message/${message.ID}`)
      ).json()) as { HTML?: string; Text?: string };
      const otp = `${detail.Text ?? ''}\n${detail.HTML ?? ''}`.match(/\b(\d{6})\b/u)?.[1];
      if (otp === undefined) throw new Error('The local e-mail did not contain a six-digit OTP.');
      await deleteMessagesForRecipient(request, mailUrl, email);
      return otp;
    });
}

async function assertAccessible(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  const targets = page.getByRole('button');
  for (let index = 0; index < (await targets.count()); index += 1) {
    const box = await targets.nth(index).boundingBox();
    if (box !== null) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
  }

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) =>
      ['critical', 'serious'].includes(violation.impact ?? ''),
    ),
  ).toEqual([]);
}

test.describe('M1-A authentication', () => {
  test('creates a real account, reads OTP from local e-mail and completes the profile', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    const env = localEnvironment();
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();

    try {
      await page.goto('/criar-conta');
      await page.getByLabel('Nome').fill(account.name);
      await page.getByLabel('E-mail').fill(account.email.toUpperCase());
      await page.getByLabel('Senha', { exact: true }).fill(account.password);
      await page.getByLabel('Confirmar senha').fill(account.password);
      await page.getByRole('button', { name: 'Enviar código' }).click();

      await expect(page).toHaveURL(/\/verificar-codigo$/u);
      const otp = await readLatestOtp(request, env.mailUrl, account.email);
      await page.getByLabel('Código de 6 dígitos').fill(otp);
      await page.getByRole('button', { name: 'Verificar e continuar' }).click();

      await expect(
        page.getByRole('heading', { level: 1, name: 'Sua conta está pronta' }),
      ).toBeVisible();
      await expect(page.getByTestId('authenticated-ready')).toContainText(account.name);
      await assertAccessible(page);

      const evidence = await db.query<{
        acceptance_count: number;
        idempotency_state: string;
        profile_count: number;
      }>(
        `select
           (select count(*)::int from public.profiles where auth_user_id = users.id) as profile_count,
           (select count(*)::int
              from public.policy_acceptances as acceptance
              join public.profiles as profile on profile.id = acceptance.profile_id
             where profile.auth_user_id = users.id) as acceptance_count,
           (select record.state
              from private.idempotency_records as record
              join public.profiles as profile on profile.id = record.actor_id
             where profile.auth_user_id = users.id
               and record.operation = 'complete_profile') as idempotency_state
         from auth.users as users
        where lower(users.email) = lower($1)`,
        [account.email],
      );
      expect(evidence.rows).toEqual([
        { acceptance_count: 0, idempotency_state: 'completed', profile_count: 1 },
      ]);
    } finally {
      await deleteMessagesForRecipient(request, env.mailUrl, account.email);
      const user = await db.query<{ id: string }>(
        'select id from auth.users where lower(email) = lower($1)',
        [account.email],
      );
      const userId = user.rows[0]?.id;
      if (userId !== undefined) {
        await db.query(
          `delete from private.idempotency_records
            where actor_id in (select id from public.profiles where auth_user_id = $1)`,
          [userId],
        );
        await db.query(
          `delete from private.revoked_auth_sessions
            where profile_id in (select id from public.profiles where auth_user_id = $1)`,
          [userId],
        );
        await db.query('delete from public.profiles where auth_user_id = $1', [userId]);
        await db.query('delete from auth.users where id = $1', [userId]);
      }
      const residual = await db.query<{ count: number }>(
        'select count(*)::int as count from auth.users where lower(email) = lower($1)',
        [account.email],
      );
      expect(residual.rows[0]?.count).toBe(0);
      await db.end();
    }
  });

  test('all four screens reflow, expose focus, validation and automated accessibility', async ({
    page,
  }, testInfo) => {
    for (const route of ['/entrar', '/criar-conta', '/verificar-codigo', '/esqueci-senha']) {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByTestId('auth-wide-aside')).toHaveCount(
        testInfo.project.name === 'wide-chromium' ? 1 : 0,
      );
      await assertAccessible(page);
    }

    await page.goto('/criar-conta');
    await page.getByRole('button', { name: 'Enviar código' }).click();
    await expect(page.getByLabel('Nome')).toBeFocused();
    await expect(page.getByRole('alert').first()).toContainText('pelo menos 2 caracteres');
    await page.getByLabel('Nome').fill('A');
    await expect(page.getByRole('alert').first()).toContainText('pelo menos 2 caracteres');
    await page.getByLabel('Nome').fill('Ana');
    await expect(page.getByText('Digite pelo menos 2 caracteres para o nome.')).toHaveCount(0);

    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() =>
      document.activeElement === null
        ? 'none'
        : getComputedStyle(document.activeElement).outlineStyle,
    );
    expect(outline).not.toBe('none');

    await page.getByRole('button', { name: 'Usar tema escuro' }).click();
    await assertAccessible(page);
  });

  test('a network failure is honest and offers a retry', async ({ page }) => {
    await page.route('**/auth/v1/token**', (route) => route.abort('connectionfailed'));
    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill('pessoa@colete.test');
    await page.getByLabel('Senha', { exact: true }).fill('senha-segura');
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Confira sua conexão');
    await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
  });
});
