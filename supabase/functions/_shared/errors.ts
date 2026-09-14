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
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_EXPIRED',
  'IDEMPOTENCY_WAIT_TIMEOUT',
  'CONCURRENT_CHANGE',
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
  IDEMPOTENCY_CONFLICT:
    'This request_id was already used with a different input. Use a new request_id for a new intent.',
  IDEMPOTENCY_EXPIRED:
    'The replay payload for this request_id has expired. The original effect is not repeated.',
  IDEMPOTENCY_WAIT_TIMEOUT:
    'An identical request is still in flight and nothing was changed. Retryable: retry with the same request_id.',
  CONCURRENT_CHANGE: 'The state changed while the request was being applied. Retry.',
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
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'IDEMPOTENCY_CONFLICT':
    case 'DELETION_ALREADY_PENDING':
    case 'CONCURRENT_CHANGE':
      return 409;
    case 'IDEMPOTENCY_EXPIRED':
      return 410;
    case 'IDEMPOTENCY_WAIT_TIMEOUT':
      return 503;
    case 'INTERNAL':
      return 500;
    case 'VALIDATION':
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
