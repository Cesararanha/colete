import { pt } from '@/lib/i18n/pt';
import type { Metadata } from 'expo-router/server';
import { SignUpScreen } from '@/features/auth/SignUpScreen';

export default SignUpScreen;

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.auth.signup.title) };
}
