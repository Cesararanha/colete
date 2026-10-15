import { Linking, Platform } from 'react-native';

import type { MatchSummary } from '@/lib/api';

import { mapUrl } from './match-format';

/**
 * Builds the URL at the press and opens it outside the app. On the web the new
 * tab gets noopener and noreferrer: no opener handle, no Referer.
 */
export function openMatchMap(
  match: Pick<MatchSummary, 'latitude' | 'longitude' | 'location_address' | 'location_name'>,
): void {
  const url = mapUrl(match);
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  void Linking.openURL(url);
}
