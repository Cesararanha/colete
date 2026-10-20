import type { MemberRating } from '@/lib/api';

/** The members still without a rating, the ones the draw will refuse. */
export function unratedCount(members: readonly MemberRating[] | null | undefined): number {
  return (members ?? []).filter((member) => member.stars === null).length;
}

/** Confirmed players of a match the organization still has to rate. */
export function unratedAmong(
  members: readonly MemberRating[] | null | undefined,
  profileIds: readonly (string | null)[],
): number {
  const rated = new Map((members ?? []).map((member) => [member.profile_id, member.stars]));
  return profileIds.filter(
    (id): id is string => id !== null && rated.has(id) && rated.get(id) === null,
  ).length;
}

/** "18/10" in the viewer's zone: when the rating last changed. */
export function changedOn(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(date);
}
