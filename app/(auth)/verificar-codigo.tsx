import { pt } from '@/lib/i18n/pt';
import type { Metadata } from 'expo-router/server';
import { VerifyCodeScreen } from '@/features/auth/VerifyCodeScreen';

export default VerifyCodeScreen;

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.auth.otp.title) };
}
