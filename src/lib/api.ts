import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';

import {
  groupAppearance,
  type GroupAppearance,
  type GroupColorKey,
  type GroupIconKey,
} from '../components/ui/group-icon';
import type { Database } from './database.types';
import { isErrorCode, type ErrorCode } from './error-codes';
import { pt } from './i18n/pt';
import {
  dataExportProjectionSchema,
  deletionRequestProjectionSchema,
  type DataExportProjection,
  type DeletionRequestProjection,
} from './privacy-schema';
import {
  ownProfileSchema,
  profilePatchSchema,
  profileSchema,
  type ProfileInput,
  type ProfilePatch,
} from './profile-schema';
import { getSupabaseClient, publicSupabaseConfig, type ColeteSupabaseClient } from './supabase';

export type { ProfileInput, ProfilePatch } from './profile-schema';
export type {
  DataExportProjection,
  DataExportStatus,
  DeletionRequestProjection,
  DeletionRequestStatus,
} from './privacy-schema';

export type OwnProfile = Omit<
  Pick<
    Database['public']['Tables']['profiles']['Row'],
    'id' | 'name' | 'nickname' | 'position' | 'dominant_foot' | 'shirt_number'
  >,
  'dominant_foot' | 'position'
> & {
  dominant_foot: 'left' | 'right' | 'both' | null;
  position: 'goalkeeper' | 'defender' | 'midfielder' | 'forward' | null;
};

export type IdentityOperation =
  | 'accept_policies'
  | 'complete_profile'
  | 'delete_account'
  | 'request_data_export'
  | 'revoke_current_session'
  | 'update_profile';

export type GroupOperation =
  | 'create_group'
  | 'join_by_code'
  | 'join_by_invite'
  | 'leave_group'
  | 'revoke_group_invite'
  | 'regenerate_group_invite'
  | 'issue_group_invite'
  | 'approve_member'
  | 'remove_member'
  | 'set_role'
  | 'rename_group'
  | 'set_group_appearance'
  | 'transfer_ownership'
  | 'create_match'
  | 'join_match'
  | 'leave_match'
  | 'set_match_payment'
  | 'update_match'
  | 'cancel_match'
  | 'record_canceled_match_payment'
  | 'mark_refunded'
  | 'correct_refund'
  | 'delete_group'
  | 'draw_teams'
  | 'begin_photo_upload'
  | 'set_profile_photo'
  | 'remove_profile_photo'
  | 'set_group_photo'
  | 'remove_group_photo'
  | 'set_rating'
  | 'set_ratings_visibility';

export type GroupOutcome = {
  outcome: { group_id: string; invite_id?: string; logical_result: string; reentry?: boolean };
  current?: { group_id?: string; group_name?: string; status?: 'pending' | 'active' };
};
/** The create_match config of docs/13 section 3.1, Rachas v1 cut (docs/25 section 8.1). */
export type MatchConfig = {
  description: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  location_name: string;
  location_address: string | null;
  latitude: number | null;
  longitude: number | null;
  field_slots: number;
  field_price: string;
};
export type MatchOutcome = {
  outcome: { group_id: string; match_id: string; logical_result: 'match_created' };
};
/** update_match and cancel_match (0028): IDs and the logical result only; the match is read again. */
export type MatchEditOutcome = {
  outcome: {
    group_id: string;
    match_id: string;
    logical_result: 'match_updated' | 'match_canceled' | 'match_cancel_unchanged';
  };
};
export type MatchSummary = {
  id: string;
  /** Only get_match projects it; list_my_matches leaves it out. */
  description?: string | null;
  group_id: string;
  group_name: string;
  /** The owner's choice (0027); read through groupAppearance, never trusted raw. */
  group_icon: string;
  group_color: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  location_name: string;
  location_address: string | null;
  latitude: number | null;
  longitude: number | null;
  field_slots: number;
  field_price: number;
  /** Canceled for good (0028): still listed until it ends, with the "Cancelado" chip. */
  canceled: boolean;
};
/** One address found by search_address: LocationIQ through the Edge, never from the app. */
export type AddressResult = { label: string; latitude: number; longitude: number };
export type AddressSearch = {
  results: AddressResult[];
  /** "© OpenStreetMap", shown with the results. */
  attribution: string;
  /** The search service did not answer (or has no key): the person types the address instead. */
  unavailable?: boolean;
};
/** The presence of the viewer in one match, recomputed on every answer. */
export type MatchPresenceStatus = 'starter' | 'waitlist' | 'out';
export type MatchPresenceResult = {
  outcome: {
    group_id: string;
    match_id: string;
    logical_result:
      | 'match_joined'
      | 'match_waitlisted'
      | 'match_join_unchanged'
      | 'match_left'
      | 'match_leave_unchanged';
  };
  current: {
    status: MatchPresenceStatus;
    waitlist_position: number | null;
    confirmed_count: number;
    waitlist_count: number;
    field_slots: number;
  };
};
export type MatchPaymentSummary = { paid_count: number; confirmed_count: number; total: string };
export type MatchPaymentResult = {
  outcome: {
    group_id: string;
    match_id: string;
    profile_id: string;
    logical_result: 'payment_marked_paid' | 'payment_marked_unpaid' | 'payment_unchanged';
  };
  current: MatchPaymentSummary;
};
/** One line of a roster. A removed account keeps its place but shows no identity. */
export type MatchRosterEntry = {
  profile_id: string | null;
  name: string | null;
  nickname: string | null;
  position: 'goalkeeper' | 'defender' | 'midfielder' | 'forward' | null;
  account_removed: boolean;
  is_viewer: boolean;
  /** Only for the organisation, and only on confirmed lines. */
  paid?: boolean | null;
  can_record_canceled_payment?: boolean;
};
export type MatchRefund = {
  id: string;
  amount: number;
  status: 'refund_due' | 'refunded';
  created_at: string;
  refunded_at: string | null;
};
export type ManagedMatchRefund = MatchRefund & {
  name: string | null;
  nickname: string | null;
  account_removed: boolean;
};
export type MatchRefundOutcome = {
  outcome: { group_id: string; match_id: string; refund_id: string; logical_result: string };
};
export type MatchRoster = {
  match_id: string;
  field_slots: number;
  started: boolean;
  canceled: boolean;
  confirmed_count: number;
  waitlist_count: number;
  viewer: {
    status: MatchPresenceStatus;
    waitlist_position: number | null;
    paid: boolean | null;
    refunds: MatchRefund[];
    can_manage: boolean;
  };
  confirmed: MatchRosterEntry[];
  waitlist: MatchRosterEntry[];
  payment_summary: MatchPaymentSummary | null;
};
/** draw_teams (0032): IDs and the logical result only; the teams are read again. */
export type MatchTeamsOutcome = {
  outcome: { group_id: string; match_id: string; logical_result: 'teams_drawn' };
};
export type MatchTeamCount = 2 | 3 | 4;
/** One player of a team: the roster's fields, without the payment. */
export type MatchTeamPlayer = Omit<MatchRosterEntry, 'paid'>;
/**
 * The last draw of the match (0032), as every active member reads it. Each
 * team holds only who is still confirmed, in the order of the draw; whoever
 * was confirmed afterwards is in `unassigned`, and `stale` says the list
 * changed since the draw. A canceled match has no teams.
 */
