export const SYNTHETIC_IDENTITY = 'synthetic-user-001';

export const isSmokeMode = () =>
  process.env.EXPO_PUBLIC_SMOKE_MODE === 'true' || process.env.NODE_ENV === 'development';
