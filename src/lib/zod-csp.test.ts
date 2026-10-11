import { expect, it, vi } from 'vitest';

it('initializes frontend schemas and uses login, profile, group and invite without Function calls', async () => {
  // A fresh module graph also resets Zod's cached capability probe.
  vi.resetModules();
  const FunctionSpy = vi.spyOn(globalThis, 'Function');
  try {
    const auth = await import('../features/auth/schemas');
    const profile = await import('./profile-schema');
    const privacy = await import('./privacy-schema');
    await import('../features/profile/deletion-protocol');
    const groups = await import('../features/groups/group-name-schema');
    const invite = await import('../features/groups/join-fragment');
    expect(
      auth.loginSchema.safeParse({ email: 'test@example.invalid', password: 'fixture' }).success,
    ).toBe(true);
    expect(auth.loginSchema.safeParse({ email: 'invalid', password: '' }).success).toBe(false);
    expect(profile.profileSchema.safeParse({ name: 'Pessoa fictícia' }).success).toBe(true);
    expect(profile.profilePatchSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(groups.groupCreationSchema.safeParse({ name: 'Grupo fictício' }).success).toBe(true);
    expect(groups.groupCreationSchema.safeParse({ name: '\u200b' }).success).toBe(false);
    expect(privacy.deletionRequestProjectionSchema.safeParse({}).success).toBe(false);
    // Invites use the fragment parser, not a Zod schema; exercise the actual frontend path.
    const fakeWindow = {
      __COLETE_INVITE_TOKEN__: 'fictitious-invite',
      location: { pathname: '/join', hash: '' },
    };
    vi.stubGlobal('window', fakeWindow);
    expect(invite.hasPendingInvite()).toBe(true);
    expect(invite.consumeInviteFragment()).toBe('fictitious-invite');
    expect(invite.hasPendingInvite()).toBe(false);
    expect(FunctionSpy).toHaveBeenCalledTimes(0);
  } finally {
    vi.unstubAllGlobals();
    FunctionSpy.mockRestore();
  }
});
