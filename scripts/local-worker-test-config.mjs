// Public, deterministic local-test material. It is built rather than stored as
// a credential and is never used outside the disposable Supabase stack.
export function localWorkerCronSecret() {
  return Array.from({ length: 48 }, (_, index) =>
    ((index * 29 + 17) % 256).toString(16).padStart(2, '0'),
  ).join('');
}
