import { pt } from '@/lib/i18n/pt';
import type { Metadata } from 'expo-router/server';
import { DesignSystemScreen } from '@/features/design-system/DesignSystemScreen';

export default DesignSystemScreen;

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.designSystem.title) };
}
