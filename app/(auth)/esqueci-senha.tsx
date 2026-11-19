import { pt } from '@/lib/i18n/pt';
import type { Metadata } from 'expo-router/server';
import { ForgotPasswordScreen } from '@/features/auth/ForgotPasswordScreen';

export default ForgotPasswordScreen;

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.auth.forgot.title) };
}
