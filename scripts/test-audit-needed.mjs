import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { needsAudit } from './audit-needed.mjs';

const selectorPath = fileURLToPath(new URL('./audit-needed.mjs', import.meta.url));
const selectorSource = readFileSync(selectorPath, 'utf8');
const require = createRequire(import.meta.url);
const workflow = require('yaml').parse(
  readFileSync(new URL('../.github/workflows/validation.yml', import.meta.url), 'utf8'),
);
const trustedStep = workflow.jobs['repository-guardrails'].steps.find(
  (step) => step.id === 'audit-needed',
);
const context = {
  eventName: 'pull_request',
  baseRef: 'main',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
};
const regularTree = `100644 blob ${'c'.repeat(40)}\tREADME.md\0`;
const fakeGit = (files) => (_command, args) => ({
  status: 0,
  stdout: args[0] === 'diff' ? files.join('\0') + '\0' : regularTree,
});
const decide = (files) => needsAudit({ ...context, git: fakeGit(files) });

// Independent contract list: do not derive test cases from the selector's list.
const protectedPaths = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'patches/a.patch',
  '.github/workflows/example.yml',
  '.github/actions/local/action.yml',
  'deno.json',
  'deno.jsonc',
  'import_map.json',
  'deno.lock',
  'audit-exceptions.json',
  'scripts/audit-high.mjs',
  'scripts/test-audit-high.mjs',
  'scripts/audit-needed.mjs',
  'scripts/test-audit-needed.mjs',
  'scripts/fixtures/audit-example.json',
];
for (const file of ['app/index.tsx', 'supabase/migrations/test.sql', 'docs/test.md'])
  test(`dispensa ${file}`, () => assert.equal(decide([file]).required, false));
for (const file of protectedPaths) {
  test(`exige ${file}`, () => assert.equal(decide([file]).required, true));
  test(`exige subpasta tools/nested/${file}`, () =>
    assert.equal(decide([`tools/nested/${file}`]).required, true));
}
for (const [name, overrides] of [
  ['base ausente', { base: undefined }],
  ['erro git', { git: () => ({ status: 128, stdout: '' }) }],
  [
    'exceção git',
    {
      git: () => {
        throw new Error('git');
      },
    },
  ],
  ['saída vazia', { git: () => ({ status: 0, stdout: '' }) }],
  [
    'nome vazio entre arquivos (R2c)',
    {
      git: (_c, args) => ({
        status: 0,
        stdout: args[0] === 'diff' ? 'docs/a.md\0\0' : regularTree,
      }),
    },
  ],
  [
    'árvore indisponível',
    {
      git: (_c, args) =>
        args[0] === 'diff' ? { status: 0, stdout: 'docs/a.md\0' } : { status: 128, stdout: '' },
    },
  ],
  [
    'árvore malformada',
    {
      git: (_c, args) => ({ status: 0, stdout: args[0] === 'diff' ? 'docs/a.md\0' : 'invalid\0' }),
    },
  ],
  ['evento desconhecido (R4a)', { eventName: 'merge_group' }],
])
  test(name, () =>
    assert.equal(
      needsAudit({ ...context, git: fakeGit(['docs/a.md']), ...overrides }).required,
      true,
    ),
  );

