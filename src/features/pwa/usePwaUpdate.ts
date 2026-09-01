import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

type ColetePwaBridge = {
  activateUpdate: () => boolean;
  hasWaitingWorker: () => boolean;
};

declare global {
  interface Window {
    __COLETE_PWA__?: ColetePwaBridge;
  }
}

export function usePwaUpdate() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') {
      return undefined;
    }

    const readState = () => setAvailable(window.__COLETE_PWA__?.hasWaitingWorker() ?? false);
    window.addEventListener('colete:pwa-update', readState);
    readState();

    return () => window.removeEventListener('colete:pwa-update', readState);
  }, []);

  const activate = useCallback(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.__COLETE_PWA__?.activateUpdate();
    }
  }, []);

  return { activate, available };
}
