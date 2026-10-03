// Productive invitation dispatcher for the groups Edge gateway. The HTTP
// boundary injects a verified GoTrue actor, a narrow RPC caller and the same
// idempotency key provider used by existing group operations. No token, code,
// MAC or URL is sent to PostgreSQL or to an error response.
import { computeIdempotencyHmac } from './hmac.ts';
import type { KeyResolver } from './hmac.ts';
import { CANONICAL_VERSION, HASH_KEY_VERSION } from './gateway.ts';
import type { ActorContext } from './gateway.ts';
import {
  GatewayError,
  defaultMessage,
  fromDatabaseError,
  httpStatusFor,
  validation,
} from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { normaliseGroupName } from './group-name.ts';
export { normaliseGroupName } from './group-name.ts';
import {
  deriveInviteMaterial,
  inviteKeyV1,
  InviteMaterialError,
  lookupCodeDigest,
  makeInviteMaterial,
  normaliseInviteCode,
  parseInviteToken,
} from './invite-material.ts';

export const INVITE_OPERATIONS = [
  'create_group',
  'preview_group_by_code',
  'preview_group_by_invite',
  'get_my_pending_group_requests',
  'get_group_members',
  'join_by_code',
  'join_by_invite',
  'get_invite_share_link',
  'revoke_group_invite',
  'regenerate_group_invite',
  'issue_group_invite',
] as const;
export type InviteOperation = (typeof INVITE_OPERATIONS)[number];
export function isInviteOperation(value: string): value is InviteOperation {
  return (INVITE_OPERATIONS as readonly string[]).includes(value);
}

export function inviteShareUrl(
  baseValue: string | undefined,
  token: string,
  local: boolean,
): string {
  if (!baseValue) throw new Error('missing invite share URL base');
  const base = new URL(baseValue);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== 'https:' &&
      !(
        local &&
        base.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      )) ||
    (!local && base.pathname !== '/')
  ) {
    throw new Error('invalid invite share URL base');
  }
  if (!local) base.pathname = '/join';
  base.hash = `token=${token}`;
  return base.toString();
}

export interface InviteDependencies {
  readonly actor: ActorContext;
  readonly resolveKey: KeyResolver;
  readonly inviteKey: Uint8Array;
  readonly callRpc: (
    name: string,
    parameters: Record<string, unknown>,
  ) => Promise<{
    data?: unknown;
    error?: { message?: string | null; code?: string | null } | null;
  }>;
  readonly profileId: () => Promise<string>;
  readonly shareUrl: (token: string) => string;
}

