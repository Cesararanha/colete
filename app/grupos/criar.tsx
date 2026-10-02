import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { CreateGroupScreen } from '@/features/groups/CreateGroupScreen';
import { pt } from '@/lib/i18n/pt';

export default function CreateGroupRoute() {
  return (
    <AuthGateScreen page={pt.groups.create} renderAuthenticated={() => <CreateGroupScreen />} />
  );
}
