// The stable error catalogue of docs/13-contratos-funcoes.md section 8 and the
// Result envelope of section 0. A code that is not in this list cannot leave
// the gateway: an unmapped database failure becomes a generic VALIDATION or
// UNAUTHENTICATED here rather than leaking a message nobody vetted.

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION',
  'PROFILE_SUSPENDED',
  'DELETION_ALREADY_PENDING',
  'FINANCIAL_SUBSTITUTE_REQUIRED',
  'EXPORT_ALREADY_PENDING',
  'EXPORT_EXPIRED',
  'RECENT_REAUTH_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_EXPIRED',
  'IDEMPOTENCY_WAIT_TIMEOUT',
  'CONCURRENT_CHANGE',
  // Group membership, roles and ownership (docs/13 sections 0.1, 5 and 8).
  'NOT_MEMBER',
  'NOT_ORGANIZER',
  'OWNER_ONLY',
  'NOT_ACTIVE_MEMBER',
  'MEMBERSHIP_ALREADY_DECIDED',
  'GROUP_LIMIT',
  'GROUP_FULL',
  'GROUP_ARCHIVED',
  'GROUP_SUSPENDED',
  'IS_OWNER',
  'PROOFS_PENDING',
  'MONTHLY_DISABLED',
  'VISIBILITY_CONFIRMATION_REQUIRED',
  'OWNER_MUST_TRANSFER',
  'CODE_INVALID',
  'INVITE_REVOKED',
  'INVITE_EXPIRED',
  'INVITE_USED',
  'INVITE_ALREADY_ACTIVE',
  'RATE_LIMITED',
  'RATE_LIMIT_UNAVAILABLE',
  // Rachas v1 (docs/13 section 3.1, cut by docs/25 section 8.1).
  'TIME_ORDER',
  'PRICE_INVALID',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: string): value is ErrorCode {
  return CODE_SET.has(value);
}

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly fields: Record<string, string> | undefined;

  constructor(code: ErrorCode, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.fields = fields;
  }
}

/** Rejects an external field by name. The value is never echoed back. */
export function validation(field: string, reason: string): GatewayError {
  return new GatewayError('VALIDATION', 'The request did not pass validation.', {
    [field]: reason,
  });
}

// docs/13 section 0, rule 2: the wait timeout is retryable and the retry keeps
// the same request_id. The Result envelope of section 0 has no boolean for
// that, so it is stated in the message rather than invented as a new field.
const MESSAGES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'The session is missing, unusable or revoked. Sign in again.',
  FORBIDDEN: 'This account no longer has authority over the operation.',
  NOT_FOUND: 'The subject of the operation does not exist.',
  VALIDATION: 'The request did not pass validation.',
  PROFILE_SUSPENDED: 'A suspended account cannot mutate the domain.',
  DELETION_ALREADY_PENDING: 'Account deletion is already pending.',
  FINANCIAL_SUBSTITUTE_REQUIRED:
    'Account deletion requires a financial substitute before it can continue.',
  EXPORT_ALREADY_PENDING: 'A data export is already being prepared or awaiting cleanup.',
  EXPORT_EXPIRED: 'This data export is expired or has already been consumed.',
  RECENT_REAUTH_REQUIRED: 'Authenticate again before downloading this data export.',
  IDEMPOTENCY_CONFLICT:
    'This request_id was already used with a different input. Use a new request_id for a new intent.',
  IDEMPOTENCY_EXPIRED:
    'The replay payload for this request_id has expired. The original effect is not repeated.',
  IDEMPOTENCY_WAIT_TIMEOUT:
    'An identical request is still in flight and nothing was changed. Retryable: retry with the same request_id.',
  CONCURRENT_CHANGE: 'The state changed while the request was being applied. Retry.',
  NOT_MEMBER: 'This account is not an active member of the group.',
  NOT_ORGANIZER: 'Only the owner or an organizer of the group can do this.',
  OWNER_ONLY: 'Only the owner of the group can do this.',
  NOT_ACTIVE_MEMBER: 'The target is not an active member of the group.',
  MEMBERSHIP_ALREADY_DECIDED: 'This membership request was already decided.',
  GROUP_LIMIT: 'The profile already has the maximum number of active groups.',
  GROUP_FULL: 'The group has no free place.',
  GROUP_ARCHIVED: 'The group is archived.',
  GROUP_SUSPENDED: 'The group is suspended and does not accept this change.',
  IS_OWNER: 'The owner of the group cannot be removed.',
  PROOFS_PENDING: 'Payment proofs under review must be decided first.',
  MONTHLY_DISABLED: 'The group does not use monthly members.',
  VISIBILITY_CONFIRMATION_REQUIRED: 'Showing ratings to members requires an explicit confirmation.',
  OWNER_MUST_TRANSFER: 'The owner must transfer the group before leaving it.',
  CODE_INVALID: 'The invitation code or link is invalid.',
  INVITE_REVOKED: 'This invitation was revoked.',
  INVITE_EXPIRED: 'This invitation expired.',
  INVITE_USED: 'This invitation has no uses left.',
  INVITE_ALREADY_ACTIVE: 'The group already has an active invitation.',
  RATE_LIMITED: 'Too many invitation attempts. Wait before trying again.',
  RATE_LIMIT_UNAVAILABLE: 'Invitation attempts cannot be counted right now.',
  TIME_ORDER: 'The match times are out of order or outside the allowed window.',
  PRICE_INVALID: 'The price per player must be greater than zero.',
  INTERNAL: 'The request could not be completed.',
};

