import { HomeScreen } from '@/features/bootstrap/HomeScreen';
import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { isSmokeMode } from '@/lib/runtime';

export default function IndexScreen() {
  return isSmokeMode() ? <HomeScreen /> : <AuthGateScreen />;
}
