import type pg from 'pg';
export function corsFixture(): Promise<{
  env: { apiUrl: string; dbUrl: string; publishableKey: string; secretKey: string };
  db: pg.Client;
  actor(
    url: string,
  ): Promise<{ email: string; password: string; token: string; profileId: string; userId: string }>;
  close(): Promise<void>;
}>;
