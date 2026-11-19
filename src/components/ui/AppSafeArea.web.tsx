import { View, type ViewProps } from 'react-native';

// SDK 58 streams HTML before hydration. CSS in +html applies the browser's
// safe-area insets without a measuring provider interrupting that stream.
const safeAreaMarker = { dataSet: { safeArea: 'true' } } as object;

export function AppSafeArea(props: ViewProps) {
  return <View {...props} {...safeAreaMarker} />;
}
