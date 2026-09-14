// The request path, with its dependencies injected so that everything except
// the network can be exercised without one.
//
// Order matters here. The external body is validated and normalised first, then
// canonicalised, then the HMAC is computed, and only then is the narrow RPC
// called. Nothing reaches the database until the shape is known to be right,
// which is what keeps a malformed request from spending an idempotency key.

import { GatewayError, fromDatabaseError, defaultMessage } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { computeIdempotencyHmac } from './hmac.ts';
import type { KeyResolver } from './hmac.ts';
import { normaliseRequest } from './operations.ts';
import type { Operation } from './operations.ts';

// docs/13 section 0.1. Both are persisted, and both are sent explicitly rather
// than defaulted inside the database, so that a future version is a change here
// and not a silent reinterpretation of old rows.
export const CANONICAL_VERSION = 1;
export const HASH_KEY_VERSION = 1;

export interface ActorContext {
  /** From the verified claims. Never from the body. */
  readonly authUserId: string;
  /** The session_id claim of the same verified token. */
  readonly sessionId: string;
}

export interface RpcFailure {
  readonly message?: string | null;
}

export type RpcCaller = (
  functionName: Operation,
  params: Record<string, unknown>,
) => Promise<{ data?: unknown; error?: RpcFailure | null }>;

export interface GatewayDependencies {
  readonly resolveKey: KeyResolver;
  readonly callRpc: RpcCaller;
}

export type GatewayResult =
  | { readonly status: number; readonly body: { data: unknown; request_id: string } }
  | {
      readonly status: number;
      readonly body: {
        error: { code: ErrorCode; message: string; fields?: Record<string, string> };
        request_id: string;
      };
    };

import { httpStatusFor } from './errors.ts';

function errorResult(error: GatewayError, requestId: string): GatewayResult {
  const body: {
    error: { code: ErrorCode; message: string; fields?: Record<string, string> };
    request_id: string;
  } = {
    error: { code: error.code, message: error.message },
    request_id: requestId,
  };
  if (error.fields !== undefined) {
    body.error.fields = error.fields;
  }
  return { status: httpStatusFor(error.code), body };
}

/**
 * The internal call of docs/13 section 0.1: normalised input, request_id, the
 * actor taken from verified claims, the HMAC and its key version. The client
 * never supplies any of the last three.
 */
function rpcParameters(
  operation: Operation,
  requestId: string,
  actor: ActorContext,
  canonicalInput: Record<string, unknown>,
  inputHmac: string,
): Record<string, unknown> {
  const common = {
    p_actor_auth_user_id: actor.authUserId,
    p_actor_session_id: actor.sessionId,
    p_request_id: requestId,
    p_input_hmac: inputHmac,
    p_canonical_version: CANONICAL_VERSION,
    p_hash_key_version: HASH_KEY_VERSION,
  };

  switch (operation) {
    case 'complete_profile':
      return { ...common, p_profile: canonicalInput['profile'] };
    case 'update_profile':
      return { ...common, p_patch: canonicalInput['patch'] };
    case 'accept_policies':
      return { ...common, p_versions: canonicalInput['versions'] };
    case 'revoke_current_session':
    case 'delete_account':
      return common;
  }
}

/**
 * Runs one mutation. `requestIdHint` is only used to echo a request_id back on
 * a body so malformed that normalisation never recovered one.
 */
export async function runOperation(
  dependencies: GatewayDependencies,
  operation: Operation,
  body: unknown,
  actor: ActorContext,
  requestIdHint = '',
): Promise<GatewayResult> {
  let requestId = requestIdHint;
  try {
    const normalised = normaliseRequest(operation, body);
    requestId = normalised.requestId;

    const inputHmac = await computeIdempotencyHmac(
      dependencies.resolveKey,
      HASH_KEY_VERSION,
      operation,
      normalised.canonicalInput,
    );

    const { data, error } = await dependencies.callRpc(
      operation,
      rpcParameters(operation, requestId, actor, normalised.canonicalInput, inputHmac),
    );

    if (error !== undefined && error !== null) {
      return errorResult(fromDatabaseError(error), requestId);
    }
    return { status: 200, body: { data, request_id: requestId } };
  } catch (thrown) {
    if (thrown instanceof GatewayError) {
      return errorResult(thrown, requestId);
    }
    // Anything else — a missing key, a canonicalisation refusal, a transport
    // failure — collapses to INTERNAL. The original message may name the input
    // or the key, and neither is allowed to travel outward.
    return errorResult(new GatewayError('INTERNAL', defaultMessage('INTERNAL')), requestId);
  }
}

/** Reads request_id from an unvalidated body, only to echo it on a refusal. */
export function requestIdHintFrom(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return '';
  const value = (body as Record<string, unknown>)['request_id'];
  return typeof value === 'string' ? value : '';
}

export { GatewayError };