function repository(body, { mainSelector = true } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'audit-needed-'));
  const dir = join(scratch, 'repository');
  const runner = join(scratch, 'runner');
  mkdirSync(dir);
  mkdirSync(runner);
  mkdirSync(join(dir, 'scripts'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (file, content) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  };
  const commit = () => {
    git('add', '-A');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Audit Test');
    git('config', 'user.email', 'audit-test@example.invalid');
    write('README.md', 'base\n');
    if (mainSelector) write('scripts/audit-needed.mjs', selectorSource);
    const base = commit();
    git('update-ref', 'refs/remotes/origin/main', base);
    git('checkout', '-qb', 'pr');
    body({ dir, runner, git, write, commit, base });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
function execute(
  fixture,
  {
    trusted = false,
    base = fixture.base,
    baseRef = 'main',
    eventName = 'pull_request',
    eventContent,
    missingEvent = false,
    missingOutput = false,
    gitMissing = false,
    expectedStatus = 0,
  } = {},
) {
  const eventPath = join(fixture.runner, 'event.json');
  const outputPath = join(fixture.runner, 'output');
  writeFileSync(
    eventPath,
    eventContent ??
      JSON.stringify({
        pull_request: {
          base: { sha: base, ref: baseRef },
          head: { sha: fixture.git('rev-parse', 'HEAD') },
        },
      }),
  );
  writeFileSync(outputPath, '');
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: missingEvent ? join(fixture.runner, 'missing') : eventPath,
    GITHUB_OUTPUT: outputPath,
    RUNNER_TEMP: fixture.runner,
    PR_BASE_REF: baseRef,
    PR_BASE_SHA: base,
  };
  if (missingOutput) delete env.GITHUB_OUTPUT;
  if (gitMissing) env.PATH = '';
  const result = trusted
    ? spawnSync('bash', ['-e', '-c', trustedStep.run], { cwd: fixture.dir, env, encoding: 'utf8' })
    : spawnSync(process.execPath, [selectorPath], { cwd: fixture.dir, env, encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, result.stderr);
  return { output: readFileSync(outputPath, 'utf8'), log: result.stdout };
}

for (const [from, to] of [
  ['notes.md', 'package.json'],
  ['package.json', 'notes.md'],
])
  test(`rename ${from} → ${to} com git real`, () =>
    repository((f) => {
      f.write(from, '{}\n');
      const base = f.commit();
      renameSync(join(f.dir, from), join(f.dir, to));
      f.commit();
      assert.equal(execute(f, { base }).output, 'required=true\n');
    }));
for (const [name, options] of [
  ['evento ausente (R4b)', { missingEvent: true }],
  ['JSON inválido (R4b)', { eventContent: '{invalid' }],
  ['evento sem PR', { eventContent: '{}' }],
  ['evento desconhecido com SHAs válidos (R4a)', { eventName: 'merge_group' }],
  ['git ausente', { gitMissing: true }],
])
  test(`CLI exige: ${name}`, () =>
    repository((f) => {
      f.write('docs/a.md', 'only docs\n');
      f.commit();
      const result = execute(f, options);
      assert.equal(result.output, 'required=true\n');
      assert.match(result.log, /auditoria exigida:/);
    }));
test('CLI escreve true para arquivo protegido (R4c)', () =>
  repository((f) => {
    f.write('npm-shrinkwrap.json', '{}\n');
    f.commit();
    const result = execute(f);
    assert.equal(result.output, 'required=true\n');
    assert.match(result.log, /arquivo protegido alterado: npm-shrinkwrap.json/);
  }));
test('CLI base main e só .md dispensa', () =>
  repository((f) => {
    f.write('docs/a.md', 'only docs\n');
    f.commit();
    const result = execute(f);
    assert.equal(result.output, 'required=false\n');
    assert.match(result.log, /auditoria dispensada: nenhum arquivo de dependência alterado/);
  }));
test('CLI sem GITHUB_OUTPUT informa que a condição exige auditoria', () =>
  repository((f) => {
    f.write('docs/a.md', 'only docs\n');
    f.commit();
    const result = execute(f, { missingOutput: true });
    assert.equal(result.output, '');
    assert.match(result.log, /auditoria exigida: GITHUB_OUTPUT ausente; nenhuma saída gravada/);
    assert.doesNotMatch(result.log, /auditoria dispensada/);
  }));
for (const target of ['deps.json', '../outside.json'])
  test(`CLI head com symlink herdado ${target} exige`, () =>
    repository((f) => {
      f.write('deps.json', '{}\n');
      symlinkSync(target, join(f.dir, 'package.json'));
      const base = f.commit();
      f.write('docs/a.md', 'only docs\n');
      f.commit();
      const result = execute(f, { base });
      assert.equal(result.output, 'required=true\n');
      assert.match(result.log, /no head é link simbólico: package.json/);
    }));
test('CLI usa merge-base: só .md mesmo com main divergente (R2b)', () =>
  repository((f) => {
    f.write('docs/a.md', 'only docs\n');
    const head = f.commit();
    f.git('checkout', '-q', 'main');
    f.write('package-lock.json', '{}\n');
    const base = f.commit();
    f.git('checkout', '-q', head);
    assert.equal(execute(f, { base }).output, 'required=false\n');
  }));

test('workflow lê main e resiste ao seletor e teste adulterados no PR (R3c)', () =>
  repository((f) => {
    f.write(
      'scripts/audit-needed.mjs',
      "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.GITHUB_OUTPUT, 'required=false\\n');\n",
    );
    f.write(
      'scripts/test-audit-needed.mjs',
      "import test from 'node:test'; test('adjusted', () => {});\n",
    );
    f.commit();
    assert.equal(
      spawnSync(process.execPath, ['--test', 'scripts/test-audit-needed.mjs'], { cwd: f.dir })
        .status,
      0,
    );
    const result = execute(f, { trusted: true });
    assert.equal(result.output, 'required=true\n');
    assert.match(result.log, /arquivo protegido alterado:/);
  }));
test('workflow sem seletor no main exige sem executar o head (bootstrap #61)', () =>
  repository(
    (f) => {
      f.write('scripts/audit-needed.mjs', "throw new Error('head must not execute');\n");
      f.commit();
      const result = execute(f, { trusted: true });
      assert.equal(result.output, 'required=true\n');
      assert.match(result.log, /seletor do SHA da base ausente ou indisponível/);
    },
    { mainSelector: false },
  ));
for (const baseRef of ['dep', 'Main', ''])
  test(`workflow rejeita base ${baseRef || 'ausente'} antes de executar seletor (N3)`, () =>
    repository((f) => {
      f.git('checkout', '-q', 'main');
      f.write('scripts/audit-needed.mjs', "throw new Error('selector must not execute');\n");
      const base = f.commit();
      f.git('checkout', '-q', 'pr');
      f.write('docs/a.md', 'only docs\n');
      f.commit();
      const result = execute(f, { trusted: true, baseRef, base, expectedStatus: 1 });
      assert.equal(result.output, '');
      assert.match(
        result.log,
        /Este PR precisa apontar para main\. Redirecione a base e rode a CI de novo\./,
      );
    }));
test('workflow main com só .md dispensa pela versão de main', () =>
  repository((f) => {
    f.write('docs/a.md', 'only docs\n');
    f.commit();
    assert.equal(execute(f, { trusted: true }).output, 'required=false\n');
  }));

test('workflow recusa seletor de main como symlink sem executar seu conteúdo', () =>
  repository((f) => {
    f.git('checkout', '-q', 'main');
    rmSync(join(f.dir, 'scripts/audit-needed.mjs'));
    symlinkSync('outside.mjs', join(f.dir, 'scripts/audit-needed.mjs'));
    const base = f.commit();
    f.git('update-ref', 'refs/remotes/origin/main', base);
    f.git('checkout', '-q', 'pr');
    f.write('docs/a.md', 'only docs\n');
    f.commit();
    const result = execute(f, { trusted: true, base });
    assert.equal(result.output, 'required=true\n');
    assert.match(result.log, /não regular/);
  }));

for (const file of [
  'PACKAGE-LOCK.JSON',
  'Package.json',
  'NPM-SHRINKWRAP.JSON',
  '.GITHUB/WORKFLOWS/ci.yml',
  'SCRIPTS/FIXTURES/AUDIT-x.json',
])
  test(`CLI e workflow exigem caixa diferente em subpasta: ${file} (N2)`, () =>
    repository((f) => {
      f.write(`tools/nested/${file}`, '{}\n');
      f.commit();
      assert.equal(execute(f).output, 'required=true\n');
      assert.equal(execute(f, { trusted: true }).output, 'required=true\n');
    }));

test('workflow usa SHA do evento apesar de tag e remote origin/main falsos (N4)', () =>
  repository((f) => {
    f.write('package-lock.json', '{}\n');
    const head = f.commit();
    f.git('checkout', '-qb', 'fake-main');
    f.write(
      'scripts/audit-needed.mjs',
      "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.GITHUB_OUTPUT, 'required=false\\n');\n",
    );
    const fake = f.commit();
    f.git('tag', 'origin/main', fake);
    f.git('update-ref', 'refs/remotes/origin/main', fake);
    f.git('checkout', '-q', head);
    const result = execute(f, { trusted: true });
    assert.equal(result.output, 'required=true\n');
    assert.match(result.log, /arquivo protegido alterado: package-lock.json/);
  }));

test('workflow vincula a cópia ao SHA da base no contexto do evento (N4)', () => {
  assert.equal(trustedStep.env.PR_BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.equal(trustedStep.env.PR_BASE_REF, '${{ github.event.pull_request.base.ref }}');
});
