import { pt } from '@/lib/i18n/pt';
import type { Metadata } from 'expo-router/server';
import { LoginScreen } from '@/features/auth/LoginScreen';

export default LoginScreen;

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.auth.login.title) };
}
