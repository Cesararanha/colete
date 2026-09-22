import { describe, expect, it } from 'vitest';

import { AppError, TransportError } from '../../lib/api';
import { pt } from '../../lib/i18n/pt';

import { profileErrorMessage } from './profile-errors';

describe('profile screen error mapping', () => {
  it('maps transport, validation and account-state errors to actionable interface text', () => {
    expect(profileErrorMessage(new TransportError())).toBe(pt.common.networkBody);
    expect(profileErrorMessage(new AppError('VALIDATION', 'fallback'))).toBe(
      pt.auth.errors.validation,
    );
    expect(profileErrorMessage(new AppError('PROFILE_SUSPENDED', 'fallback'))).toBe(
      pt.profile.errors.suspended,
    );
    expect(profileErrorMessage(new AppError('FORBIDDEN', 'fallback'))).toBe(
      pt.profile.errors.forbidden,
    );
  });

  it('maps the privacy codes of docs/13 section 5.3 to the normative interface text', () => {
    expect(profileErrorMessage(new AppError('FINANCIAL_SUBSTITUTE_REQUIRED', 'raw'))).toBe(
      pt.privacy.deletion.financialSubstituteRequired,
    );
    expect(profileErrorMessage(new AppError('DELETION_ALREADY_PENDING', 'raw'))).toBe(
      pt.privacy.deletion.alreadyPending,
    );
    expect(profileErrorMessage(new AppError('EXPORT_ALREADY_PENDING', 'raw'))).toBe(
      pt.privacy.export.alreadyPending,
    );
    expect(profileErrorMessage(new AppError('EXPORT_EXPIRED', 'raw'))).toBe(
      pt.privacy.export.states.consumed.body,
    );
    expect(profileErrorMessage(new AppError('RECENT_REAUTH_REQUIRED', 'raw'))).toBe(
      pt.privacy.export.reauth.body,
    );
  });

  it('keeps a recognised fallback for errors without a dedicated screen treatment', () => {
    expect(profileErrorMessage(new AppError('NOT_FOUND', 'Registro indisponível.'))).toBe(
      'Registro indisponível.',
    );
    expect(profileErrorMessage(new Error('raw'))).toBe(pt.auth.errors.generic);
  });
});
