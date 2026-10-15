// The device position for the match place, by expo-location (navigator
// geolocation in the PWA, which needs Permissions-Policy geolocation=(self)).
// The position is rounded to 4 decimals at once: the precise reading never
// reaches state, a log or an error message.

import * as Location from 'expo-location';
import { useCallback, useRef, useState } from 'react';

import { roundCoordinate } from './match-form';

export type DeviceLocation =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'denied' }
  | { status: 'unavailable' }
  | { status: 'found'; latitude: number; longitude: number };

export function useDeviceLocation() {
  const [location, setLocation] = useState<DeviceLocation>({ status: 'idle' });
  const attempt = useRef(0);

  const request = useCallback(async () => {
    const current = ++attempt.current;
    setLocation({ status: 'requesting' });
    let next: DeviceLocation;
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        next = { status: 'denied' };
      } else {
        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        next = {
          status: 'found',
          latitude: roundCoordinate(position.coords.latitude),
          longitude: roundCoordinate(position.coords.longitude),
        };
      }
    } catch {
      // A browser that blocks geolocation by policy, a timeout or no signal:
      // the reason is not shown, only that the position is not available.
      next = { status: 'unavailable' };
    }
    if (current === attempt.current) setLocation(next);
  }, []);

  const clear = useCallback(() => {
    attempt.current += 1;
    setLocation({ status: 'idle' });
  }, []);

  return { location, request, clear };
}
