import type { Metadata } from 'expo-router/server';
import { useLocalSearchParams } from 'expo-router';

import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { GroupsListScreen } from '@/features/groups/GroupsListScreen';
import { pt } from '@/lib/i18n/pt';

export default function GroupsRoute() {
  const { deleted, left, missing, requested } = useLocalSearchParams<{
    deleted?: string;
    left?: string;
    missing?: string;
    requested?: string;
  }>();
  return (
    <AuthGateScreen
      // Grupos shows only its title and scoreboard: no description.
      page={{ description: '', title: pt.groups.list.title }}
      renderAuthenticated={(profile) => (
        <GroupsListScreen
          deleted={deleted === '1'}
          left={left === '1'}
          missing={missing === '1'}
          profile={profile}
          requested={requested === '1'}
        />
      )}
    />
  );
}

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.groups.list.title) };
}
