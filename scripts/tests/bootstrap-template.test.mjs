import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertNewCheckoutDriftIsSafe,
  buildBootstrapPlan,
  classifyTarget,
  initializeApplicationRepository,
  isAuthenticationFailure,
  isConditionalAccessError,
  normalizeTarget,
  removeSafeChainIgnoreRules,
  selectAuthenticationStrategy,
  verifySafeChainRemoved,
} from '../bootstrap-template.mjs';

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(TEST_ROOT, '../..');
const temporaryDirectories = [];

function temporaryDirectory(prefix = 'symbis-bootstrap-test-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createTemplateFixture(installRecipe) {
  const root = temporaryDirectory('symbis-template-fixture-');
  mkdirSync(join(root, '.github'), { recursive: true });
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '# Fixture instructions\n');
  symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
  symlinkSync('../AGENTS.md', join(root, '.github', 'copilot-instructions.md'));
  symlinkSync('../.agents/skills', join(root, '.claude', 'skills'));
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(root, 'Makefile'), `install:\n\t${installRecipe}\n`);
  runGit(root, ['init', '-b', 'main']);
  runGit(root, ['config', 'user.name', 'Bootstrap Test']);
  runGit(root, ['config', 'user.email', 'bootstrap@example.invalid']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'fixture']);
  return root;
}

function gnuMakeAvailable() {
  for (const command of ['make', 'gmake']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (result.status === 0 && /^GNU Make\s+\d/m.test(result.stdout)) return true;
  }
  return false;
}

test('requires absolute targets and accepts an empty current directory by its absolute path', async () => {
  const empty = temporaryDirectory();
  const currentPlatform = process.platform === 'win32' ? 'win32' : 'darwin';
  assert.equal(normalizeTarget(empty, currentPlatform), empty);
  assert.equal(await classifyTarget(empty), 'new');
  assert.throws(() => normalizeTarget('.', currentPlatform), /absolute path/);
  assert.throws(() => normalizeTarget('Pizza', currentPlatform), /absolute path/);
  const filesystemRoot = process.platform === 'win32' ? 'C:\\' : '/';
  assert.throws(() => normalizeTarget(filesystemRoot, currentPlatform), /filesystem root/);
  assert.equal(normalizeTarget('C:\\Users\\developer\\Projects\\Pizza', 'win32'), 'C:\\Users\\developer\\Projects\\Pizza');
});

test('plans only missing prerequisites and does not require approval for installed tools', () => {
  const installed = {
    homebrew: 'installed', git: 'installed', node: 'installed', gnuMake: 'installed', azureCli: 'missing',
  };
  const plan = buildBootstrapPlan({
    platform: 'darwin',
    mode: 'new',
    target: '/Users/developer/Projects/Pizza',
    authStrategy: 'auto',
    systemState: installed,
    authState: { attempted: ['git-credential-manager'], selected: 'git-credential-manager', repositoryReadAccess: true },
  });
  assert.equal(plan.requiresSystemApproval, false);
  assert.equal(plan.auth.selected, 'git-credential-manager');
  assert.equal(plan.auth.repositoryReadAccess, true);
  assert.equal(plan.actions.some(({ id }) => id.startsWith('install-')), false);
  assert.equal(plan.actions.some(({ id }) => id === 'conditional-azure-cli-fallback'), false);

  const missingNode = buildBootstrapPlan({
    platform: 'darwin',
    mode: 'new',
    target: '/Users/developer/Projects/Pizza',
    systemState: { ...installed, node: 'upgradeRequired' },
  });
  assert.equal(missingNode.requiresSystemApproval, true);
  assert.ok(missingNode.actions.some(({ id }) => id === 'install-node'));
});

