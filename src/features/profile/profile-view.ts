import type { Session } from '@supabase/supabase-js';

import type { OwnProfile } from '../../lib/api';
import { pt } from '../../lib/i18n/pt';

function optionLabel<T extends string>(
  options: readonly { label: string; value: T }[],
  value: T | null,
): string | null {
  return options.find((option) => option.value === value)?.label ?? null;
}

/** The read mode: every field as text, an absent value said in words. */
export function profileSummary(profile: OwnProfile) {
  return [
    { key: 'name', label: pt.profile.fields.name, value: profile.name, empty: false },
    {
      key: 'nickname',
      label: pt.profile.fields.nickname,
      value: profile.nickname ?? pt.profile.empty.nickname,
      empty: profile.nickname === null,
    },
    {
      key: 'position',
      label: pt.profile.fields.position,
      value: optionLabel(pt.profile.positionOptions, profile.position) ?? pt.profile.empty.position,
      empty: profile.position === null,
    },
    {
      key: 'dominant-foot',
      label: pt.profile.fields.dominantFoot,
      value:
        optionLabel(pt.profile.footOptions, profile.dominant_foot) ?? pt.profile.empty.dominantFoot,
      empty: profile.dominant_foot === null,
    },
    {
      key: 'shirt-number',
      label: pt.profile.fields.shirtNumber,
      value:
        profile.shirt_number === null ? pt.profile.empty.shirtNumber : String(profile.shirt_number),
      empty: profile.shirt_number === null,
    },
  ] as const;
}

/**
 * The three blocks of the profile (prévia aprovada): Posição, Perna and
 * Camisa, each value in its tone or said absent in words.
 */
export function profileStats(profile: OwnProfile) {
  return [
    {
      key: 'position',
      label: pt.profile.stats.position,
      value: optionLabel(pt.profile.positionOptions, profile.position) ?? pt.profile.empty.position,
      empty: profile.position === null,
      tone: 'info',
    },
    {
      key: 'dominant-foot',
      label: pt.profile.stats.foot,
      value:
        optionLabel(pt.profile.footOptions, profile.dominant_foot) ?? pt.profile.empty.dominantFoot,
      empty: profile.dominant_foot === null,
      tone: 'positive',
    },
    {
      key: 'shirt-number',
      label: pt.profile.stats.shirt,
      value:
        profile.shirt_number === null ? pt.profile.empty.shirtNumber : String(profile.shirt_number),
      empty: profile.shirt_number === null,
      tone: 'digit',
    },
  ] as const;
}

/** Every distinct sign-in method of this session's Auth user, read from the session only. */
export function linkedProviders(session: Session): string[] {
  const identityProviders = (session.user.identities ?? []).map((identity) => identity.provider);
  const metadataProviders = Array.isArray(session.user.app_metadata['providers'])
    ? session.user.app_metadata['providers'].filter(
        (provider): provider is string => typeof provider === 'string',
      )
    : [];
  const providers = [...new Set([...identityProviders, ...metadataProviders])];
  if (providers.length === 0 && typeof session.user.app_metadata['provider'] === 'string') {
    providers.push(session.user.app_metadata['provider']);
  }
  return providers;
}

/** "Você entra com e-mail e senha.", or the real providers when there are others. */
export function accessMethodSentence(providers: readonly string[]): string {
  if (providers.length === 0) return pt.privacy.access.unavailable;
  return pt.privacy.access.sentence(
    providers.map((provider) => {
      if (provider === 'email') return pt.privacy.access.email;
      if (provider === 'google') return pt.privacy.access.google;
      return provider;
    }),
  );
}
