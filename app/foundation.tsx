import { pt } from '@/lib/i18n/pt';
import type { Metadata } from 'expo-router/server';
import { FoundationScreen } from '@/features/bootstrap/FoundationScreen';

export default FoundationScreen;

export function generateMetadata(): Metadata {
  return { title: pt.app.name };
}
