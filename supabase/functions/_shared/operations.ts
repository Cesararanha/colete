// One normalising schema per operation, per docs/13-contratos-funcoes.md
// section 0.1. Each rejects unknown keys, preserves absence versus null,
// normalises strings to NFC, and orders set-like arrays the way the schema
// says, so that a client which reorders them still produces one canonical form.
//
// The field rules of sections 5.6 and 5.7 are applied here and again inside the
// RPC. That duplication is deliberate: the Edge refuses bad input before it
// spends an idempotency key, and the database refuses it again because the
// Edge is not the authority on domain rules.

import { GatewayError, validation } from './errors.ts';
import { normaliseGroupName } from './group-name.ts';
import { normaliseMatchConfig } from './match-config.ts';

export const IDENTITY_OPERATIONS = [
  'complete_profile',
  'update_profile',
  'accept_policies',
  'revoke_current_session',
  'delete_account',
  'request_data_export',
] as const;

// docs/13 section 5, delivered by docs/25 section 4. create_group belongs to
// the invite slice and is not here. create_match is the Rachas v1 cut of
// docs/13 section 3.1 (docs/25 section 8.1); join_match, leave_match and
// set_match_payment are the Racha completo cut of sections 1.1, 1.2 and 2.6.
// set_group_appearance is section 5.0.7, the owner's icon and colour (0027).
// update_match and cancel_match are the presentation cut of sections 3.2 and
// 3.3 (0028, human decision of 18/10/2026).
export const GROUP_OPERATIONS = [
  'approve_member',
  'remove_member',
  'set_role',
  'set_monthly',
  'set_ratings_visibility',
  'transfer_ownership',
  'leave_group',
  'rename_group',
  'set_group_appearance',
  'create_match',
  'join_match',
  'leave_match',
  'set_match_payment',
  'update_match',
  'cancel_match',
] as const;

export const OPERATIONS = [...IDENTITY_OPERATIONS, ...GROUP_OPERATIONS] as const;

export type Operation = (typeof OPERATIONS)[number];

export function isOperation(value: string): value is Operation {
  return (OPERATIONS as readonly string[]).includes(value);
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const POSITIONS = ['goalkeeper', 'defender', 'midfielder', 'forward'];
const FEET = ['left', 'right', 'both'];
const DOCUMENT_TYPES = ['terms', 'privacy'];
const VERSION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROLES = ['organizer', 'player'];
const VISIBILITIES = ['private', 'members'];
// docs/13 section 5.0.7: the keys the database stores, never the labels.
export const GROUP_ICONS = [
  'ball',
  'goal',
  'field',
  'whistle',
  'shirt',
  'trophy',
  'bolt',
  'flame',
] as const;
export const GROUP_COLORS = ['blue', 'green', 'orange', 'pink', 'lilac', 'sand'] as const;

// Names that belong only to the internal call. Seeing one in an external body
// is not a stray key, it is a client trying to supply its own actor or its own
// HMAC, so it is named explicitly rather than folded into "unknown key". The
// one exception is a profile_id that the operation's signature enumerates as
// the target of the action (docs/13 section 0, rule 7): there it is a business
// field, never the caller.
const INTERNAL_ONLY = [
  'input_hmac',
  'hash_key_version',
  'canonical_version',
  'auth_user_id',
  'actor_auth_user_id',
  'profile_id',
  'session_id',
  'actor_session_id',
  'actor_key',
];

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validation(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(record)) {
    if (INTERNAL_ONLY.includes(key) && !allowed.includes(key)) {
      throw validation(
        field === '' ? key : `${field}.${key}`,
        'belongs to the internal call and is never accepted from a client',
      );
    }
    if (!allowed.includes(key)) {
      throw validation(field === '' ? key : `${field}.${key}`, 'unknown key');
    }
  }
}

function normaliseText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw validation(field, 'must be a string');
  // NFC first, then trim, so that a combining sequence is measured after it is
  // composed rather than before.
  return value.normalize('NFC').replace(/^[\s]+|[\s]+$/gu, '');
}

function requiredName(value: unknown, field: string): string {
  const text = normaliseText(value, field);
  if (text.length < 2 || text.length > 80) {
    throw validation(field, 'must be between 2 and 80 characters after trimming');
  }
  return text;
}

