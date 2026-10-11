import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ configured: false, builders: 0 }));
vi.mock('zod', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zod')>();
  const z = new Proxy(actual.z, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'config')
        return (options: Parameters<typeof actual.z.config>[0]) => {
          state.configured = options?.jitless === true;
          return actual.z.config(options);
        };
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        expect(
          state.configured,
          `Zod builder ${String(property)} ran before jitless configuration`,
        ).toBe(true);
        state.builders += 1;
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { ...actual, z };
});

it('configures before creating any of the frontend schemas, including group creation', async () => {
  await import('../features/auth/schemas');
  await import('./privacy-schema');
  await import('../features/profile/deletion-protocol');
  await import('../features/groups/group-name-schema');
  expect(state.builders).toBeGreaterThan(20);
});

it('all frontend imports use the configured facade; no direct Zod entrypoint can bypass it', () => {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory()
        ? walk(file)
        : /\.tsx?$/.test(file) && !file.includes('.test.')
          ? [file]
          : [];
    });
  const direct = [...walk('src'), ...walk('app')].filter((file) =>
    /(?:from\s*|import\s*\(|require\s*\()(['"])zod(?:\/[^'"]*)?\1/.test(readFileSync(file, 'utf8')),
  );
  expect(direct).toEqual([path.join('src', 'lib', 'zod.ts')]);
});
