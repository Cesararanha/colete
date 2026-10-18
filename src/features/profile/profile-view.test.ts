import type { Session } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { pt } from '../../lib/i18n/pt';

import {
  accessMethodSentence,
  linkedProviders,
  profileStats,
  profileSummary,
} from './profile-view';

const profile = {
  id: '018f2b8e-7a4c-7d3e-9b1a-1c2d3e4f5a6b',
  name: 'Ana Souza',
  nickname: null,
  position: 'midfielder',
  dominant_foot: null,
  shirt_number: 0,
} as const;

function sessionWith(user: Record<string, unknown>): Session {
  return {
    user: { app_metadata: {}, identities: [], ...user },
  } as unknown as Session;
}

describe('profile read mode', () => {
  it('shows every field as text and says an absent value in words', () => {
    expect(profileSummary(profile).map(({ key, value, empty }) => [key, value, empty])).toEqual([
      ['name', 'Ana Souza', false],
      ['nickname', pt.profile.empty.nickname, true],
      ['position', 'Meio-campista', false],
      ['dominant-foot', pt.profile.empty.dominantFoot, true],
      // Zero is a real shirt number, not an absent one.
      ['shirt-number', '0', false],
    ]);
  });
});

describe('profile blocks (prévia aprovada)', () => {
  it('gives Posição, Perna and Camisa, each absent value in words and muted', () => {
    expect(
      profileStats(profile).map(({ key, label, value, empty }) => [key, label, value, empty]),
    ).toEqual([
      ['position', 'Posição', 'Meio-campista', false],
      ['dominant-foot', 'Perna', pt.profile.empty.dominantFoot, true],
      ['shirt-number', 'Camisa', '0', false],
    ]);
  });
});

describe('sign-in method on the privacy screen', () => {
  it('says "e-mail e senha" for a password account', () => {
    const providers = linkedProviders(sessionWith({ identities: [{ provider: 'email' }] }));
    expect(providers).toEqual(['email']);
    expect(accessMethodSentence(providers)).toBe('Você entra com e-mail e senha.');
  });

  it('names every real provider once, from identities and metadata alike', () => {
    const providers = linkedProviders(
      sessionWith({
        app_metadata: { providers: ['email', 'google', 42] },
        identities: [{ provider: 'google' }],
      }),
    );
    expect(providers).toEqual(['google', 'email']);
    expect(accessMethodSentence(providers)).toBe('Você entra com Google ou com e-mail e senha.');
    expect(accessMethodSentence(['apple'])).toBe('Você entra com apple.');
  });

  it('falls back to the single metadata provider and admits when nothing is readable', () => {
    expect(linkedProviders(sessionWith({ app_metadata: { provider: 'email' } }))).toEqual([
      'email',
    ]);
    expect(linkedProviders(sessionWith({}))).toEqual([]);
    expect(accessMethodSentence([])).toBe(pt.privacy.access.unavailable);
  });
});