/**
 * An optional text field has exactly two spellings: a non-empty value, or an
 * explicit null that clears it. A blank string is an error, never a silent
 * null, because two spellings of one state is how comparison bugs are born.
 */
function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null) return null;
  const text = normaliseText(value, field);
  if (text.length < 1 || text.length > max) {
    throw validation(field, `must be between 1 and ${max} characters, or null`);
  }
  return text;
}

function optionalEnum(value: unknown, field: string, allowed: readonly string[]): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw validation(field, `must be one of ${allowed.join(', ')}, or null`);
  }
  return value;
}

function optionalShirtNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw validation(field, 'must be an integer between 0 and 99, or null');
  }
  if (!Number.isInteger(value) || value < 0 || value > 99) {
    throw validation(field, 'must be an integer between 0 and 99, or null');
  }
  return value;
}

/** A business UUID: normalised to lowercase, then held to the canonical shape. */
function requiredUuid(value: unknown, field: string): string {
  if (typeof value !== 'string') throw validation(field, 'must be a UUID string');
  const lower = value.toLowerCase();
  if (!CANONICAL_UUID.test(lower)) throw validation(field, 'must be a canonical UUID');
  return lower;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw validation(field, 'must be a boolean');
  return value;
}

function requiredEnum(value: unknown, field: string, allowed: readonly string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw validation(field, `must be one of ${allowed.join(', ')}`);
  }
  return value;
}

// docs/25 M2-D18: the removal reason is required, non-empty after trimming and
// at most 500 characters, by the precedent of the private note of docs/13
// section 3.3. It feeds the HMAC and the RPC only; it is never persisted,
// logged or echoed, including in the validation message below.
function requiredReason(value: unknown, field: string): string {
  const text = normaliseText(value, field);
  if (text.length < 1 || [...text].length > 500) {
    throw validation(field, 'must be between 1 and 500 characters after trimming');
  }
  return text;
}

const PROFILE_FIELDS = ['name', 'nickname', 'position', 'dominant_foot', 'shirt_number'] as const;

/**
 * The writable allowlist of docs/13 section 5.6, shared by both profile
 * operations. `requireName` is what section 5.7 adds on top of it.
 */
function normaliseProfileFields(
  raw: Record<string, unknown>,
  field: string,
  requireName: boolean,
): Record<string, unknown> {
  rejectUnknownKeys(raw, PROFILE_FIELDS, field);

  if (requireName && !Object.hasOwn(raw, 'name')) {
    throw validation(`${field}.name`, 'is required');
  }

  const out: Record<string, unknown> = {};
  // Absence is preserved by only writing keys the caller actually sent.
  if (Object.hasOwn(raw, 'name')) {
    if (raw['name'] === null) throw validation(`${field}.name`, 'cannot be null');
    out['name'] = requiredName(raw['name'], `${field}.name`);
  }
  if (Object.hasOwn(raw, 'nickname')) {
    out['nickname'] = optionalText(raw['nickname'], `${field}.nickname`, 30);
  }
  if (Object.hasOwn(raw, 'position')) {
    out['position'] = optionalEnum(raw['position'], `${field}.position`, POSITIONS);
  }
  if (Object.hasOwn(raw, 'dominant_foot')) {
    out['dominant_foot'] = optionalEnum(raw['dominant_foot'], `${field}.dominant_foot`, FEET);
  }
  if (Object.hasOwn(raw, 'shirt_number')) {
    out['shirt_number'] = optionalShirtNumber(raw['shirt_number'], `${field}.shirt_number`);
  }
  return out;
}

function normaliseVersions(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) throw validation('versions', 'must be an array');
  if (value.length < 1 || value.length > 2) {
    throw validation('versions', 'must hold one or two entries');
  }

  const entries = value.map((item, index) => {
    const record = asRecord(item, `versions[${index}]`);
    rejectUnknownKeys(record, ['document_type', 'version'], `versions[${index}]`);
    const documentType = record['document_type'];
    const version = record['version'];
    if (typeof documentType !== 'string' || !DOCUMENT_TYPES.includes(documentType)) {
      throw validation(`versions[${index}].document_type`, 'must be terms or privacy');
    }
    if (typeof version !== 'string' || !VERSION_SHAPE.test(version)) {
      throw validation(`versions[${index}].version`, 'is not a version identifier');
    }
    return { document_type: documentType, version };
  });

  // Set-like: the schema orders it, so a client that sends the pair in either
  // order produces the same canonical input and therefore the same HMAC.
  entries.sort((a, b) => {
    if (a.document_type !== b.document_type) {
      return a.document_type < b.document_type ? -1 : 1;
    }
    if (a.version === b.version) return 0;
    return a.version < b.version ? -1 : 1;
  });

  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.document_type === current.document_type &&
      previous.version === current.version
    ) {
      throw validation('versions', 'must not repeat a document type and version');
    }
  }
  return entries;
}

