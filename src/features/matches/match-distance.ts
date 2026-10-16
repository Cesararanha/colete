// The distance from the person to the match place, computed on the device.
// The position comes from use-device-location.ts and stays in memory: it is
// never sent, stored, logged or put in a URL.

const EARTH_RADIUS_M = 6_371_008.8;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle (haversine) distance in metres. */
export function distanceInMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const dLat = radians(to.latitude - from.latitude);
  const dLon = radians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** "a 850 m de você", "a 3,2 km de você", "a 120 km de você". */
export function distanceText(meters: number): string {
  if (meters < 1000) return `a ${Math.max(10, Math.round(meters / 10) * 10)} m de você`;
  const km = meters / 1000;
  if (km >= 100) return `a ${Math.round(km).toLocaleString('pt-BR')} km de você`;
  const tenths = Math.round(km * 10) / 10;
  return `a ${tenths.toFixed(1).replace('.', ',')} km de você`;
}
