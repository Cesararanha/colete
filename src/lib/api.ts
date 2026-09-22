import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';

import type { Database } from './database.types';
import { isErrorCode, type ErrorCode } from './error-codes';
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

export type DataExportRequestResult = {
  outcome: { export_id: string; logical_result: 'data_export_requested' };
  current: DataExportProjection[];
};

export type AccountDeletionResult = {
  outcome: { deletion_request_id: string; logical_result: 'deletion_requested' };
  current: DeletionRequestProjection;
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly current?: unknown;
  readonly fields?: Readonly<Record<string, string>>;
  readonly requestId: string;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      current?: unknown;
      fields?: Readonly<Record<string, string>>;
      requestId?: string;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (Object.hasOwn(options, 'current')) this.current = options.current;
    if (options.fields !== undefined) this.fields = options.fields;
    this.requestId = options.requestId ?? '';
    this.retryable = options.retryable ?? code === 'IDEMPOTENCY_WAIT_TIMEOUT';
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
  } = { requestId };
  if (Object.hasOwn(error, 'current')) options.current = error['current'];
  if (fields !== undefined) options.fields = fields;
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
  error: { message: string; status: number | undefined },
  code: ErrorCode,
): never {
  if (error.status === undefined || error.status === 0 || error.status >= 500) {
    throw new TransportError();
  }
  throw new AppError(code, error.message);
}

export type MutationIntent<T> = {
  readonly operation: IdentityOperation;
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
    operation: IdentityOperation,
    requestId: string,
    serializedBody: string,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const accessToken = await accessTokenOrThrow(requestId);

        const { url, publishableKey } = config();
        const response = await fetcher(`${url}/functions/v1/identity/${operation}`, {
          method: 'POST',
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
    operation: IdentityOperation,
    businessInput: Readonly<Record<string, unknown>>,
  ): MutationIntent<T> {
    refuseInternalFields(businessInput);
    const requestId = uuid();
    const serializedBody = JSON.stringify({ request_id: requestId, ...businessInput });
    const execute = () => callGateway<T>(operation, requestId, serializedBody);
    return { operation, requestId, execute, retry: execute };
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

    async getOwnDataExports(): Promise<DataExportProjection[]> {
      const result = await supabase().rpc('get_own_data_exports');
      if (result.error !== null) {
        if (result.status === 401) throw new AppError('UNAUTHENTICATED', result.error.message);
        throw new TransportError();
      }
      return parseProjectionRows(dataExportProjectionSchema, result.data);
    },

    async getOwnDeletionRequest(): Promise<DeletionRequestProjection | null> {
      const result = await supabase().rpc('get_own_deletion_request');
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

    async getOwnProfile(): Promise<OwnProfile | null> {
      const result = await supabase()
        .from('profiles')
        .select('id,name,nickname,position,dominant_foot,shirt_number')
        .maybeSingle();
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