test('uses ordinary Git first and falls back to Azure CLI only for authentication failure', () => {
  let azureCalls = 0;
  const gitSuccess = selectAuthenticationStrategy({
    authStrategy: 'auto',
    gitCredentialProbe: () => ({ ok: true }),
    azureCliProbe: () => { azureCalls += 1; return { ok: true, token: 'not-used' }; },
  });
  assert.equal(gitSuccess.selected, 'git-credential-manager');
  assert.equal(azureCalls, 0);

  const fallback = selectAuthenticationStrategy({
    authStrategy: 'auto',
    gitCredentialProbe: () => ({ ok: false, authFailure: true, detail: '401' }),
    azureCliProbe: () => ({ ok: true, token: 'kept-in-memory', identity: { user: 'approved@example.com' } }),
  });
  assert.equal(fallback.selected, 'azure-cli');
  assert.deepEqual(fallback.attempted, ['git-credential-manager', 'azure-cli']);

  assert.throws(() => selectAuthenticationStrategy({
    authStrategy: 'auto',
    gitCredentialProbe: () => ({ ok: false, authFailure: false, detail: 'DNS lookup failed' }),
    azureCliProbe: () => { throw new Error('must not run'); },
  }), /before authentication/);

  assert.throws(() => selectAuthenticationStrategy({
    authStrategy: 'azure-cli',
    gitCredentialProbe: () => { throw new Error('must not run'); },
    azureCliProbe: () => ({ ok: false, message: 'token exists but repository returned 401' }),
  }), /repository returned 401/);
});

test('recognizes repository authorization and Conditional Access failures', () => {
  assert.equal(isAuthenticationFailure('fatal: Authentication failed (401)'), true);
  assert.equal(isAuthenticationFailure('remote: TF401019 repository access denied'), true);
  assert.equal(isAuthenticationFailure('network timeout'), false);
  assert.equal(isConditionalAccessError('AADSTS53003: Blocked by Conditional Access'), true);
});

test('rejects lockfile and unexpected drift while allowing known Safe Chain changes', () => {
  const allowed = ' M AGENTS.md\n D scripts/remove-safe-chain-setup.sh';
  assert.doesNotThrow(() => assertNewCheckoutDriftIsSafe(allowed, allowed));
  assert.throws(
    () => assertNewCheckoutDriftIsSafe(allowed, `${allowed}\n M package-lock.json`),
    /package-lock\.json changed during make install/,
  );
  assert.throws(
    () => assertNewCheckoutDriftIsSafe(allowed, `${allowed}\n M src/main.tsx`),
    /src\/main\.tsx changed unexpectedly/,
  );
});

test('removes Safe Chain ignore rules and verifies no setup remnants remain', () => {
  const root = temporaryDirectory();
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'AGENTS.md'), '# Project instructions\n');
  writeFileSync(join(root, '.gitignore'), [
    'node_modules/',
    '# Safe Chain (optional, project-local; see AGENTS.md -> "Safe Chain Project Setup")',
    '.safe-chain/',
    '.tools/',
    '',
  ].join('\n'));
  removeSafeChainIgnoreRules(join(root, '.gitignore'));
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.doesNotMatch(ignore, /safe-chain/i);
  assert.doesNotThrow(() => verifySafeChainRemoved(root));
});

test('restores original Git metadata when repository initialization fails', () => {
  const root = temporaryDirectory();
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'marker'), 'original\n');
  assert.throws(() => initializeApplicationRepository(root, {
    run: () => { throw new Error('simulated init failure'); },
  }), /original template Git metadata was restored/);
  assert.equal(readFileSync(join(root, '.git', 'marker'), 'utf8'), 'original\n');
  const backups = readdirSync(dirname(root)).filter((name) => name.startsWith(`.${basename(root)}.template-git-backup-`));
  assert.equal(backups.length, 0);
});

