// Disposable direct HTTP entry to the production Edge sources. No Kong,
// request rewriting, reverse proxy, CORS shim or fake production handler.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const root = process.cwd();
const docker = (args, options = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });

export function localCorsEnvironment() {
  const output = execFileSync(
    path.join(root, 'node_modules/.bin/supabase'),
    ['status', '-o', 'env'],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    },
  );
  const read = (name) => {
    const value = output.match(new RegExp(`^${name}="([^"]+)"$`, 'm'))?.[1];
    assert.ok(value, `local stack missing ${name}`);
    return value;
  };
  const result = {
    apiUrl: read('API_URL'),
    dbUrl: read('DB_URL'),
    publishableKey: read('PUBLISHABLE_KEY'),
    secretKey: read('SECRET_KEY'),
  };
  assert.equal(new URL(result.apiUrl).hostname, '127.0.0.1');
  assert.equal(new URL(result.dbUrl).hostname, '127.0.0.1');
  return result;
}

export async function startDirectEdge(overrides = {}) {
  const original = JSON.parse(docker(['inspect', 'supabase_edge_runtime_colete']))[0];
  assert.equal(original.Config.WorkingDir, root, 'start the Colete stack from this worktree');
  assert.ok(original.NetworkSettings.Networks.supabase_network_colete);
  const env = Object.fromEntries(
    original.Config.Env.map((entry) => {
      const equals = entry.indexOf('=');
      return [entry.slice(0, equals), entry.slice(equals + 1)];
    }),
  );
  // CLI function-level configuration must not override a test's deployment
  // env. All four entrypoints and verifyJWT flags remain the CLI's originals.
  const config = JSON.parse(env.SUPABASE_INTERNAL_FUNCTIONS_CONFIG);
  for (const item of Object.values(config)) item.env = {};
  env.SUPABASE_INTERNAL_FUNCTIONS_CONFIG = JSON.stringify(config);
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  assert.ok(
    ['http://kong:8000', 'http://supabase_kong_colete:8000'].includes(env.SUPABASE_URL),
    'only the Colete Docker network is allowed',
  );
  await mkdir(path.join(root, '.expo'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.expo/cors-direct-'));
  const name = `colete_cors_direct_${process.pid}`;
  let created = false;
  let child;
  const stop = async () => {
    if (created) {
      docker(['rm', '--force', name]);
      created = false;
    }
    child?.kill();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    docker(['cp', 'supabase_edge_runtime_colete:/root/index.ts', path.join(directory, 'index.ts')]);
    const args = [
      'create',
      '--name',
      name,
      '--entrypoint',
      'sh',
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '--env',
      'HOME=/root',
      '--env',
      'DENO_DIR=/root/.cache/deno',
      '--workdir',
      root,
      '--network',
      'supabase_network_colete',
      '--publish',
      '127.0.0.1::8081',
      '--volume',
      `${directory}:/root`,
      '--volume',
      `${root}/supabase/functions:${root}/supabase/functions:ro`,
    ];
    for (const key of Object.keys(env)) args.push('--env', key);
    args.push(original.Config.Image, ...original.Config.Cmd);
    // Values travel through the child environment, never through argv/logs.
    docker(args, { env: { ...env } });
    created = true;
    child = spawn('docker', ['start', '--attach', name], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () => reject(new Error('direct Edge did not report readiness')),
        10000,
      );
      const exited = () => {
        clearTimeout(timer);
        reject(new Error('direct Edge stopped before readiness'));
      };
      child.once('error', exited);
      child.once('exit', exited);
      const inspect = (buffer) => {
        output = (output + buffer.toString()).slice(-4096);
        if (output.includes('Serving functions on')) {
          clearTimeout(timer);
          child.removeListener('exit', exited);
          resolve();
        }
      };
      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
    });
    const port = docker(['port', name, '8081/tcp']).trim().split(':').at(-1);
    assert.match(port, /^\d+$/);
    await writeFile(path.join(directory, 'origin'), `http://127.0.0.1:${port}`);
    return { url: `http://127.0.0.1:${port}`, stop };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'direct runtime setup and cleanup failed');
    }
    throw error;
  }
}
