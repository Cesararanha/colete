import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

test('real local server: missing assets are 404/no-store; SPA and existing hashed assets still work', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'colete-staging-server-'));
  let child;
  try {
    await mkdir(path.join(directory, 'dist/_expo/static/js/web'), { recursive: true });
    await mkdir(path.join(directory, '.expo'));
    await writeFile(
      path.join(directory, 'dist/index.html'),
      '<html>Fixture<script>abc</script></html>',
    );
    await writeFile(path.join(directory, 'dist/_expo/static/js/web/existing.js'), 'export {};');
    await writeFile(
      path.join(directory, '.expo/staging-local.json'),
      JSON.stringify({ origin: 'https://api.example.invalid' }),
    );
    child = spawn(process.execPath, [path.resolve('scripts/serve-staging-local.mjs')], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => {
        if (data.toString().includes('Local staging headers server ready')) resolve();
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`server exited before ready: ${code}`)));
    });
    for (const pathname of [
      '/_expo/static/js/web/missing.js',
      '/icons/missing.png',
      '/assets/missing.bin',
      '/favicon.ico',
    ]) {
      const response = await fetch('http://127.0.0.1:4173' + pathname);
      assert.equal(response.status, 404, pathname);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(!(await response.text()).includes('<html>'));
    }
    const asset = await fetch('http://127.0.0.1:4173/_expo/static/js/web/existing.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.match(asset.headers.get('content-type'), /javascript/);
    const spa = await fetch('http://127.0.0.1:4173/grupos/fixture');
    assert.equal(spa.status, 200);
    assert.equal(spa.headers.get('cache-control'), 'no-store');
    assert.match(await spa.text(), /Fixture/);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