test('new mode validates installation before replacing template Git metadata', (context) => {
  if (process.platform === 'win32' || !gnuMakeAvailable()) {
    context.skip('fixture requires native symlinks and GNU Make');
    return;
  }
  const source = createTemplateFixture('@true');
  const target = join(temporaryDirectory(), 'Application');
  const helper = join(SKILL_ROOT, 'scripts', 'bootstrap-template.mjs');
  const result = spawnSync(process.execPath, [
    helper, '--target', target, '--mode', 'new', '--auth', 'auto', '--repo-url', `file://${source}`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(runGit(target, ['branch', '--show-current']), 'main');
  assert.equal(runGit(target, ['remote']), '');
  assert.equal(readdirSync(dirname(target)).some((name) => name.startsWith('.Application.template-git-backup-')), false);
});

test('new mode preserves original Git metadata when make install changes the lockfile', (context) => {
  if (process.platform === 'win32' || !gnuMakeAvailable()) {
    context.skip('fixture requires native symlinks and GNU Make');
    return;
  }
  const source = createTemplateFixture("@printf '{\"changed\":true}\\n' > package-lock.json");
  const target = join(temporaryDirectory(), 'Application');
  const helper = join(SKILL_ROOT, 'scripts', 'bootstrap-template.mjs');
  const result = spawnSync(process.execPath, [
    helper, '--target', target, '--mode', 'new', '--auth', 'auto', '--repo-url', `file://${source}`,
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package-lock\.json changed during make install/);
  assert.ok(existsSync(join(target, '.git')));
  assert.equal(runGit(target, ['remote', 'get-url', 'origin']), `file://${source}`);
});

test('the Node-free macOS wrapper prints the complete workflow', (context) => {
  if (process.platform === 'win32') {
    context.skip('macOS wrapper is exercised on the macOS CI runner');
    return;
  }
  const target = join(temporaryDirectory(), 'Pizza');
  const wrapper = join(SKILL_ROOT, 'scripts', 'bootstrap-template.sh');
  const result = spawnSync('/bin/bash', [
    wrapper, '--target', target, '--mode', 'new', '--auth', 'auto', '--plan',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  const ids = plan.actions.map(({ id }) => id);
  for (const required of [
    'install-node', 'prove-repository-access', 'clone-template', 'verify-symlinks',
    'inspect-safe-chain-choice', 'run-make-install', 'validate-install-drift',
    'initialize-application-repository',
  ]) {
    assert.ok(ids.includes(required), `${required} must be visible without Node`);
  }
  assert.equal(plan.requiresSystemApproval, true);
});

test('the Windows PowerShell wrapper exposes the same full-plan contract without PowerShell 7 syntax', () => {
  const wrapperPath = join(SKILL_ROOT, 'scripts', 'bootstrap-template.ps1');
  const wrapper = readFileSync(wrapperPath, 'utf8');
  assert.doesNotMatch(wrapper, /\?\?/);
  for (const required of [
    'prove-repository-access', 'clone-template', 'inspect-safe-chain-choice',
    'validate-install-drift', 'initialize-application-repository',
  ]) {
    assert.match(wrapper, new RegExp(`'${required}'`));
  }

  if (process.platform === 'win32') {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const result = spawnSync(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath,
      '--target', 'C:\\Temp\\SymbisBootstrapPlanProbe', '--mode', 'new', '--auth', 'auto', '--plan',
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: 'C:\\Windows\\System32;C:\\Windows' },
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    const ids = plan.actions.map(({ id }) => id);
    for (const required of [
      'install-node', 'prove-repository-access', 'clone-template',
      'inspect-safe-chain-choice', 'run-make-install', 'validate-install-drift',
      'initialize-application-repository',
    ]) {
      assert.ok(ids.includes(required), `${required} must be visible without Node on Windows`);
    }
  }
});

test('no tracked skill source persists tokens or forces Bearer auth onto ordinary Git', () => {
  const moduleSource = readFileSync(join(SKILL_ROOT, 'scripts', 'bootstrap-template.mjs'), 'utf8');
  assert.doesNotMatch(moduleSource, /console\.(?:log|error)\([^\n]*token/i);
  assert.match(moduleSource, /withoutForcedGitAuthentication/);
  assert.match(moduleSource, /GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer \$\{token\}`/);
  assert.equal(existsSync(join(SKILL_ROOT, 'references', 'private-github-install.md')), false);
});
