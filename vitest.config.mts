import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The gateway's pure modules live beside the Edge Function they serve, so
    // that the function can import them with the explicit .ts specifiers Deno
    // needs. Layer one of the gateway proof runs here, without a network.
    include: ['src/**/*.test.ts', 'supabase/functions/**/*.test.ts'],
    environment: 'node',
    coverage: {
      enabled: false,
    },
  },
});
