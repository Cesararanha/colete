import { pt } from '@/lib/i18n/pt';
import type { Metadata } from 'expo-router/server';
import { AuthGateScreen } from '@/features/auth/AuthGateScreen';

export default function ProfileRoute() {
  return <AuthGateScreen />;
}

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.profile.title) };
}
