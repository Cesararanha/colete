import { describe, expect, it } from 'vitest';

import { AppError, TransportError } from './api';
import { liveInterval, readProblem, refreshFailed, updatedAt } from './live-refresh';

const query = (dataUpdatedAt: number) => ({ dataUpdatedAt });

describe('the last reading of a screen (HX-003)', () => {
  it('is the oldest read of the screen, on the device clock', () => {
    const early = new Date(2030, 9, 14, 14, 31, 50).getTime();
    const late = new Date(2030, 9, 14, 14, 32, 10).getTime();
    expect(updatedAt([query(late), query(early)])).toBe('14:31');
  });

  it('ignores a query that has not read yet, and says nothing before any read', () => {
    const read = new Date(2030, 9, 14, 9, 5).getTime();
    expect(updatedAt([query(0), query(read)])).toBe('09:05');
    expect(updatedAt([query(0)])).toBeUndefined();
    expect(updatedAt([])).toBeUndefined();
  });

  it('writes midnight as 00, not 24', () => {
    expect(updatedAt([query(new Date(2030, 9, 15, 0, 7).getTime())])).toBe('00:07');
  });
});

const sessionRefused = new AppError('UNAUTHENTICATED', 'Entre novamente para continuar.');
const unavailable = new TransportError();

describe('when a screen reads by itself (rev89)', () => {
  it('reads every 30 s only in front and with a session (P2-1, P3-1)', () => {
    expect(liveInterval(true, null)).toBe(30_000);
    expect(liveInterval(true, unavailable)).toBe(30_000);
    expect(liveInterval(false, null)).toBe(false);
    expect(liveInterval(true, sessionRefused)).toBe(false);
  });

  it('keeps the large notice for the session and for an empty screen (P3-1, P3-2)', () => {
    expect(readProblem({ data: undefined, error: null, isError: false })).toBeUndefined();
    expect(readProblem({ data: undefined, error: unavailable, isError: true })).toBe('network');
    expect(readProblem({ data: ['x'], error: unavailable, isError: true })).toBeUndefined();
    expect(readProblem({ data: ['x'], error: sessionRefused, isError: true })).toBe('session');
    // "Racha não encontrado" is a read that found nothing: the network notice, not silence (conf89 N1).
    expect(readProblem({ data: null, error: unavailable, isError: true })).toBe('network');
  });

  it('says a failed read over data already shown in the time line, not for the session', () => {
    expect(refreshFailed([{ data: ['x'], error: unavailable, isError: true }])).toBe(true);
    expect(refreshFailed([{ data: undefined, error: unavailable, isError: true }])).toBe(false);
    expect(refreshFailed([{ data: null, error: unavailable, isError: true }])).toBe(false);
    expect(refreshFailed([{ data: ['x'], error: sessionRefused, isError: true }])).toBe(false);
    expect(refreshFailed([{ data: ['x'], error: null, isError: false }])).toBe(false);
  });
});