export function defaultMessage(code: ErrorCode): string {
  return MESSAGES[code];
}

/** Codes a client may retry unchanged, keeping the same request_id. */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'IDEMPOTENCY_WAIT_TIMEOUT',
  'CONCURRENT_CHANGE',
]);

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
    case 'PROFILE_SUSPENDED':
    case 'FINANCIAL_SUBSTITUTE_REQUIRED':
    case 'RECENT_REAUTH_REQUIRED':
    case 'NOT_MEMBER':
    case 'NOT_ORGANIZER':
    case 'OWNER_ONLY':
    case 'GROUP_SUSPENDED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'IDEMPOTENCY_CONFLICT':
    case 'DELETION_ALREADY_PENDING':
    case 'EXPORT_ALREADY_PENDING':
    case 'CONCURRENT_CHANGE':
    case 'NOT_ACTIVE_MEMBER':
    case 'MEMBERSHIP_ALREADY_DECIDED':
    case 'GROUP_LIMIT':
    case 'GROUP_FULL':
    case 'IS_OWNER':
    case 'PROOFS_PENDING':
    case 'MONTHLY_DISABLED':
    case 'OWNER_MUST_TRANSFER':
    case 'INVITE_REVOKED':
    case 'INVITE_EXPIRED':
    case 'INVITE_USED':
    case 'INVITE_ALREADY_ACTIVE':
      return 409;
    case 'IDEMPOTENCY_EXPIRED':
    case 'EXPORT_EXPIRED':
    case 'GROUP_ARCHIVED':
      return 410;
    case 'IDEMPOTENCY_WAIT_TIMEOUT':
    case 'RATE_LIMIT_UNAVAILABLE':
      return 503;
    case 'RATE_LIMITED':
      return 429;
    case 'CODE_INVALID':
      return 400;
    case 'INTERNAL':
      return 500;
    case 'VALIDATION':
    case 'VISIBILITY_CONFIRMATION_REQUIRED':
    case 'TIME_ORDER':
    case 'PRICE_INVALID':
      return 422;
  }
}

/**
 * Maps a PostgREST failure onto the catalogue. The RPCs raise with the stable
 * code as the message, so the message is the mapping; anything unrecognised
 * collapses to INTERNAL instead of travelling outward as-is.
 */
export function fromDatabaseError(raw: { message?: string | null }): GatewayError {
  const message = (raw.message ?? '').trim();
  if (isErrorCode(message)) {
    return new GatewayError(message, defaultMessage(message));
  }
  return new GatewayError('INTERNAL', defaultMessage('INTERNAL'));
}
