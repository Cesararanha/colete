import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('discards the document once when Auth, the manual action and the broadcast sign out', async () => {
  vi.resetModules();
  const replace = vi.fn();
  vi.stubGlobal('window', { location: { replace } });
  const { reloadAfterSignOut } = await import('./session-broadcast');
  reloadAfterSignOut();
  reloadAfterSignOut();
  reloadAfterSignOut();
  expect(replace).toHaveBeenCalledExactlyOnceWith('/entrar');
});
