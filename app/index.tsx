import { pt } from '@/lib/i18n/pt';
import type { Metadata } from 'expo-router/server';
import { HomeScreen } from '@/features/bootstrap/HomeScreen';
import { isSmokeMode } from '@/lib/runtime';
import { Redirect } from 'expo-router';

export default function IndexScreen() {
  return isSmokeMode() ? <HomeScreen /> : <Redirect href="/grupos" />;
}

export function generateMetadata(): Metadata {
  return { title: pt.app.name };
}
