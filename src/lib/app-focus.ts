import { focusManager } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';

// The 30 s refresh (LIVE_REFRESH_MS, HX-003) never reads in the background: on
// the web the query cache follows the page's visibility by itself; on a phone
// it has to be told when the app leaves and comes back to the front.
if (Platform.OS !== 'web') {
  focusManager.setEventListener((handleFocus) => {
    const subscription = AppState.addEventListener('change', (state) =>
      handleFocus(state === 'active'),
    );
    return () => subscription.remove();
  });
}
