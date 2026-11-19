import type { Metadata } from 'expo-router/server';
import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { CreateGroupScreen } from '@/features/groups/CreateGroupScreen';
import { pt } from '@/lib/i18n/pt';

export default function CreateGroupRoute() {
  return (
    <AuthGateScreen page={pt.groups.create} renderAuthenticated={() => <CreateGroupScreen />} />
  );
}

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.groups.create.title) };
}
