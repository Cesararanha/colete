import { describe, expect, it } from 'vitest';

import type { MatchOccupancy } from '../../lib/api';
import {
  endsNextDay,
  matchCardState,
  matchesInNextWeek,
  matchPassesFilter,
  matchWeek,
} from './match-card-state';

const occupancy = (
  confirmed: number,
  viewer: MatchOccupancy['viewer_status'],
  waitlist = 0,
): MatchOccupancy => ({
  confirmed_count: confirmed,
  match_id: 'm',
  viewer_status: viewer,
  waitlist_count: waitlist,
});

describe('matchCardState', () => {
  it('says "Você vai" in green for a confirmed viewer', () => {
    expect(matchCardState(occupancy(12, 'starter'), 14)).toMatchObject({
      bar: 'positive',
      chip: { label: 'Você vai', tone: 'positive' },
      full: false,
    });
  });

  it('says "Na espera" in orange for the waitlist, even on a full match', () => {
    expect(matchCardState(occupancy(14, 'waitlist', 2), 14)).toMatchObject({
      bar: 'warning',
      chip: { label: 'Na espera', tone: 'warning' },
      full: true,
    });
  });

  it('counts the open slots in blue for a viewer who is out', () => {
    expect(matchCardState(occupancy(6, 'out'), 14).chip).toEqual({
      label: '8 vagas abertas',
      tone: 'info',
    });
    expect(matchCardState(occupancy(13, 'out'), 14).chip?.label).toBe('1 vaga aberta');
  });

  it('has no chip on a full match the viewer is out of, and an orange bar', () => {
    expect(matchCardState(occupancy(14, 'out'), 14)).toEqual({
      bar: 'warning',
      chip: null,
      full: true,
      ratio: 1,
    });
  });

  it('shows nothing before the occupancy is read', () => {
    expect(matchCardState(undefined, 14)).toEqual({ bar: null, chip: null, full: false, ratio: 0 });
  });
});

describe('matchPassesFilter', () => {
  const match = { field_slots: 10 };
  it('keeps every match under Todos, read or not', () => {
    expect(matchPassesFilter('all', match, undefined)).toBe(true);
  });
  it('keeps confirmed and waiting under Vou jogar', () => {
    expect(matchPassesFilter('playing', match, occupancy(10, 'starter'))).toBe(true);
    expect(matchPassesFilter('playing', match, occupancy(10, 'waitlist'))).toBe(true);
    expect(matchPassesFilter('playing', match, occupancy(3, 'out'))).toBe(false);
  });
  it('keeps only matches with a free slot under Com vaga', () => {
    expect(matchPassesFilter('open', match, occupancy(9, 'starter'))).toBe(true);
    expect(matchPassesFilter('open', match, occupancy(10, 'out'))).toBe(false);
    expect(matchPassesFilter('open', match, undefined)).toBe(false);
  });
});

describe('matchWeek', () => {
  // Saturday 17 October 2026, 15:00 in São Paulo.
  const now = new Date('2026-10-17T18:00:00Z');
  const zone = 'America/Sao_Paulo';
  it('puts the rest of the week, through Sunday, in this week', () => {
    expect(matchWeek('2026-10-17T23:00:00Z', zone, now)).toBe('this');
    expect(matchWeek('2026-10-19T02:30:00Z', zone, now)).toBe('this'); // Sun 23:30 local
  });
  it('starts the next week on Monday, in the match time zone', () => {
    expect(matchWeek('2026-10-19T03:30:00Z', zone, now)).toBe('next'); // Mon 00:30 local
    expect(matchWeek('2026-10-25T23:00:00Z', zone, now)).toBe('next'); // Sun 20:00 local
    expect(matchWeek('2026-10-26T23:00:00Z', zone, now)).toBe('later');
  });
});

describe('endsNextDay', () => {
  it('is true when the end falls on the next local day', () => {
    expect(endsNextDay('2026-10-23T01:00:00Z', '2026-10-23T04:00:00Z', 'America/Sao_Paulo')).toBe(
      true,
    );
    expect(endsNextDay('2026-10-23T22:00:00Z', '2026-10-23T23:30:00Z', 'America/Sao_Paulo')).toBe(
      false,
    );
  });
});

describe('matchesInNextWeek', () => {
  it('counts the matches that start within seven days', () => {
    const now = new Date('2026-10-17T18:00:00Z');
    expect(
      matchesInNextWeek(
        [
          { starts_at: '2026-10-18T23:00:00Z' },
          { starts_at: '2026-10-24T17:59:00Z' },
          { starts_at: '2026-10-24T18:01:00Z' },
        ],
        now,
      ),
    ).toBe(2);
  });
});