export type MatchTeams = {
  match_id: string;
  can_draw: boolean;
  team_count: MatchTeamCount | null;
  stale: boolean;
  teams: { team_number: number; players: MatchTeamPlayer[] }[];
  unassigned: MatchTeamPlayer[];
};
export type MatchOccupancy = {
  match_id: string;
  confirmed_count: number;
  waitlist_count: number;
  viewer_status: MatchPresenceStatus;
  canceled: boolean;
};
/** set_rating (0031): IDs and the logical result only; the stars come back in current. */
export type RatingOutcome = {
  outcome: {
    group_id: string;
    profile_id: string;
    logical_result: 'rating_set' | 'rating_unchanged';
  };
  current?: { stars: number | null };
};
export type RatingsVisibility = 'private' | 'members';
/** One active member as get_group_ratings shows them; who and when only for the organization. */
export type MemberRating = {
  profile_id: string;
  display_name: string;
  stars: number | null;
  changed_by_name?: string | null;
  changed_by_removed?: boolean;
  changed_at?: string | null;
};
/**
 * The ratings an active member may read (0031): the own stars always; the
 * others' current stars for the organization, or for everyone when the owner
 * chose "members"; otherwise `members` is null.
 */
export type GroupRatings = {
  group_id: string;
  visibility: RatingsVisibility;
  can_rate: boolean;
  own_stars: number | null;
  members: MemberRating[] | null;
};
/** get_my_rating: the own rating in any visibility, also after leaving, during retention. */
export type MyRating = {
  group_id: string;
  stars: number | null;
  rating_history_id: number | null;
  updated_at: string | null;
};
export type GroupSummary = {
  id: string;
  name: string;
  owner_id: string;
  role: string;
  appearance: GroupAppearance;
};
export type GroupDetail = {
  id: string;
  name: string;
  owner_id: string;
  role: string;
  appearance: GroupAppearance;
  membershipRole?: string | undefined;
};
export type GroupInvite = {
  id: string;
  group_id: string;
  expires_at: string;
  revoked_at: string | null;
  max_uses: number;
  used_count: number;
};
/**
 * The invitation page (0026): what a live code, QR or link shows before the
 * request. No member list, profile ID or e-mail; the group ID only for an
 * active member, to open the group.
 */
export type InvitePage = {
  group_name: string;
  member_count: number;
  owner_name: string | null;
  viewer_status: 'active' | 'pending' | null;
  group_id: string | null;
  refusal: 'GROUP_FULL' | 'GROUP_LIMIT' | null;
  /** The owner's choice (0027); read through groupAppearance. */
  group_icon: string;
  group_color: string;
};
export type InviteShare = {
  invite_id: string;
  expires_at: string;
  remaining_uses: number;
  share_url: string;
  code: string;
  code_format: 'v1';
};

/**
 * A photo upload session (0030): the signed URL that accepts exactly one JPEG
 * at the path the server chose, relative to the Supabase URL. The path itself
 * never reaches the app.
 */