export interface NormalisedRequest {
  readonly operation: Operation;
  readonly requestId: string;
  /** The canonical input: the business arguments, never request_id. */
  readonly canonicalInput: Record<string, unknown>;
}

/**
 * Validates and normalises an external body. The canonical input is an object
 * keyed by the operation's business argument names, which is the shape the
 * published golden vector of docs/13 section 0.1 uses, and it never carries
 * request_id or any actor context.
 */
export function normaliseRequest(operation: Operation, body: unknown): NormalisedRequest {
  const record = asRecord(body, '');

  const bodyKeys: Record<Operation, readonly string[]> = {
    complete_profile: ['request_id', 'profile'],
    update_profile: ['request_id', 'patch'],
    accept_policies: ['request_id', 'versions'],
    revoke_current_session: ['request_id'],
    delete_account: ['request_id'],
    request_data_export: ['request_id'],
    approve_member: ['request_id', 'group_id', 'profile_id', 'approve'],
    remove_member: ['request_id', 'group_id', 'profile_id', 'reason'],
    set_role: ['request_id', 'group_id', 'profile_id', 'role'],
    set_monthly: ['request_id', 'group_id', 'profile_id', 'enabled'],
    set_ratings_visibility: ['request_id', 'group_id', 'visibility', 'confirm_members_visibility'],
    transfer_ownership: ['request_id', 'group_id', 'new_owner_id'],
    leave_group: ['request_id', 'group_id'],
    rename_group: ['request_id', 'group_id', 'name'],
    set_group_appearance: ['request_id', 'group_id', 'icon', 'color'],
    create_match: ['request_id', 'group_id', 'config'],
    join_match: ['request_id', 'match_id'],
    leave_match: ['request_id', 'match_id'],
    set_match_payment: ['request_id', 'match_id', 'profile_id', 'paid'],
    update_match: ['request_id', 'match_id', 'config'],
    cancel_match: ['request_id', 'match_id'],
  };
  rejectUnknownKeys(record, bodyKeys[operation], '');

  const requestId = record['request_id'];
  if (typeof requestId !== 'string' || !CANONICAL_UUID.test(requestId)) {
    throw validation('request_id', 'must be a canonical lowercase UUID');
  }

  switch (operation) {
    case 'complete_profile': {
      if (!Object.hasOwn(record, 'profile')) {
        throw validation('profile', 'is required');
      }
      const profile = normaliseProfileFields(
        asRecord(record['profile'], 'profile'),
        'profile',
        true,
      );
      return { operation, requestId, canonicalInput: { profile } };
    }
    case 'update_profile': {
      if (!Object.hasOwn(record, 'patch')) {
        throw validation('patch', 'is required');
      }
      const patch = normaliseProfileFields(asRecord(record['patch'], 'patch'), 'patch', false);
      return { operation, requestId, canonicalInput: { patch } };
    }
    case 'accept_policies': {
      if (!Object.hasOwn(record, 'versions')) {
        throw validation('versions', 'is required');
      }
      const versions = normaliseVersions(record['versions']);
      return { operation, requestId, canonicalInput: { versions } };
    }
    case 'revoke_current_session': {
      // docs/13 section 5.5: the canonical input is the empty object. The actor
      // comes from the verified claims and never from the body.
      return { operation, requestId, canonicalInput: {} };
    }
    case 'delete_account': {
      // docs/22 section 4: deletion has no client-supplied business fields.
      // The authenticated actor and session are derived from verified claims.
      return { operation, requestId, canonicalInput: {} };
    }
    case 'request_data_export': {
      return { operation, requestId, canonicalInput: {} };
    }
    // docs/13 section 5. Every business field of these signatures is
    // required: absence is refused, never defaulted.
    case 'approve_member':
      return {
        operation,
        requestId,
        canonicalInput: {
          group_id: requiredUuid(record['group_id'], 'group_id'),
          profile_id: requiredUuid(record['profile_id'], 'profile_id'),
          approve: requiredBoolean(record['approve'], 'approve'),
        },
      };
    case 'remove_member':
      return {
        operation,
        requestId,
        canonicalInput: {
          group_id: requiredUuid(record['group_id'], 'group_id'),
          profile_id: requiredUuid(record['profile_id'], 'profile_id'),
          reason: requiredReason(record['reason'], 'reason'),
        },
      };
    case 'set_role':
      return {
        operation,
        requestId,
        canonicalInput: {
          group_id: requiredUuid(record['group_id'], 'group_id'),
          profile_id: requiredUuid(record['profile_id'], 'profile_id'),
          role: requiredEnum(record['role'], 'role', ROLES),
        },
      };
    case 'set_monthly':
      return {
        operation,
        requestId,
        canonicalInput: {
          group_id: requiredUuid(record['group_id'], 'group_id'),
          profile_id: requiredUuid(record['profile_id'], 'profile_id'),
          enabled: requiredBoolean(record['enabled'], 'enabled'),
        },
      };
    case 'set_ratings_visibility':
      return {
        operation,
        requestId,
        canonicalInput: {
          group_id: requiredUuid(record['group_id'], 'group_id'),
          visibility: requiredEnum(record['visibility'], 'visibility', VISIBILITIES),
          confirm_members_visibility: requiredBoolean(
            record['confirm_members_visibility'],
            'confirm_members_visibility',
          ),
        },
      };
    case 'transfer_ownership':
      return {
        operation,
        requestId,
        canonicalInput: {
          group_id: requiredUuid(record['group_id'], 'group_id'),
          new_owner_id: requiredUuid(record['new_owner_id'], 'new_owner_id'),
        },
      };
    case 'leave_group':
      return {
        operation,
        requestId,
        canonicalInput: { group_id: requiredUuid(record['group_id'], 'group_id') },
      };
    case 'rename_group':
      return {
        operation,
        requestId,
        canonicalInput: {
          group_id: requiredUuid(record['group_id'], 'group_id'),
          name: normaliseGroupName(record['name']),
        },
      };
    case 'set_group_appearance':
      return {
        operation,
        requestId,
        canonicalInput: {
          group_id: requiredUuid(record['group_id'], 'group_id'),
          icon: requiredEnum(record['icon'], 'icon', GROUP_ICONS),
          color: requiredEnum(record['color'], 'color', GROUP_COLORS),
        },
      };
    case 'create_match': {
      if (!Object.hasOwn(record, 'config')) throw validation('config', 'is required');
      return {
        operation,
        requestId,
        canonicalInput: {
          group_id: requiredUuid(record['group_id'], 'group_id'),
          config: { ...normaliseMatchConfig(record['config']) },
        },
      };
    }
    // The whole form, with the ten keys of create_match. Whether the start may
    // be in the past depends on the stored match (an unchanged start keeps a
    // match in progress editable), so only the database applies that rule.
    case 'update_match': {
      if (!Object.hasOwn(record, 'config')) throw validation('config', 'is required');
      return {
        operation,
        requestId,
        canonicalInput: {
          match_id: requiredUuid(record['match_id'], 'match_id'),
          config: { ...normaliseMatchConfig(record['config'], new Date(), { futureStart: false }) },
        },
      };
    }
    case 'join_match':
    case 'leave_match':
    case 'cancel_match':
      return {
        operation,
        requestId,
        canonicalInput: { match_id: requiredUuid(record['match_id'], 'match_id') },
      };
    // The target is the confirmed player whose payment the organiser marks;
    // the actor still comes only from the verified claims.
    case 'set_match_payment':
      return {
        operation,
        requestId,
        canonicalInput: {
          match_id: requiredUuid(record['match_id'], 'match_id'),
          profile_id: requiredUuid(record['profile_id'], 'profile_id'),
          paid: requiredBoolean(record['paid'], 'paid'),
        },
      };
  }
}

export { GatewayError };
