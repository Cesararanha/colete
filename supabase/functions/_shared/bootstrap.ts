// The bootstrap actor of docs/13-contratos-funcoes.md section 5.7.
//
// complete_profile derives its actor before asking whether a profile exists,
// because at that moment there is no profile to key the idempotency on. The
// digest is a plain SHA-256 with no key, which is why both the Edge and the
// database can produce it and why nothing here touches the vault.

const DOMAIN = 'colete/bootstrap-actor/v1';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class InvalidAuthUserIdError extends Error {
  constructor() {
    super('auth user id is not a canonical lowercase UUID');
    this.name = 'InvalidAuthUserIdError';
  }
}

/**
 * digest = SHA-256(UTF8("colete/bootstrap-actor/v1") || 0x00 || UUID_BYTES(auth_user_id))
 *
 * UUID_BYTES are the sixteen bytes of the canonical lowercase form with the
 * hyphens removed and the thirty-two hexadecimal digits decoded. The text of
 * the UUID is never hashed.
 */
export async function bootstrapActorKey(authUserId: string): Promise<string> {
  if (!CANONICAL_UUID.test(authUserId)) {
    throw new InvalidAuthUserIdError();
  }

  const hex = authUserId.replaceAll('-', '');
  const uuidBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    uuidBytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  const domain = new TextEncoder().encode(DOMAIN);
  const message = new Uint8Array(domain.length + 1 + uuidBytes.length);
  message.set(domain, 0);
  message[domain.length] = 0x00;
  message.set(uuidBytes, domain.length + 1);

  const digest = await crypto.subtle.digest('SHA-256', message as unknown as ArrayBuffer);
  const hexDigest = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `bootstrap:${hexDigest}`;
}