export type PhotoUpload = {
  upload_id: string;
  url: string;
  expires_at: string;
  content_type: 'image/jpeg';
  max_bytes: number;
  max_side: number;
};
export type PhotoUploadStart = {
  outcome: { upload_id: string; logical_result: 'photo_upload_started' };
  /** Null on a replay whose session can no longer receive the photo. */
  upload: PhotoUpload | null;
};
export type PhotoOutcome = {
  outcome: { logical_result: string; profile_id?: string; group_id?: string };
  current?: { has_photo: boolean };
};
/** Short-lived signed read URLs (0030), relative to the Supabase URL, of the photos the caller may see. */
export type PhotoUrls = {
  expires_in: number;
  /** The caller's own photo, asked by a flag and never by the own ID (docs/22 section 6). */
  self: string | null;
  profiles: Record<string, string>;
  groups: Record<string, string>;
};

export type DataExportRequestResult = {
  outcome: { export_id: string; logical_result: 'data_export_requested' };
  current: DataExportProjection[];
};

export type AccountDeletionResult = {
  outcome: { deletion_request_id: string; logical_result: 'deletion_requested' };
  current: DeletionRequestProjection;
};

export class AppError extends Error {
  /** The Supabase Auth error code (e.g. `same_password`), when Auth produced the error. */
  readonly authCode?: string;
  readonly code: ErrorCode;
  readonly current?: unknown;
  readonly fields?: Readonly<Record<string, string>>;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly retryAfter?: number;
  readonly availableAt?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      authCode?: string;
      current?: unknown;
      fields?: Readonly<Record<string, string>>;
      requestId?: string;
      retryable?: boolean;
      retryAfter?: number;
      availableAt?: string;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (options.authCode !== undefined) this.authCode = options.authCode;
    if (Object.hasOwn(options, 'current')) this.current = options.current;
    if (options.fields !== undefined) this.fields = options.fields;
    this.requestId = options.requestId ?? '';
    this.retryable = options.retryable ?? code === 'IDEMPOTENCY_WAIT_TIMEOUT';
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
    if (options.availableAt !== undefined) this.availableAt = options.availableAt;
  }
}

export class TransportError extends Error {
  readonly retryable = true;

  constructor(message = 'A rede não respondeu. Confira a conexão e tente novamente.') {
    super(message);
    this.name = 'TransportError';
  }
}

/**
 * A data export transfer that did not complete. Whether the compare-and-set
 * happened before the interruption is unknowable from the client, so this is
 * never retried automatically: the screen re-reads the projection instead.
 */
export class DownloadInterruptedError extends Error {
  readonly phase: 'connect' | 'stream';
  readonly retryable = false;

  constructor(phase: 'connect' | 'stream') {
    super('A transferência do export foi interrompida.');
    this.name = 'DownloadInterruptedError';
    this.phase = phase;
  }
}

class NonRetryableResponseError extends Error {
  constructor() {
    super('O serviço recusou a chamada sem devolver um erro reconhecido.');
    this.name = 'NonRetryableResponseError';
  }
}

type FetchLike = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;
type UuidFactory = () => string;

type ApiDependencies = {
  fetch?: FetchLike;
  maxAutomaticRetries?: number;
  sleep?: Sleep;
  supabase?: ColeteSupabaseClient;
  supabaseConfig?: { url: string; publishableKey: string };
  uuid?: UuidFactory;
};

type GatewaySuccess<T> = { data: T; request_id: string };

const INTERNAL_ONLY_FIELDS = new Set([
  'actor',
  'actor_auth_user_id',
  'actor_key',
  'actor_session_id',
  'auth_user_id',
  'canonical_version',
  'hash_key_version',
  'input_hmac',
  'profile_id',
  'session_id',
]);
const groupOperations = new Set<string>([
  'create_group',
  'join_by_code',
  'join_by_invite',
  'leave_group',
  'revoke_group_invite',
  'regenerate_group_invite',
  'issue_group_invite',
  'approve_member',
  'remove_member',
  'set_role',
  'rename_group',
  'set_group_appearance',
  'transfer_ownership',
  'create_match',
  'join_match',
  'leave_match',
  'set_match_payment',
  'update_match',
  'cancel_match',
  'record_canceled_match_payment',
  'mark_refunded',
  'correct_refund',
  'delete_group',
  'draw_teams',
  'begin_photo_upload',
  'set_profile_photo',
  'remove_profile_photo',
  'set_group_photo',
  'remove_group_photo',
  'set_rating',
  'set_ratings_visibility',
]);

