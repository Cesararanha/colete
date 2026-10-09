export function localCorsEnvironment(): {
  apiUrl: string;
  dbUrl: string;
  publishableKey: string;
  secretKey: string;
};
export function startDirectEdge(
  overrides?: Record<string, string | undefined>,
): Promise<{ url: string; stop(): Promise<void> }>;
