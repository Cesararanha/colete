import { AppError, TransportError } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';

export function absoluteInviteTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export function groupErrorMessage(error: unknown, administration = false): string {
  if (error instanceof TransportError) return pt.groups.errors.network;
  if (!(error instanceof AppError)) return pt.groups.errors.generic;
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return pt.groups.errors.unauthenticated;
    case 'PROFILE_SUSPENDED':
      return pt.groups.errors.suspended;
    case 'VALIDATION':
      return pt.groups.errors.invalid;
    case 'CODE_INVALID':
      return pt.groups.errors.codeInvalid;
    case 'INVITE_REVOKED':
      return pt.groups.errors.revoked;
    case 'INVITE_EXPIRED':
      return pt.groups.errors.expired;
    case 'INVITE_USED':
      return pt.groups.errors.used;
    case 'GROUP_ARCHIVED':
      return administration ? pt.groups.members.archived : pt.groups.errors.archived;
    case 'GROUP_SUSPENDED':
      return pt.groups.errors.groupSuspended;
    case 'GROUP_FULL':
      return pt.groups.errors.full;
    case 'GROUP_LIMIT':
      return administration ? pt.groups.members.groupLimit : pt.groups.errors.limit;
    case 'RATE_LIMITED': {
      const when = error.availableAt === undefined ? '' : absoluteInviteTime(error.availableAt);
      return when === ''
        ? pt.groups.errors.rateUnavailable
        : administration
          ? pt.groups.members.rate(when)
          : pt.groups.errors.rate(when);
    }
    case 'RATE_LIMIT_UNAVAILABLE':
      return pt.groups.errors.rateUnavailable;
    case 'PROOFS_PENDING':
      return 'Há comprovantes pendentes. Resolva-os antes de remover esta pessoa.';
    case 'OWNER_MUST_TRANSFER':
      return pt.groups.errors.ownerMustTransfer;
    case 'NOT_MEMBER':
      return pt.groups.errors.notMember;
    case 'NOT_ORGANIZER':
      return pt.groups.errors.notOrganizer;
    case 'OWNER_ONLY':
      return pt.groups.errors.ownerOnly;
    case 'MEMBERSHIP_ALREADY_DECIDED':
      return pt.groups.errors.alreadyDecided;
    case 'NOT_FOUND':
      return pt.groups.errors.notFound;
    case 'IS_OWNER':
      return pt.groups.errors.isOwner;
    case 'NOT_ACTIVE_MEMBER':
      return pt.groups.errors.notActive;
    case 'INVITE_ALREADY_ACTIVE':
      return pt.groups.errors.alreadyActive;
    case 'CONCURRENT_CHANGE':
      return pt.groups.errors.concurrent;
    case 'IDEMPOTENCY_WAIT_TIMEOUT':
      return pt.groups.errors.wait;
    case 'IDEMPOTENCY_CONFLICT':
      return pt.groups.errors.conflict;
    case 'IDEMPOTENCY_EXPIRED':
      return pt.groups.errors.expiredRequest;
    default:
      return pt.groups.errors.generic;
  }
}