function refuseInternalFields(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => refuseInternalFields(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  for (const [key, nested] of Object.entries(value)) {
    const keyPath = path === '' ? key : `${path}.${key}`;
    if (INTERNAL_ONLY_FIELDS.has(key)) {
      throw new AppError(
        'VALIDATION',
        'Esse campo pertence somente à chamada interna e não pode sair do cliente.',
        { fields: { [keyPath]: 'internal_only' } },
      );
    }
    refuseInternalFields(nested, keyPath);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function appErrorFromEnvelope(value: unknown, fallbackRequestId: string): AppError | undefined {
  const envelope = asRecord(value);
  const error = asRecord(envelope?.['error']);
  const code = error?.['code'];
  const message = error?.['message'];
  if (error === undefined || !isErrorCode(code) || typeof message !== 'string') return undefined;

  const rawFields = asRecord(error['fields']);
  const fields =
    rawFields === undefined || Object.values(rawFields).some((field) => typeof field !== 'string')
      ? undefined
      : (rawFields as Record<string, string>);
  const requestId =
    typeof envelope?.['request_id'] === 'string' ? envelope['request_id'] : fallbackRequestId;
  const options: {
    current?: unknown;
    fields?: Readonly<Record<string, string>>;
    requestId: string;
    retryable?: boolean;
  } = { requestId };
  if (Object.hasOwn(error, 'current')) options.current = error['current'];
  if (fields !== undefined) options.fields = fields;
  if (typeof error['retry_after'] === 'number' && Number.isFinite(error['retry_after'])) {
    Object.assign(options, { retryAfter: error['retry_after'], retryable: true });
  }
  if (typeof error['available_at'] === 'string') {
    Object.assign(options, { availableAt: error['available_at'] });
  }
  return new AppError(code, message, options);
}

function successFromEnvelope<T>(value: unknown, expectedRequestId: string): GatewaySuccess<T> {
  const envelope = asRecord(value);
  if (
    envelope === undefined ||
    !Object.hasOwn(envelope, 'data') ||
    envelope['request_id'] !== expectedRequestId
  ) {
    throw new TransportError('O servidor respondeu em um formato inesperado. Tente novamente.');
  }
  return envelope as GatewaySuccess<T>;
}

function authFailure(
  error: { code?: string | undefined; message: string; status: number | undefined },
  code: ErrorCode,
): never {
  if (error.status === undefined || error.status === 0 || error.status >= 500) {
    throw new TransportError();
  }
  // Auth quotas can arrive without a code, or under the request/e-mail code.
  // Transport failures keep precedence; only an actual Auth refusal reaches here.
  const rateLimited =
    error.status === 429 ||
    error.code === 'over_request_rate_limit' ||
    error.code === 'over_email_send_rate_limit';
  throw new AppError(
    rateLimited ? 'RATE_LIMITED' : code,
    rateLimited ? pt.auth.errors.rateLimit : error.message,
    error.code === undefined ? {} : { authCode: error.code },
  );
}

export type MutationIntent<T> = {
  readonly operation: IdentityOperation | GroupOperation;
  readonly requestId: string;
  execute: () => Promise<T>;
  retry: () => Promise<T>;
};

export function createApiClient(dependencies: ApiDependencies = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  const maxAutomaticRetries = dependencies.maxAutomaticRetries ?? 2;
  const sleep: Sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const uuid = dependencies.uuid ?? (() => crypto.randomUUID());
  const supabase = () => dependencies.supabase ?? getSupabaseClient();
  const config = () => dependencies.supabaseConfig ?? publicSupabaseConfig();

  async function callGateway<T>(
    operation: IdentityOperation | GroupOperation,
    requestId: string,
    serializedBody: string,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const accessToken = await accessTokenOrThrow(requestId);

        const { url, publishableKey } = config();
        const gateway = groupOperations.has(operation) ? 'groups' : 'identity';
        const response = await fetcher(`${url}/functions/v1/${gateway}/${operation}`, {
          method: 'POST',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: {
            apikey: publishableKey,
            Authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: serializedBody,
        });
        const responseBody: unknown = await response.json().catch(() => undefined);
        const businessError = appErrorFromEnvelope(responseBody, requestId);
        if (businessError?.code === 'INTERNAL') throw new TransportError();
        if (businessError !== undefined) throw businessError;
        if (!response.ok) {
          if (response.status >= 500) throw new TransportError();
          throw new NonRetryableResponseError();
        }
        return successFromEnvelope<T>(responseBody, requestId).data;
      } catch (error) {
        if (error instanceof AppError || error instanceof NonRetryableResponseError) throw error;
        const transport = error instanceof TransportError ? error : new TransportError();
        if (attempt >= maxAutomaticRetries) throw transport;
        await sleep(150 * 2 ** attempt);
      }
    }
  }

  function mutation<T>(
    operation: IdentityOperation | GroupOperation,
    businessInput: Readonly<Record<string, unknown>>,
  ): MutationIntent<T> {
    // Only these signatures enumerate profile_id as a business target.
    if (
      ['approve_member', 'remove_member', 'set_role', 'set_match_payment', 'set_rating'].includes(
        operation,
      )
    ) {
      const { profile_id: target, ...rest } = businessInput;
      refuseInternalFields(rest);
      refuseInternalFields(target, 'profile_id');
    } else refuseInternalFields(businessInput);
    const requestId = uuid();
    const serializedBody = JSON.stringify({ request_id: requestId, ...businessInput });
    const execute = () => callGateway<T>(operation, requestId, serializedBody);
    return { operation, requestId, execute, retry: execute };
  }

  async function groupRead<T>(
    operation: string,
    businessInput: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    refuseInternalFields(businessInput);
    const accessToken = await accessTokenOrThrow();
    const { url, publishableKey } = config();
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetcher(`${url}/functions/v1/groups/${operation}`, {
          method: 'POST',
          ...(signal === undefined ? {} : { signal }),
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: {
            apikey: publishableKey,
            Authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(businessInput),
        });
      } catch {
        throw new TransportError();
      }
      const body: unknown = await response.json().catch(() => undefined);
      const error = appErrorFromEnvelope(body, '');
      if (error?.code === 'INTERNAL') throw new TransportError();
      if (error !== undefined) throw error;
      const hasData = Object.hasOwn(asRecord(body) ?? {}, 'data');
      if (response.ok && hasData) return (body as { data: T }).data;
      // A 5xx without the gateway's envelope is the Edge runtime's own failure:
      // the function never answered (its worker was retired at a resource limit,
      // failed to boot or crashed). A read has no effect, so it is sent again,
      // like a mutation's transport retry (polimento final: the local runtime
      // retired workers mid-request about once per suite).
      if (response.status < 500 || attempt >= maxAutomaticRetries || signal?.aborted)
        throw new TransportError();
      await sleep(150 * 2 ** attempt);
    }
  }

  function profileValidationError(error: {
    issues: readonly { message: string; path: PropertyKey[] }[];
  }) {
    const fields = Object.fromEntries(
      error.issues.map((issue) => [issue.path.join('.'), issue.message]),
    );
    return new AppError('VALIDATION', 'Revise os campos indicados e tente novamente.', { fields });
  }

  function parseProfile<T>(
    schema: {
      safeParse: (value: unknown) =>
        | { success: true; data: T }
        | {
            success: false;
            error: { issues: readonly { message: string; path: PropertyKey[] }[] };
          };
    },
    value: unknown,
  ): T {
    const result = schema.safeParse(value);
    if (!result.success) throw profileValidationError(result.error);
    return result.data;
  }

  async function accessTokenOrThrow(requestId = ''): Promise<string> {
    const sessionResult = await supabase().auth.getSession();
    if (sessionResult.error !== null) authFailure(sessionResult.error, 'UNAUTHENTICATED');
    const accessToken = sessionResult.data.session?.access_token;
    if (accessToken === undefined) {
      throw new AppError('UNAUTHENTICATED', 'Entre novamente para continuar.', { requestId });
    }
    return accessToken;
  }

  function parseProjectionRows<T>(
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
    rows: unknown,
  ): T[] {
    if (!Array.isArray(rows)) {
      throw new TransportError('A projeção chegou em um formato inesperado.');
    }
    return rows.map((row) => {
      const parsed = schema.safeParse(row);
      if (!parsed.success) {
        throw new TransportError('A projeção chegou em um formato inesperado.');
      }
      return parsed.data;
    });
  }

  return {
    getGroupMembers: (groupId: string, signal?: AbortSignal) =>
      groupRead<
        {
          profile_id: string;
          display_name: string;
          role: 'owner' | 'organizer' | 'player';
          status: 'active' | 'pending';
        }[]
      >('get_group_members', { group_id: groupId }, signal),
    approveMember: (groupId: string, targetId: string, approve: boolean) =>
      mutation<GroupOutcome>('approve_member', {
        group_id: groupId,
        profile_id: targetId,
        approve,
      }),
    removeMember: (groupId: string, targetId: string, reason: string) =>
      mutation<GroupOutcome>('remove_member', { group_id: groupId, profile_id: targetId, reason }),
    setMemberRole: (groupId: string, targetId: string, role: 'organizer' | 'player') =>
      mutation<GroupOutcome>('set_role', { group_id: groupId, profile_id: targetId, role }),
    renameGroup: (groupId: string, name: string) =>
      mutation<GroupOutcome>('rename_group', { group_id: groupId, name }),
    /** Owner only (OWNER_ONLY otherwise): both keys travel together, as the screen saves them. */
    setGroupAppearance: (groupId: string, icon: GroupIconKey, color: GroupColorKey) =>
      mutation<GroupOutcome>('set_group_appearance', { group_id: groupId, icon, color }),
    transferOwnership: (groupId: string, targetId: string) =>
      mutation<GroupOutcome>('transfer_ownership', { group_id: groupId, new_owner_id: targetId }),
    /** The owner or an organizer gives an active member 1 to 5 stars (0031). */
    setRating: (groupId: string, targetId: string, stars: number) =>
      mutation<RatingOutcome>('set_rating', { group_id: groupId, profile_id: targetId, stars }),
    /** Owner only; showing the ratings to members travels with its confirmation (0016). */
    setRatingsVisibility: (groupId: string, visibility: RatingsVisibility) =>
      mutation<GroupOutcome>('set_ratings_visibility', {
        group_id: groupId,
        visibility,
        confirm_members_visibility: visibility === 'members',
      }),
    getGroupRatings: (groupId: string, signal?: AbortSignal) =>
      groupRead<GroupRatings>('get_group_ratings', { group_id: groupId }, signal),
    getMyRating: (groupId: string, signal?: AbortSignal) =>
      groupRead<MyRating>('get_my_rating', { group_id: groupId }, signal),
    /** Owner only, and final (0029): the typed name stays on the screen, never in the call. */
    deleteGroup: (groupId: string) => mutation<GroupOutcome>('delete_group', { group_id: groupId }),
    createGroup: (name: string) => mutation<GroupOutcome>('create_group', { name }),
    /** Opens a session for one photo: the own profile's, or (owner only) a group's. */
    beginPhotoUpload: (target: 'profile' | 'group', groupId?: string) =>
      mutation<PhotoUploadStart>(
        'begin_photo_upload',
        target === 'group' ? { target, group_id: groupId } : { target },
      ),
    setProfilePhoto: (uploadId: string) =>
      mutation<PhotoOutcome>('set_profile_photo', { upload_id: uploadId }),
    removeProfilePhoto: () => mutation<PhotoOutcome>('remove_profile_photo', {}),
    setGroupPhoto: (groupId: string, uploadId: string) =>
      mutation<PhotoOutcome>('set_group_photo', { group_id: groupId, upload_id: uploadId }),
    removeGroupPhoto: (groupId: string) =>
      mutation<PhotoOutcome>('remove_group_photo', { group_id: groupId }),
    /** Signed read URLs of the photos the caller may see; the others are simply absent. */
    getPhotoUrls: (profileIds: readonly string[], groupIds: readonly string[], self = false) =>
      groupRead<PhotoUrls>('get_photo_urls', {
        profile_ids: [...profileIds],
        group_ids: [...groupIds],
        ...(self ? { self } : {}),
      }),
    /** An absolute URL for a path the gateway returned relative to the Supabase URL. */
    supabaseUrl: (relative: string) => `${config().url}${relative}`,
    /**
     * Sends the prepared JPEG to the session's signed URL. Storage accepts it
     * once, as image/jpeg, up to the bucket's size; the server checks it again
     * before the photo is used.
     */
    async uploadPhoto(upload: PhotoUpload, body: BodyInit): Promise<void> {
      const { url, publishableKey } = config();
      let response: Response;
      try {
        response = await fetcher(`${url}${upload.url}`, {
          method: 'PUT',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers:
            typeof FormData !== 'undefined' && body instanceof FormData
              ? { apikey: publishableKey, 'x-upsert': 'false' }
              : {
                  apikey: publishableKey,
                  'content-type': upload.content_type,
                  'x-upsert': 'false',
                },
          body,
        });
      } catch {
        throw new TransportError();
      }
      if (response.status === 413 || response.status === 415 || response.status === 400) {
        throw new AppError('VALIDATION', pt.photos.errors.invalid);
      }
      if (!response.ok) throw new TransportError();
    },
    createMatch: (groupId: string, config: MatchConfig) =>
      mutation<MatchOutcome>('create_match', { group_id: groupId, config }),
    /** The whole form again, as create_match takes it; the group never changes. */
    updateMatch: (matchId: string, config: MatchConfig) =>
      mutation<MatchEditOutcome>('update_match', { match_id: matchId, config }),
    cancelMatch: (matchId: string) =>
      mutation<MatchEditOutcome>('cancel_match', { match_id: matchId }),
    joinMatch: (matchId: string) =>
      mutation<MatchPresenceResult>('join_match', { match_id: matchId }),
    leaveMatch: (matchId: string) =>
      mutation<MatchPresenceResult>('leave_match', { match_id: matchId }),
    setMatchPayment: (matchId: string, targetId: string, paid: boolean) =>
      mutation<MatchPaymentResult>('set_match_payment', {
        match_id: matchId,
        profile_id: targetId,
        paid,
      }),
    recordCanceledMatchPayment: (matchId: string, profileId: string) =>
      mutation<MatchRefundOutcome>('record_canceled_match_payment', {
        match_id: matchId,
        profile_id: profileId,
      }),
    markRefunded: (matchId: string, refundId: string, refundedAt: string) =>
      mutation<MatchRefundOutcome>('mark_refunded', {
        match_id: matchId,
        refund_id: refundId,
        refunded_at: refundedAt,
      }),
    correctRefund: (matchId: string, refundId: string, correctedAt: string) =>
      mutation<MatchRefundOutcome>('correct_refund', {
        match_id: matchId,
        refund_id: refundId,
        corrected_at: correctedAt,
      }),
    getMatchRefunds: (matchId: string, signal?: AbortSignal) =>
      groupRead<ManagedMatchRefund[]>('get_match_refunds', { match_id: matchId }, signal),
    getMatchRoster: (matchId: string, signal?: AbortSignal) =>
      groupRead<MatchRoster>('get_match_roster', { match_id: matchId }, signal),
    /** The server draws from the confirmed list and ratings it holds; only the count and the unequal-sizes confirmation travel. */
    drawTeams: (matchId: string, teamCount: MatchTeamCount, confirmUnequalSizes: boolean) =>
      mutation<MatchTeamsOutcome>('draw_teams', {
        match_id: matchId,
        team_count: teamCount,
        confirm_unequal_sizes: confirmUnequalSizes,
      }),
    getMatchTeams: (matchId: string, signal?: AbortSignal) =>
      groupRead<MatchTeams>('get_match_teams', { match_id: matchId }, signal),
    /** One search per press; the Edge asks LocationIQ and keeps the text and the key out of every log. */
    searchAddress: (query: string, signal?: AbortSignal) =>
      groupRead<AddressSearch>('search_address', { query }, signal),
    getMatchesOccupancy: (signal?: AbortSignal) =>
      groupRead<MatchOccupancy[]>('get_matches_occupancy', {}, signal),
    joinGroupByCode: (code: string) => mutation<GroupOutcome>('join_by_code', { code }),
    joinGroupByInvite: (token: string) => mutation<GroupOutcome>('join_by_invite', { token }),
    leaveGroup: (groupId: string) => mutation<GroupOutcome>('leave_group', { group_id: groupId }),
    revokeGroupInvite: (inviteId: string) =>
      mutation<GroupOutcome>('revoke_group_invite', { invite_id: inviteId }),
    regenerateGroupInvite: (inviteId: string) =>
      mutation<GroupOutcome>('regenerate_group_invite', { invite_id: inviteId }),
    issueGroupInvite: (groupId: string) =>
      mutation<GroupOutcome>('issue_group_invite', { group_id: groupId }),
    previewGroupByCode: (code: string) => groupRead<InvitePage>('preview_group_by_code', { code }),
    previewGroupByInvite: (token: string) =>
      groupRead<InvitePage>('preview_group_by_invite', { token }),
    getMyPendingGroupRequests: () =>
      groupRead<{ group_id: string; group_name: string; status: 'pending' }[]>(
        'get_my_pending_group_requests',
        {},
      ),
    getInviteShareLink: (inviteId: string, signal?: AbortSignal) =>
      groupRead<InviteShare>('get_invite_share_link', { invite_id: inviteId }, signal),
    async getOwnGroups(profileId: string, accessToken: string): Promise<GroupSummary[]> {
      const memberships = await supabase()
        .from('group_members')
        .select('group_id,role,status')
        .eq('profile_id', profileId)
        .eq('status', 'active')
        .setHeader('Authorization', `Bearer ${accessToken}`);
      if (memberships.error !== null) throw new TransportError();
      const ids = (memberships.data ?? []).map((row) => row.group_id);
      if (ids.length === 0) return [];
      const groups = await supabase()
        .from('groups')
        .select('id,name,owner_id,icon,color')
        .in('id', ids)
        .order('name')
        .setHeader('Authorization', `Bearer ${accessToken}`);
      if (groups.error !== null) throw new TransportError();
      return (groups.data ?? []).map(({ icon, color, ...group }) => ({
        ...group,
        appearance: groupAppearance(icon, color),
        role:
          group.owner_id === profileId
            ? 'owner'
            : (memberships.data?.find((member) => member.group_id === group.id)?.role ?? 'player'),
      }));
    },
    /**
     * Unfinished matches of the caller's active groups. The table has no client
     * privilege: the Edge reads it with the actor context, which refuses a
     * revoked session (review of #70, P1-1).
     */
    getUpcomingMatches: (signal?: AbortSignal) =>
      groupRead<MatchSummary[]>('list_my_matches', {}, signal),
    /** One match, or null: unknown and not-yours answer the same NOT_FOUND. */
    async getMatch(matchId: string, signal?: AbortSignal): Promise<MatchSummary | null> {
      try {
        const rows = await groupRead<MatchSummary[]>('get_match', { match_id: matchId }, signal);
        return rows[0] ?? null;
      } catch (error) {
        if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
        throw error;
      }
    },
    async getGroupDetail(
      groupId: string,
      profileId: string,
      accessToken: string,
    ): Promise<GroupDetail | null> {
      const result = await supabase()
        .from('groups')
        .select('id,name,owner_id,icon,color')
        .eq('id', groupId)
        .maybeSingle()
        .setHeader('Authorization', `Bearer ${accessToken}`);
      if (result.error !== null) throw new TransportError();
      if (result.data === null) return null;
      const { icon, color, ...group } = result.data;
      const membership = await supabase()
        .from('group_members')
        .select('role,status')
        .eq('group_id', groupId)
        .eq('profile_id', profileId)
        .maybeSingle()
        .setHeader('Authorization', `Bearer ${accessToken}`);
      if (membership.error !== null) throw new TransportError();
      return {
        ...group,
        appearance: groupAppearance(icon, color),
        role: group.owner_id === profileId ? 'owner' : (membership.data?.role ?? 'player'),
        membershipRole: membership.data?.role,
      };
    },
    async getGroupInvites(groupId: string, accessToken: string): Promise<GroupInvite[]> {
      const result = await supabase()
        .from('group_invites')
        .select('id,group_id,expires_at,revoked_at,max_uses,used_count')
        .eq('group_id', groupId)
        .order('created_at', { ascending: false })
        .setHeader('Authorization', `Bearer ${accessToken}`);
      if (result.error !== null) throw new TransportError();
      return result.data ?? [];
    },
    completeProfile: (profile: ProfileInput) =>
      mutation<{
        outcome: { profile_id: string; logical_result: 'profile_created' };
        current: OwnProfile;
      }>('complete_profile', { profile: parseProfile(profileSchema, profile) }),
    updateProfile: (patch: ProfilePatch) => {
      refuseInternalFields(patch);
      return mutation<{ outcome: { logical_result: 'profile_updated' }; current: OwnProfile }>(
        'update_profile',
        { patch: parseProfile(profilePatchSchema, patch) },
      );
    },
    acceptPolicies: (
      versions: readonly { document_type: 'terms' | 'privacy'; version: string }[],
    ) => mutation('accept_policies', { versions }),
    revokeCurrentSession: () => mutation('revoke_current_session', {}),
    requestDataExport: () => mutation<DataExportRequestResult>('request_data_export', {}),
    deleteAccount: () => mutation<AccountDeletionResult>('delete_account', {}),

    async getOwnDataExports(accessToken: string): Promise<DataExportProjection[]> {
      const result = await supabase()
        .rpc('get_own_data_exports')
        .setHeader('Authorization', `Bearer ${accessToken}`);
      if (result.error !== null) {
        if (result.status === 401) throw new AppError('UNAUTHENTICATED', result.error.message);
        throw new TransportError();
      }
      return parseProjectionRows(dataExportProjectionSchema, result.data);
    },

    async getOwnDeletionRequest(accessToken: string): Promise<DeletionRequestProjection | null> {
      const result = await supabase()
        .rpc('get_own_deletion_request')
        .setHeader('Authorization', `Bearer ${accessToken}`);
      if (result.error !== null) {
        if (result.status === 401) throw new AppError('UNAUTHENTICATED', result.error.message);
        throw new TransportError();
      }
      return parseProjectionRows(deletionRequestProjectionSchema, result.data)[0] ?? null;
    },

    /**
     * The one-shot stream of docs/22 section 5.3. Exactly one attempt: the
     * server consumes the export before the first byte, so a transfer that
     * drops is never resumed, reopened or retried here. The bytes stay in
     * memory and are handed to the browser by the caller.
     */
    async downloadDataExport(exportId: string): Promise<Blob> {
      const accessToken = await accessTokenOrThrow();
      const { url, publishableKey } = config();
      let response: Response;
      try {
        response = await fetcher(`${url}/functions/v1/data-exports/${exportId}/content`, {
          method: 'GET',
          cache: 'no-store',
          headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}` },
        });
      } catch {
        throw new DownloadInterruptedError('connect');
      }
      if (!response.ok) {
        const responseBody: unknown = await response.json().catch(() => undefined);
        const businessError = appErrorFromEnvelope(responseBody, '');
        if (businessError !== undefined && businessError.code !== 'INTERNAL') throw businessError;
        throw new DownloadInterruptedError('connect');
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
      if (contentType !== 'application/zip') throw new DownloadInterruptedError('stream');
      try {
        return await response.blob();
      } catch {
        throw new DownloadInterruptedError('stream');
      }
    },

    async signUpWithPassword(email: string, password: string, name: string) {
      const result = await supabase().auth.signUp({
        email,
        password,
        options: { data: { name } },
      });
      if (result.error !== null) authFailure(result.error, 'VALIDATION');
      return result.data;
    },

    async signInWithPassword(email: string, password: string) {
      const result = await supabase().auth.signInWithPassword({ email, password });
      if (result.error !== null) authFailure(result.error, 'UNAUTHENTICATED');
      return result.data;
    },

    async verifyEmailOtp(email: string, token: string, type: 'email' | 'recovery' | 'signup') {
      const result = await supabase().auth.verifyOtp({ email, token, type });
      if (result.error !== null) authFailure(result.error, 'UNAUTHENTICATED');
      return result.data;
    },

    async resendSignupOtp(email: string) {
      const result = await supabase().auth.resend({ email, type: 'signup' });
      if (result.error !== null) authFailure(result.error, 'VALIDATION');
    },

    async requestPasswordOtp(email: string) {
      const result = await supabase().auth.resetPasswordForEmail(email);
      if (result.error !== null) authFailure(result.error, 'VALIDATION');
    },

    async updatePassword(password: string) {
      const result = await supabase().auth.updateUser({ password });
      if (result.error !== null) authFailure(result.error, 'VALIDATION');
      return result.data.user;
    },

    async getSession(): Promise<Session | null> {
      const result = await supabase().auth.getSession();
      if (result.error !== null) authFailure(result.error, 'UNAUTHENTICATED');
      return result.data.session;
    },

    onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void) {
      return supabase().auth.onAuthStateChange(callback).data.subscription;
    },

    async getOwnProfile(accessToken: string): Promise<OwnProfile | null> {
      const result = await supabase()
        .from('profiles')
        .select('id,name,nickname,position,dominant_foot,shirt_number')
        .maybeSingle()
        .setHeader('Authorization', `Bearer ${accessToken}`);
      if (result.error !== null) throw new TransportError();
      if (result.data === null) return null;
      const parsed = ownProfileSchema.safeParse(result.data);
      if (!parsed.success) throw new TransportError('O perfil chegou em um formato inesperado.');
      return parsed.data;
    },

    async signOutLocally() {
      const result = await supabase().auth.signOut({ scope: 'local' });
      if (result.error !== null) authFailure(result.error, 'UNAUTHENTICATED');
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
export type AuthUser = User;

export const api = createApiClient();
