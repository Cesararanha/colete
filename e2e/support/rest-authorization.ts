import { expect, type Page, type TestInfo } from '@playwright/test';

type ObservedRestRequest = {
  credential: string;
  /** Only the result of comparing `sub` with the account that left, never the `sub`. */
  leavingAccountJwt: boolean;
  label: string;
  phase: 'before-logout' | 'after-logout';
  userJwt: boolean;
};

/**
 * The `sub` of `Authorization: Bearer <jwt>` when its payload is a GoTrue user
 * access token: role `authenticated` and a non-empty `sub`. The publishable
 * key, the legacy anon JWT and a missing header all give `null`. The value is
 * only compared in memory; callers must never record or print it.
 */
export function userJwtSubject(authorization: string | undefined): string | null {
  const match = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/u.exec(authorization ?? '');
  const payloadSegment = match?.[2];
  if (payloadSegment === undefined) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      role?: unknown;
      sub?: unknown;
    };
    return payload.role === 'authenticated' && typeof payload.sub === 'string' && payload.sub !== ''
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}

/** True only for a GoTrue user access token, whoever it belongs to. */
export function carriesUserJwt(authorization: string | undefined) {
  return userJwtSubject(authorization) !== null;
}

/** What the request carried, never the value itself. */
function credentialKind(authorization: string | undefined) {
  if (authorization === undefined) return 'no Authorization header';
  if (carriesUserJwt(authorization)) return 'user JWT';
  if (/^Bearer sb_publishable_/u.test(authorization)) return 'publishable key as Bearer';
  if (/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u.test(authorization)) return 'non-user JWT';
  return 'other Authorization value';
}

/**
 * Records every PostgREST request the page sends, split at the logout click.
 * Only method, path, the kind of credential and whether the JWT belongs to
 * the account that left are kept: no header value, token, `sub` or body
 * enters the record, the annotations or a failure message.
 */
export function observeRestAuthorization(page: Page) {
  const observed: ObservedRestRequest[] = [];
  let phase: ObservedRestRequest['phase'] = 'before-logout';
  // Subjects seen before the logout, held only until markLogout turns them
  // into booleans. After the logout each request is compared on arrival.
  let subjectsBeforeLogout: (string | null)[] = [];
  let leavingAuthUserId: string | null = null;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/rest/v1/')) return;
    const authorization = request.headers()['authorization'];
    const subject = userJwtSubject(authorization);
    if (phase === 'before-logout') subjectsBeforeLogout.push(subject);
    observed.push({
      credential: credentialKind(authorization),
      leavingAccountJwt: leavingAuthUserId !== null && subject === leavingAuthUserId,
      label: `${request.method()} ${url.pathname}`,
      phase,
      userJwt: subject !== null,
    });
  });

  return {
    /**
     * Splits the record at the logout. With the Auth user id of the account
     * that is leaving, every request is also classified by whether its JWT
     * belongs to that account; the id itself is never stored in the record.
     */
    markLogout(accountLeaving?: string) {
      phase = 'after-logout';
      if (accountLeaving === undefined) return;
      leavingAuthUserId = accountLeaving;
      observed
        .filter((request) => request.phase === 'before-logout')
        .forEach((request, index) => {
          request.leavingAccountJwt = subjectsBeforeLogout[index] === accountLeaving;
        });
      subjectsBeforeLogout = [];
    },
    /**
     * Fails if any PostgREST request left the page without a user JWT after
     * the logout. The observer proves it was live: it must have classified at
     * least one request before the logout as carrying a user JWT, and the
     * counts are recorded as test annotations on every run.
     */
    assertNoAnonymousRequestAfterLogout(testInfo: TestInfo) {
      const before = observed.filter((request) => request.phase === 'before-logout');
      const after = observed.filter((request) => request.phase === 'after-logout');
      const anonymousAfter = after
        .filter((request) => !request.userJwt)
        .map((request) => `${request.label} (${request.credential})`);
      const summary =
        `${before.length} PostgREST requests before logout ` +
        `(${before.filter((request) => request.userJwt).length} with a user JWT); ` +
        `${after.length} after logout (${anonymousAfter.length} without a user JWT)`;
      testInfo.annotations.push({ type: 'rest-authorization', description: summary });
      console.log(`[rest-authorization] ${summary}`);
      expect(
        before.some((request) => request.userJwt),
        `the observer must see an authenticated PostgREST request before logout: ${summary}`,
      ).toBe(true);
      expect(
        anonymousAfter,
        `PostgREST requests without a user JWT after logout: ${summary}`,
      ).toEqual([]);
    },
    /**
     * Fails if any PostgREST request after the logout carried a JWT of the
     * account that left, even a well-formed one: a revoked session keeps a
     * valid signature until it expires, and some projections deliberately
     * ignore the revocation list. The observer proves the comparison is live:
     * at least one request before the logout must carry that account's JWT.
     * Only counts enter the annotation, the log and the failure message.
     */
    assertNoLeavingAccountRequestAfterLogout(testInfo: TestInfo) {
      expect(
        leavingAuthUserId,
        'markLogout must receive the Auth user id of the account that leaves',
      ).not.toBeNull();
      const before = observed.filter((request) => request.phase === 'before-logout');
      const after = observed.filter((request) => request.phase === 'after-logout');
      const leavingAfter = after
        .filter((request) => request.leavingAccountJwt)
        .map((request) => request.label);
      const summary =
        `${before.filter((request) => request.leavingAccountJwt).length} PostgREST requests ` +
        `before logout with the JWT of the account that left; ` +
        `${leavingAfter.length} of ${after.length} after logout`;
      testInfo.annotations.push({ type: 'rest-authorization-account', description: summary });
      console.log(`[rest-authorization-account] ${summary}`);
      expect(
        before.some((request) => request.leavingAccountJwt),
        `the observer must see the leaving account's JWT before logout: ${summary}`,
      ).toBe(true);
      expect(
        leavingAfter,
        `PostgREST requests with the JWT of the account that left, after logout: ${summary}`,
      ).toEqual([]);
    },
  };
}