interface Result {
  status: number;
  body: Record<string, unknown>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTERNAL_KEYS = new Set([
  'p_actor_auth_user_id',
  'p_actor_session_id',
  'p_input_hmac',
  'p_canonical_version',
  'p_hash_key_version',
  'p_nonce_hex',
  'p_token_digest',
  'p_code_digest',
  'profile_id',
  'actor_auth_user_id',
  'actor_session_id',
  'token_version',
]);
const MUTATIONS = new Set<InviteOperation>([
  'create_group',
  'join_by_code',
  'join_by_invite',
  'revoke_group_invite',
  'regenerate_group_invite',
  'issue_group_invite',
]);
const METERED = new Set<InviteOperation>([
  'preview_group_by_code',
  'preview_group_by_invite',
  'join_by_code',
  'join_by_invite',
]);

function record(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validation('body', 'must be an object');
  }
  return body as Record<string, unknown>;
}
function keys(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw validation(
        key,
        INTERNAL_KEYS.has(key) ? 'belongs to the internal call' : 'unknown key',
      );
    }
  }
}
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw validation(field, 'must be a canonical lowercase UUID');
  }
  return value;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw validation(field, 'must be a string');
  return value;
}
function response(code: ErrorCode, requestId: string, extra?: Record<string, unknown>): Result {
  return {
    status: httpStatusFor(code),
    body: {
      error: { code, message: defaultMessage(code), ...extra },
      request_id: requestId,
    },
  };
}
function failure(thrown: unknown, requestId: string): Result {
  if (thrown instanceof GatewayError)
    return response(
      thrown.code,
      requestId,
      thrown.fields === undefined ? undefined : { fields: thrown.fields },
    );
  return response('INTERNAL', requestId);
}
async function rpc(
  deps: InviteDependencies,
  name: string,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const result = await deps.callRpc(name, parameters);
  if (result.error !== undefined && result.error !== null) throw fromDatabaseError(result.error);
  return result.data;
}
function actorParameters(actor: ActorContext): Record<string, unknown> {
  return { p_actor_auth_user_id: actor.authUserId, p_actor_session_id: actor.sessionId };
}
async function fingerprint(
  deps: InviteDependencies,
  operation: InviteOperation,
  input: Record<string, unknown>,
  requestId: string,
): Promise<Record<string, unknown>> {
  return {
    ...actorParameters(deps.actor),
    p_request_id: requestId,
    p_input_hmac: await computeIdempotencyHmac(deps.resolveKey, HASH_KEY_VERSION, operation, input),
    p_canonical_version: CANONICAL_VERSION,
    p_hash_key_version: HASH_KEY_VERSION,
  };
}
function stringField(input: Record<string, unknown>, key: string): string {
  return text(input[key], key);
}
function lowerHex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export async function dispatchInvite(
  deps: InviteDependencies,
  operation: InviteOperation,
  body: unknown,
): Promise<Result> {
  let requestId = crypto.randomUUID();
  try {
    const input = record(body);
    // A valid client ID is safe to echo before quota and field validation.
    if (
      MUTATIONS.has(operation) &&
      typeof input['request_id'] === 'string' &&
      UUID.test(input['request_id'])
    ) {
      requestId = input['request_id'];
    }
    const allowed: Record<InviteOperation, string[]> = {
      create_group: ['name', 'request_id'],
      preview_group_by_code: ['code'],
      preview_group_by_invite: ['token'],
      get_my_pending_group_requests: [],
      get_group_members: ['group_id'],
      join_by_code: ['code', 'request_id'],
      join_by_invite: ['token', 'request_id'],
      get_invite_share_link: ['invite_id'],
      revoke_group_invite: ['invite_id', 'request_id'],
      regenerate_group_invite: ['invite_id', 'request_id'],
      issue_group_invite: ['group_id', 'request_id'],
    };
    if (!METERED.has(operation)) {
      keys(input, allowed[operation]);
      if (MUTATIONS.has(operation)) requestId = uuid(input['request_id'], 'request_id');
    }
    if (METERED.has(operation)) {
      // Resolve via the caller's JWT, then the RPC compares that ID against
      // the verified actor context before inserting any row.
      let profileId: string;
      try {
        profileId = await deps.profileId();
      } catch (error) {
        if (error instanceof GatewayError && error.code !== 'INTERNAL') throw error;
        return response('RATE_LIMIT_UNAVAILABLE', requestId);
      }
      let admission: {
        allowed: boolean;
        attempt_id: string;
        retry_after: number | null;
        available_at: string | null;
      };
      try {
        admission = (await rpc(deps, 'check_and_debit_invite_attempt', {
          ...actorParameters(deps.actor),
          profile_id: profileId,
        })) as typeof admission;
      } catch (error) {
        if (error instanceof GatewayError && error.code !== 'INTERNAL') throw error;
        return response('RATE_LIMIT_UNAVAILABLE', requestId);
      }
      if (!admission || typeof admission.allowed !== 'boolean') {
        return response('RATE_LIMIT_UNAVAILABLE', requestId);
      }
      if (!admission.allowed) {
        return response('RATE_LIMITED', requestId, {
          retry_after: admission.retry_after,
          available_at: admission.available_at,
        });
      }
      let data: unknown;
      try {
        keys(input, allowed[operation]);
        if (MUTATIONS.has(operation)) requestId = uuid(input['request_id'], 'request_id');
        if (operation === 'preview_group_by_code' || operation === 'join_by_code') {
          const code = normaliseInviteCode(stringField(input, 'code'));
          const codeDigest = await lookupCodeDigest(deps.inviteKey, code);
          const params = { ...actorParameters(deps.actor), p_code_digest: codeDigest };
          data =
            operation === 'join_by_code'
              ? await rpc(deps, operation, {
                  ...(await fingerprint(deps, operation, { code }, requestId)),
                  p_code_digest: codeDigest,
                })
              : await rpc(deps, operation, params);
        } else {
          const parsed = await parseInviteToken(deps.inviteKey, stringField(input, 'token'));
          const params = {
            ...actorParameters(deps.actor),
            p_invite_id: parsed.inviteId,
            p_token_version: parsed.tokenVersion,
            p_token_digest: parsed.tokenDigest,
          };
          data =
            operation === 'join_by_invite'
              ? await rpc(deps, operation, {
                  ...(await fingerprint(
                    deps,
                    operation,
                    { token: stringField(input, 'token') },
                    requestId,
                  )),
                  ...params,
                })
              : await rpc(deps, operation, params);
        }
      } catch (error) {
        // A malformed token/code is indistinguishable from an unknown one.
        if (error instanceof InviteMaterialError) return response('CODE_INVALID', requestId);
        throw error;
      }
      // Failure of this accounting mark conservatively keeps a failure row.
      try {
        await rpc(deps, 'mark_invite_attempt_success', {
          ...actorParameters(deps.actor),
          attempt_id: admission.attempt_id,
        });
      } catch {
        /* Domain success is not executed a second time. */
      }
      return { status: 200, body: { data, request_id: requestId } };
    }
    if (operation === 'get_group_members') {
      const data = await rpc(deps, operation, {
        ...actorParameters(deps.actor),
        p_group_id: uuid(input['group_id'], 'group_id'),
      });
      return { status: 200, body: { data, request_id: requestId } };
    }
    if (operation === 'get_my_pending_group_requests') {
      const data = await rpc(deps, operation, actorParameters(deps.actor));
      return { status: 200, body: { data, request_id: requestId } };
    }
    if (operation === 'get_invite_share_link') {
      const inviteId = uuid(input['invite_id'], 'invite_id');
      const raw = (await rpc(deps, operation, {
        ...actorParameters(deps.actor),
        p_invite_id: inviteId,
      })) as Record<string, unknown>;
      const nonce = String(raw['nonce_hex'] ?? '');
      if (!/^[0-9a-f]{32}$/.test(nonce) || raw['token_version'] !== 1) {
        throw new Error('invalid material');
      }
      const material = await deriveInviteMaterial(
        deps.inviteKey,
        inviteId,
        Uint8Array.from(nonce.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)),
      );
      if (
        !lowerHex(String(raw['token_digest'])) ||
        !lowerHex(String(raw['code_digest'])) ||
        material.tokenDigest !== raw['token_digest'] ||
        material.codeDigest !== raw['code_digest']
      ) {
        throw new Error('material digest mismatch');
      }
      const data = {
        invite_id: inviteId,
        expires_at: raw['expires_at'],
        remaining_uses: raw['remaining_uses'],
        share_url: deps.shareUrl(material.token),
        code: material.code,
        code_format: 'v1',
      };
      return { status: 200, body: { data, request_id: requestId } };
    }
    let canonicalInput: Record<string, unknown>;
    let extras: Record<string, unknown> = {};
    switch (operation) {
      case 'create_group': {
        const name = normaliseGroupName(input['name']);
        canonicalInput = { name };
        const material = await makeInviteMaterial(deps.inviteKey);
        extras = {
          p_name: name,
          p_invite_id: material.inviteId,
          p_token_version: material.tokenVersion,
          p_nonce_hex: material.nonceHex,
          p_token_digest: material.tokenDigest,
          p_code_digest: material.codeDigest,
        };
        break;
      }
      case 'revoke_group_invite': {
        const inviteId = uuid(input['invite_id'], 'invite_id');
        canonicalInput = { invite_id: inviteId };
        extras = { p_invite_id: inviteId };
        break;
      }
      case 'regenerate_group_invite': {
        const inviteId = uuid(input['invite_id'], 'invite_id');
        canonicalInput = { invite_id: inviteId };
        const material = await makeInviteMaterial(deps.inviteKey, inviteId);
        extras = {
          p_invite_id: inviteId,
          p_token_version: material.tokenVersion,
          p_nonce_hex: material.nonceHex,
          p_token_digest: material.tokenDigest,
          p_code_digest: material.codeDigest,
        };
        break;
      }
      case 'issue_group_invite': {
        const groupId = uuid(input['group_id'], 'group_id');
        canonicalInput = { group_id: groupId };
        const material = await makeInviteMaterial(deps.inviteKey);
        extras = {
          p_group_id: groupId,
          p_new_invite_id: material.inviteId,
          p_token_version: material.tokenVersion,
          p_nonce_hex: material.nonceHex,
          p_token_digest: material.tokenDigest,
          p_code_digest: material.codeDigest,
        };
        break;
      }
      default:
        throw new Error('unreachable operation');
    }
    const identity = await fingerprint(deps, operation, canonicalInput, requestId);
    for (let collision = 0; collision < 3; collision += 1) {
      const result = await deps.callRpc(operation, { ...identity, ...extras });
      if (result.error === undefined || result.error === null) {
        return { status: 200, body: { data: result.data, request_id: requestId } };
      }
      const isCodeCollision =
        result.error.code === '23505' &&
        (result.error.message ?? '').includes('group_invites_code_digest_key');
      if (!isCodeCollision || collision === 2 || operation === 'revoke_group_invite') {
        throw fromDatabaseError(result.error);
      }
      // The unique(code_digest) constraint is the collision arbiter. Its
      // failed transaction committed no invitation or idempotency outcome.
      const inviteId =
        operation === 'regenerate_group_invite' ? String(extras['p_invite_id']) : undefined;
      const replacement = await makeInviteMaterial(deps.inviteKey, inviteId);
      extras = {
        ...extras,
        ...(operation === 'create_group'
          ? { p_invite_id: replacement.inviteId }
          : operation === 'issue_group_invite'
            ? { p_new_invite_id: replacement.inviteId }
            : {}),
        p_nonce_hex: replacement.nonceHex,
        p_token_digest: replacement.tokenDigest,
        p_code_digest: replacement.codeDigest,
      };
    }
    throw new Error('unreachable collision limit');
  } catch (error) {
    return failure(error, requestId);
  }
}

export function inviteKeyFromEnvironment(read: (name: string) => string | undefined): Uint8Array {
  return inviteKeyV1(read('INVITE_HMAC_KEY_V1'));
}
