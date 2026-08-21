#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPOSITORY_URL =
  'https://Symbis-AI-Team@dev.azure.com/Symbis-AI-Team/symbis-code-app-template/_git/symbis-code-app-template';

const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const SAFE_CHAIN_HEADING = '## Safe Chain Project Setup';
const AUTH_STRATEGIES = new Set(['auto', 'git-credential-manager', 'azure-cli']);
const EXPECTED_LINKS = new Map([
  ['CLAUDE.md', 'AGENTS.md'],
  ['.github/copilot-instructions.md', '../AGENTS.md'],
  ['.claude/skills', '../.agents/skills'],
]);

function fail(message) {
  throw new Error(message);
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? String(result.stderr || result.stdout || '').trim() : '';
    fail(`${command} failed with exit code ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function capture(command, args = [], options = {}) {
  const result = run(command, args, { ...options, capture: true, allowFailure: options.allowFailure });
  const normalize = (value) => options.trim === false
    ? String(value ?? '').replace(/\r?\n$/, '')
    : String(value ?? '').trim();
  return {
    status: result.status,
    stdout: normalize(result.stdout),
    stderr: normalize(result.stderr),
  };
}

function commandWorks(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore', shell: false });
  return !result.error && result.status === 0;
}

function nodeStatus(command = 'node') {
  const result = capture(command, ['--version'], { allowFailure: true });
  if (result.status !== 0) return 'missing';
  const major = Number.parseInt(result.stdout.replace(/^v/, '').split('.')[0], 10);
  return Number.isInteger(major) && major >= 22 ? 'installed' : 'upgradeRequired';
}

export function isGnuMakeVersion(output) {
  return /^GNU Make\s+\d/m.test(String(output));
}

function gnuMakeStatus(command) {
  const result = capture(command, ['--version'], { allowFailure: true });
  return result.status === 0 && isGnuMakeVersion(result.stdout) ? 'installed' : 'missing';
}

function findGnuMake() {
  if (gnuMakeStatus('make') === 'installed') return 'make';
  if (gnuMakeStatus('gmake') === 'installed') return 'gmake';
  return undefined;
}

function findBrew() {
  for (const candidate of ['brew', '/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (commandWorks(candidate, ['--version'])) return candidate;
  }
  return undefined;
}

function prependPath(path) {
  if (!path) return;
  const separator = process.platform === 'win32' ? ';' : ':';
  const values = String(process.env.PATH ?? '').split(separator);
  if (!values.includes(path)) process.env.PATH = `${path}${separator}${process.env.PATH ?? ''}`;
}

function refreshWindowsPath() {
  const script = [
    "[Environment]::GetEnvironmentVariable('Path','Machine')",
    "[Environment]::GetEnvironmentVariable('Path','User')",
  ].join(" + ';' + ");
  const result = capture('powershell.exe', ['-NoProfile', '-Command', script], { allowFailure: true });
  if (result.status === 0 && result.stdout) process.env.PATH = result.stdout.replace(/\r?\n/g, '');
  prependPath(join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links'));
  prependPath('C:\\Program Files\\Git\\cmd');
  prependPath('C:\\Program Files\\nodejs');
  prependPath('C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin');
}

function windowsDeveloperModeStatus() {
  if (!commandWorks('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'])) return 'unknown';
  const command = [
    "$p='HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock'",
    "$v=(Get-ItemProperty -LiteralPath $p -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense",
    "if($v -eq 1){'installed'}else{'missing'}",
  ].join(';');
  const result = capture('powershell.exe', ['-NoProfile', '-Command', command], { allowFailure: true });
  return result.status === 0 && result.stdout === 'installed' ? 'installed' : 'missing';
}

function globalSymlinkStatus() {
  if (!commandWorks('git', ['--version'])) return 'unknown';
  const result = capture('git', ['config', '--global', '--get', 'core.symlinks'], { allowFailure: true });
  return result.status === 0 && result.stdout.toLowerCase() === 'true' ? 'installed' : 'missing';
}

export function inspectSystemState(platform) {
  if (!['darwin', 'win32'].includes(platform)) fail(`Unsupported platform: ${platform}`);
  const state = {
    git: commandWorks('git', ['--version']) ? 'installed' : 'missing',
    node: nodeStatus(),
    gnuMake: findGnuMake() ? 'installed' : 'missing',
    azureCli: commandWorks('az', ['version']) ? 'installed' : 'missing',
  };
  if (platform === 'darwin') {
    state.homebrew = findBrew() ? 'installed' : 'missing';
  } else {
    state.winget = commandWorks('winget.exe', ['--version']) ? 'installed' : 'missing';
    state.developerMode = windowsDeveloperModeStatus();
    state.gitSymlinks = globalSymlinkStatus();
  }
  return state;
}

function action(id, command, { systemChange = false, conditional = false } = {}) {
  return { id, command, systemChange, conditional };
}

export function buildBootstrapPlan({
  platform,
  mode,
  target,
  repositoryUrl = DEFAULT_REPOSITORY_URL,
  authStrategy = 'auto',
  systemState = inspectSystemState(platform),
  authState = { attempted: [], selected: null, repositoryReadAccess: null },
}) {
  if (!['darwin', 'win32'].includes(platform)) fail(`Unsupported platform: ${platform}`);
  if (!['new', 'existing'].includes(mode)) fail(`Unsupported mode: ${mode}`);
  if (!AUTH_STRATEGIES.has(authStrategy)) fail(`Unsupported auth strategy: ${authStrategy}`);
  const absoluteTarget = normalizeTarget(target, platform);
  const actions = [];

  if (mode === 'existing') {
    actions.push(action(
      'preflight-existing-checkout',
      'Reject dirty package manifests and unsafe symlink overlap before system or repository changes',
    ));
  }

  if (platform === 'win32') {
    if (systemState.developerMode !== 'installed') {
      actions.push(action(
        'enable-windows-developer-mode',
        'Run the bundled elevated PowerShell helper and verify AllowDevelopmentWithoutDevLicense=1',
        { systemChange: true },
      ));
    }
    if (systemState.git !== 'installed') {
      actions.push(action('install-git', 'winget install --exact --id Git.Git --source winget', { systemChange: true }));
    }
    if (systemState.node !== 'installed') {
      actions.push(action('install-node', 'winget install --exact --id OpenJS.NodeJS.LTS --source winget', { systemChange: true }));
    }
    if (systemState.gnuMake !== 'installed') {
      actions.push(action('install-gnu-make', 'winget install --exact --id ezwinports.make --source winget', { systemChange: true }));
    }
    if (authStrategy === 'azure-cli' && systemState.azureCli !== 'installed') {
      actions.push(action('install-azure-cli', 'winget install --exact --id Microsoft.AzureCLI --source winget', { systemChange: true }));
    }
    if (systemState.gitSymlinks !== 'installed') {
      actions.push(action('enable-git-symlinks', 'git config --global core.symlinks true', { systemChange: true }));
    }
  } else {
    const formulas = [];
    if (systemState.git !== 'installed') formulas.push(['install-git', 'git']);
    if (systemState.node !== 'installed') formulas.push(['install-node', 'node@22']);
    if (systemState.gnuMake !== 'installed') formulas.push(['install-gnu-make', 'make']);
    if (authStrategy === 'azure-cli' && systemState.azureCli !== 'installed') formulas.push(['install-azure-cli', 'azure-cli']);
    if (formulas.length > 0 && systemState.homebrew !== 'installed') {
      actions.push(action('install-homebrew', 'Install Homebrew from its official installer', { systemChange: true }));
    }
    for (const [id, formula] of formulas) {
      actions.push(action(id, `brew install ${formula}`, { systemChange: true }));
    }
  }

  if (mode === 'new') {
    const authCommand = authStrategy === 'auto'
      ? 'Prove read access with ordinary Git credentials first; use a proven Azure CLI token only as fallback'
      : authStrategy === 'git-credential-manager'
        ? 'Prove read access with ordinary Git and the configured credential helper'
        : 'Prove read access with an Azure CLI Bearer token before cloning';
    actions.push(
      action('prove-repository-access', authCommand),
      action('clone-template', `Clone ${repositoryUrl} into ${absoluteTarget} with the proven credential route`),
      action('verify-symlinks', 'Verify every tracked template link is a real symbolic link'),
      action('inspect-safe-chain-choice', 'Inspect the cloned AGENTS.md and apply a decision only when the section exists'),
      action('run-make-install', 'Run GNU Make target: make install while the original template Git metadata remains recoverable'),
      action('validate-install-drift', 'Reject package manifest or unexpected tracked drift before replacing Git metadata'),
      action('initialize-application-repository', 'Move template Git metadata to a recoverable backup, initialize main, verify, then remove the backup'),
    );
  } else {
    actions.push(
      action('repair-symlinks', 'Repair only unchanged tracked symlinks and preserve unrelated worktree changes'),
      action('resolve-safe-chain-choice', 'Apply the one-time Safe Chain choice only when the section is present'),
      action('run-make-install', 'Run GNU Make target: make install'),
    );
  }

  if (
    mode === 'new'
    && authStrategy === 'auto'
    && systemState.azureCli !== 'installed'
    && authState.repositoryReadAccess !== true
  ) {
    actions.push(action(
      'conditional-azure-cli-fallback',
      'Install Azure CLI only if ordinary Git authentication fails and the user approves that newly discovered system change',
      { conditional: true },
    ));
  }

  return {
    platform,
    mode,
    target: absoluteTarget,
    repositoryUrl,
    auth: {
      strategy: authStrategy,
      attempted: authState.attempted ?? [],
      selected: authState.selected ?? null,
      repositoryReadAccess: authState.repositoryReadAccess ?? null,
    },
    prerequisites: systemState,
    requiresSystemApproval: actions.some(({ systemChange }) => systemChange),
    actions,
  };
}

export function normalizeTarget(target, platform = process.platform) {
  if (!target) fail('An absolute target path is required');
  const pathApi = platform === 'win32' ? win32 : posix;
  if (!pathApi.isAbsolute(target)) {
    fail(`--target must be an absolute path; received ${target}. Resolve "here" to the current absolute directory before running the helper.`);
  }
  const normalized = pathApi.normalize(target);
  if (pathApi.dirname(normalized) === normalized) fail('The filesystem root cannot be used as the template target');
  return normalized;
}

export async function classifyTarget(target) {
  if (!existsSync(target)) return 'new';
  const entries = readdirSync(target);
  if (entries.length === 0) return 'new';
  if (existsSync(join(target, 'Makefile')) && existsSync(join(target, 'package.json'))) return 'existing';
  fail(`Target ${target} is not empty and is not a recognized template checkout`);
}

export function assertSymlinkRepairIsSafe(
  status,
  linkPaths = [...EXPECTED_LINKS.keys()],
  repairablePlainLinks = [],
) {
  const changed = parseStatusPaths(status);
  for (const link of linkPaths) {
    if (!repairablePlainLinks.includes(link) && changed.some((path) => path === link || path.endsWith(` -> ${link}`))) {
      fail(`${link} has local changes; refusing to replace it`);
    }
  }
}

function parseStatusPaths(status) {
  return status
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((path) => path.includes(' -> ') ? path.split(' -> ').at(-1) : path);
}

function installHomebrew() {
  const directory = mkdtempSync(join(tmpdir(), 'symbis-homebrew-'));
  const installer = join(directory, 'install.sh');
  try {
    run('curl', ['-fsSL', 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh', '-o', installer]);
    run('/bin/bash', [installer]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function brewInstall(brew, formula) {
  run(brew, ['install', formula]);
}

function refreshBrewPath(brew) {
  const prefix = capture(brew, ['--prefix']).stdout;
  prependPath(join(prefix, 'bin'));
  const nodePrefix = capture(brew, ['--prefix', 'node@22'], { allowFailure: true });
  if (nodePrefix.status === 0) prependPath(join(nodePrefix.stdout, 'bin'));
  const makePrefix = capture(brew, ['--prefix', 'make'], { allowFailure: true });
  if (makePrefix.status === 0) prependPath(join(makePrefix.stdout, 'libexec', 'gnubin'));
}

function wingetInstall(packageId) {
  if (!commandWorks('winget.exe', ['--version'])) {
    fail('WinGet is required for missing prerequisites. Install or update Microsoft App Installer, then rerun the plan.');
  }
  run('winget.exe', [
    'install', '--exact', '--id', packageId, '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
  ]);
  refreshWindowsPath();
}

function prepareWindows(systemState, authStrategy) {
  if (systemState.developerMode !== 'installed') {
    run('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(SCRIPT_ROOT, 'enable-windows-developer-mode.ps1'),
    ]);
  }
  if (systemState.git !== 'installed') wingetInstall('Git.Git');
  if (systemState.node !== 'installed') wingetInstall('OpenJS.NodeJS.LTS');
  if (systemState.gnuMake !== 'installed') wingetInstall('ezwinports.make');
  if (authStrategy === 'azure-cli' && systemState.azureCli !== 'installed') wingetInstall('Microsoft.AzureCLI');
  refreshWindowsPath();
  if (nodeStatus() !== 'installed') fail('Node.js 22+ is not visible. Reopen PowerShell and rerun the same command.');
  if (!commandWorks('git', ['--version'])) fail('Git is not visible. Reopen PowerShell and rerun the same command.');
  if (!findGnuMake()) fail('GNU Make is not visible. Reopen PowerShell and rerun the same command.');
  if (systemState.gitSymlinks !== 'installed') run('git', ['config', '--global', 'core.symlinks', 'true']);
}

function prepareMac(systemState, authStrategy) {
  const formulas = [];
  if (systemState.git !== 'installed') formulas.push('git');
  if (systemState.node !== 'installed') formulas.push('node@22');
  if (systemState.gnuMake !== 'installed') formulas.push('make');
  if (authStrategy === 'azure-cli' && systemState.azureCli !== 'installed') formulas.push('azure-cli');
  let brew = findBrew();
  if (formulas.length > 0 && !brew) {
    installHomebrew();
    brew = findBrew();
  }
  if (formulas.length > 0 && !brew) fail('Homebrew installation completed, but brew is not available');
  if (brew) refreshBrewPath(brew);
  for (const formula of formulas) brewInstall(brew, formula);
  if (brew) refreshBrewPath(brew);
  if (nodeStatus() !== 'installed') fail('Node.js 22+ is unavailable after prerequisite setup');
  if (!commandWorks('git', ['--version'])) fail('Git is unavailable after prerequisite setup');
  if (!findGnuMake()) fail('GNU Make is unavailable after prerequisite setup');
}

function installAzureCliFallback(platform) {
  if (commandWorks('az', ['version'])) return;
  if (platform === 'win32') {
    wingetInstall('Microsoft.AzureCLI');
  } else {
    let brew = findBrew();
    if (!brew) {
      installHomebrew();
      brew = findBrew();
    }
    if (!brew) fail('Homebrew is unavailable for the Azure CLI fallback');
    brewInstall(brew, 'azure-cli');
    refreshBrewPath(brew);
  }
  if (!commandWorks('az', ['version'])) fail('Azure CLI installation completed but az is not visible; reopen the shell and rerun');
}

function withoutForcedGitAuthentication(environment = process.env) {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    if (key === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete clean[key];
  }
  return clean;
}

function bearerEnvironment(token) {
  return {
    ...withoutForcedGitAuthentication(),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}`,
  };
}

export function isConditionalAccessError(output) {
  return /(?:AADSTS)?53003|conditional access/i.test(String(output));
}

export function isAuthenticationFailure(output) {
  return /(?:401|403|authentication failed|fatal: authentication|could not read username|terminal prompts disabled|TF401019|access denied)/i.test(String(output));
}

export function probeRepositoryWithGit(repositoryUrl, options = {}) {
  const environment = options.token
    ? bearerEnvironment(options.token)
    : withoutForcedGitAuthentication(options.env);
  if (options.interactive === false) {
    environment.GIT_TERMINAL_PROMPT = '0';
    environment.GCM_INTERACTIVE = 'never';
  }
  const result = capture('git', ['ls-remote', repositoryUrl, 'HEAD'], {
    env: environment,
    allowFailure: true,
  });
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  return {
    ok: result.status === 0,
    status: result.status,
    authFailure: result.status !== 0 && isAuthenticationFailure(detail),
    conditionalAccess: result.status !== 0 && isConditionalAccessError(detail),
    detail,
  };
}

function azureIdentity() {
  const result = capture('az', [
    'account', 'show', '--query', '{user:user.name,tenantId:tenantId}', '--output', 'json',
  ], { allowFailure: true });
  if (result.status !== 0 || !result.stdout) return { user: 'unknown', tenantId: 'unknown' };
  try {
    const parsed = JSON.parse(result.stdout);
    return { user: parsed.user ?? 'unknown', tenantId: parsed.tenantId ?? 'unknown' };
  } catch {
    return { user: 'unknown', tenantId: 'unknown' };
  }
}

function requestAzureToken({ allowLogin }) {
  let result = capture('az', [
    'account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE,
    '--query', 'accessToken', '--output', 'tsv',
  ], { allowFailure: true });
  if ((result.status !== 0 || !result.stdout) && allowLogin) {
    const detail = `${result.stderr}\n${result.stdout}`;
    if (isConditionalAccessError(detail)) {
      fail('Azure sign-in is blocked by Conditional Access (53003). Complete the organization-approved access requirements; the helper will not retry or bypass policy.');
    }
    const login = capture('az', ['login', '--allow-no-subscriptions'], { allowFailure: true });
    const loginDetail = `${login.stderr}\n${login.stdout}`;
    if (isConditionalAccessError(loginDetail)) {
      fail('Azure sign-in is blocked by Conditional Access (53003). Complete the organization-approved access requirements; the helper will not retry or bypass policy.');
    }
    if (login.status !== 0) fail(`Azure CLI browser sign-in failed: ${login.stderr || login.stdout}`);
    result = capture('az', [
      'account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE,
      '--query', 'accessToken', '--output', 'tsv',
    ], { allowFailure: true });
  }
  if (result.status !== 0 || !result.stdout) {
    const detail = `${result.stderr}\n${result.stdout}`;
    if (isConditionalAccessError(detail)) {
      fail('Azure token acquisition is blocked by Conditional Access (53003). The helper will not retry or bypass policy.');
    }
    fail('Azure CLI did not return an Azure DevOps access token');
  }
  return result.stdout;
}

export function selectAuthenticationStrategy({
  authStrategy,
  gitCredentialProbe,
  azureCliProbe,
}) {
  const attempted = [];
  if (authStrategy !== 'azure-cli') {
    attempted.push('git-credential-manager');
    const gitResult = gitCredentialProbe();
    if (gitResult.ok) {
      return { selected: 'git-credential-manager', attempted, repositoryReadAccess: true };
    }
    if (gitResult.conditionalAccess) {
      fail('Git authentication is blocked by Conditional Access (53003). The helper will not retry or bypass policy.');
    }
    if (!gitResult.authFailure) fail(`Repository access check failed before authentication: ${gitResult.detail}`);
    if (authStrategy === 'git-credential-manager') {
      fail('Git Credential Manager could not prove repository read access. Complete its browser sign-in or choose --auth azure-cli explicitly.');
    }
  }
  attempted.push('azure-cli');
  const azureResult = azureCliProbe();
  if (!azureResult.ok) fail(azureResult.message ?? 'Azure CLI could not prove repository read access');
  return {
    selected: 'azure-cli',
    attempted,
    repositoryReadAccess: true,
    token: azureResult.token,
    identity: azureResult.identity,
  };
}

function authenticateRepository({ repositoryUrl, authStrategy, platform, approveSystemChanges }) {
  return selectAuthenticationStrategy({
    authStrategy,
    gitCredentialProbe: () => probeRepositoryWithGit(repositoryUrl),
    azureCliProbe: () => {
      if (!commandWorks('az', ['version'])) {
        if (!approveSystemChanges) {
          return {
            ok: false,
            message: 'Ordinary Git authentication failed and Azure CLI is missing. Rerun with --approve-system-changes to permit this newly required fallback, or complete Git Credential Manager sign-in and rerun.',
          };
        }
        installAzureCliFallback(platform);
      }
      const token = requestAzureToken({ allowLogin: true });
      const identity = azureIdentity();
      const probe = probeRepositoryWithGit(repositoryUrl, { token });
      if (!probe.ok) {
        if (probe.conditionalAccess) {
          return { ok: false, message: 'Azure DevOps access is blocked by Conditional Access (53003). The helper will not retry or bypass policy.' };
        }
        const identityText = `${identity.user} in tenant ${identity.tenantId}`;
        if (probe.authFailure) {
          return {
            ok: false,
            message: `Azure CLI issued a token for ${identityText}, but that token has no read access to this repository. No clone was attempted. Use the approved account or Git Credential Manager.`,
          };
        }
        return { ok: false, message: `Azure CLI repository access check failed for ${identityText}: ${probe.detail}` };
      }
      return { ok: true, token, identity };
    },
  });
}

function cloneWithProvenAuthentication(repositoryUrl, target, authentication) {
  mkdirSync(dirname(target), { recursive: true });
  const env = authentication.selected === 'azure-cli'
    ? bearerEnvironment(authentication.token)
    : withoutForcedGitAuthentication();
  run('git', [
    '-c', 'core.symlinks=true', 'clone', '--depth', '1', '--single-branch', repositoryUrl, target,
  ], { env });
}

function verifyTemplateSymlinks(target) {
  for (const [path, expectedTarget] of EXPECTED_LINKS) {
    const absolute = join(target, path);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) fail(`Required link is missing: ${path}`);
    if (!stat.isSymbolicLink()) fail(`${path} is not a symbolic link`);
    const actualTarget = readlinkSync(absolute);
    if (actualTarget !== expectedTarget) fail(`${path} must target ${expectedTarget}; found ${actualTarget}`);
    const trackedTarget = capture('git', ['show', `HEAD:${path}`], { cwd: target }).stdout;
    if (trackedTarget !== expectedTarget) fail(`${path} must target ${expectedTarget}; found ${trackedTarget}`);
  }
}

export function repairTemplateSymlinks(target) {
  const status = capture('git', ['status', '--porcelain'], { cwd: target, trim: false }).stdout;
  const repairablePlainLinks = [];
  for (const path of EXPECTED_LINKS.keys()) {
    const absolute = join(target, path);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || stat.isDirectory()) continue;
    const index = capture('git', ['ls-files', '-s', '--', path], { cwd: target }).stdout;
    if (!index.startsWith('120000 ')) continue;
    const actual = capture('git', ['hash-object', '--', path], { cwd: target }).stdout;
    const expected = capture('git', ['rev-parse', `HEAD:${path}`], { cwd: target }).stdout;
    if (actual === expected) repairablePlainLinks.push(path);
  }
  assertSymlinkRepairIsSafe(status, [...EXPECTED_LINKS.keys()], repairablePlainLinks);
  run('git', ['config', 'core.symlinks', 'true'], { cwd: target });

  for (const path of EXPECTED_LINKS.keys()) {
    const absolute = join(target, path);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) continue;
    if (stat?.isDirectory()) fail(`${path} is an unexpected directory; refusing to replace it`);
    const index = capture('git', ['ls-files', '-s', '--', path], { cwd: target }).stdout;
    if (!index.startsWith('120000 ')) fail(`${path} is not recorded as a symlink in the Git index`);
    if (stat) {
      const actual = capture('git', ['hash-object', '--', path], { cwd: target }).stdout;
      const expected = capture('git', ['rev-parse', `HEAD:${path}`], { cwd: target }).stdout;
      if (actual !== expected) fail(`${path} content differs from HEAD; refusing to replace it`);
      rmSync(absolute, { force: true });
    }
    run('git', ['checkout-index', '--force', '--', path], { cwd: target });
  }
  verifyTemplateSymlinks(target);
}

function removeMarkdownSection(file, heading) {
  const content = readFileSync(file, 'utf8');
  const start = content.indexOf(`${heading}\n`);
  if (start < 0) return;
  const next = content.indexOf('\n## ', start + heading.length + 1);
  const before = content.slice(0, start).replace(/\n+$/, '\n');
  const after = next < 0 ? '' : content.slice(next + 1);
  writeFileSync(file, `${before}${after}`);
}

export function removeSafeChainIgnoreRules(file) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const filtered = lines.filter((line) => !/Safe Chain \(optional, project-local/.test(line) && line.trim() !== '.safe-chain/');
  writeFileSync(file, `${filtered.join('\n').replace(/\n+$/, '')}\n`);
}

export function verifySafeChainRemoved(target) {
  const agents = join(target, 'AGENTS.md');
  if (existsSync(agents) && readFileSync(agents, 'utf8').includes(SAFE_CHAIN_HEADING)) {
    fail('Safe Chain heading remains in AGENTS.md after removal');
  }
  if (existsSync(join(target, '.safe-chain'))) fail('.safe-chain remains after removal');
  const scriptsDirectory = join(target, 'scripts');
  if (existsSync(scriptsDirectory)) {
    const leftovers = readdirSync(scriptsDirectory).filter((name) => /safe-chain/i.test(name));
    if (leftovers.length > 0) fail(`Safe Chain scripts remain after removal: ${leftovers.join(', ')}`);
  }
  const ignore = join(target, '.gitignore');
  if (existsSync(ignore) && /safe-chain/i.test(readFileSync(ignore, 'utf8'))) {
    fail('Safe Chain ignore rules remain after removal');
  }
}

function resolveSafeChain(target, decision, platform) {
  const agents = join(target, 'AGENTS.md');
  const hasSection = existsSync(agents) && readFileSync(agents, 'utf8').includes(SAFE_CHAIN_HEADING);
  if (!hasSection) return { present: false, decision: null };
  if (!['yes', 'no'].includes(decision)) {
    fail('Safe Chain exists in the cloned template. Ask the user once, then rerun with --safe-chain yes or --safe-chain no; the clone and original Git metadata were preserved.');
  }
  const status = capture('git', ['status', '--porcelain', '--', 'AGENTS.md'], { cwd: target, trim: false }).stdout;
  if (status) fail('AGENTS.md has local changes; refusing to resolve the Safe Chain section automatically');
  if (platform === 'win32') {
    const script = decision === 'yes' ? 'scripts/setup-safe-chain.ps1' : 'scripts/remove-safe-chain-setup.ps1';
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(target, script)], { cwd: target });
  } else {
    const script = decision === 'yes' ? 'scripts/setup-safe-chain.sh' : 'scripts/remove-safe-chain-setup.sh';
    run('/bin/bash', [join(target, script)], { cwd: target });
  }
  removeMarkdownSection(agents, SAFE_CHAIN_HEADING);
  if (decision === 'no') {
    removeSafeChainIgnoreRules(join(target, '.gitignore'));
    verifySafeChainRemoved(target);
  }
  return { present: true, decision };
}

export function assertSafeChainDecisionIsReady(mode, hasSection, decision) {
  if (hasSection && !['yes', 'no'].includes(decision)) {
    fail(`Safe Chain choice is required before ${mode} bootstrap side effects`);
  }
}

function preflightExistingSafeChain(target, decision) {
  const agents = join(target, 'AGENTS.md');
  const hasSection = existsSync(agents) && readFileSync(agents, 'utf8').includes(SAFE_CHAIN_HEADING);
  assertSafeChainDecisionIsReady('existing', hasSection, decision);
  if (hasSection) {
    const status = capture('git', ['status', '--porcelain', '--', 'AGENTS.md'], { cwd: target, trim: false }).stdout;
    if (status) fail('AGENTS.md has local changes; refusing to resolve the Safe Chain section automatically');
  }
}

export function assertPackageInstallIsSafe(status, mode) {
  if (mode === 'new') return;
  for (const path of parseStatusPaths(status)) {
    if (path === 'package.json' || path === 'package-lock.json') {
      fail(`${path} already has local changes; refusing to mix them with installation changes`);
    }
  }
}

export function assertNewCheckoutDriftIsSafe(beforeInstallStatus, afterInstallStatus) {
  const allowed = new Set(parseStatusPaths(beforeInstallStatus));
  const after = parseStatusPaths(afterInstallStatus);
  for (const path of after) {
    if (path === 'package.json' || path === 'package-lock.json') {
      fail(`${path} changed during make install; the original template Git metadata was preserved for inspection`);
    }
    if (!allowed.has(path)) {
      fail(`${path} changed unexpectedly during make install; the original template Git metadata was preserved for inspection`);
    }
  }
}

function runMakeInstall(target, mode, beforeInstallStatus = '') {
  const manifests = capture('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json'], {
    cwd: target,
    trim: false,
  });
  assertPackageInstallIsSafe(manifests.stdout, mode);
  const command = findGnuMake();
  if (!command) fail('GNU Make is unavailable');
  run(command, ['install'], { cwd: target });
  if (mode === 'new') {
    const after = capture('git', ['status', '--porcelain'], { cwd: target, trim: false }).stdout;
    assertNewCheckoutDriftIsSafe(beforeInstallStatus, after);
  }
}

export function initializeApplicationRepository(target, operations = {}) {
  const move = operations.move ?? renameSync;
  const remove = operations.remove ?? rmSync;
  const execute = operations.run ?? run;
  const gitDirectory = join(target, '.git');
  if (!existsSync(gitDirectory)) fail('Fresh clone has no .git directory; refusing repository reinitialization');
  const backup = join(
    dirname(target),
    `.${basename(target)}.template-git-backup-${process.pid}-${Date.now()}`,
  );
  move(gitDirectory, backup);
  try {
    execute('git', ['init', '-b', 'main'], { cwd: target });
    execute('git', ['config', 'core.symlinks', 'true'], { cwd: target });
    const inside = capture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: target });
    const branch = capture('git', ['branch', '--show-current'], { cwd: target });
    if (inside.stdout !== 'true' || branch.stdout !== 'main') fail('New application repository verification failed');
    remove(backup, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(gitDirectory)) remove(gitDirectory, { recursive: true, force: true });
    if (existsSync(backup)) move(backup, gitDirectory);
    throw new Error(`Application repository initialization failed; original template Git metadata was restored. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function preflightExistingCheckout(target) {
  const insideWorktree = capture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: target, allowFailure: true });
  if (insideWorktree.status !== 0 || insideWorktree.stdout !== 'true') fail(`${target} is not a Git worktree`);
  const manifests = capture('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json'], {
    cwd: target,
    trim: false,
  });
  assertPackageInstallIsSafe(manifests.stdout, 'existing');
}

function inspectStoredGitAccess(repositoryUrl) {
  if (!commandWorks('git', ['--version'])) {
    return { attempted: [], selected: null, repositoryReadAccess: null };
  }
  const result = probeRepositoryWithGit(repositoryUrl, { interactive: false });
  return {
    attempted: ['git-credential-manager'],
    selected: result.ok ? 'git-credential-manager' : null,
    repositoryReadAccess: result.ok ? true : result.authFailure ? false : null,
  };
}

function parseArguments(argv) {
  const options = {
    mode: 'auto',
    repositoryUrl: DEFAULT_REPOSITORY_URL,
    platform: process.platform,
    authStrategy: 'auto',
    plan: false,
    approveSystemChanges: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next) fail(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === '--target') options.target = value();
    else if (argument === '--mode') options.mode = value();
    else if (argument === '--repo-url') options.repositoryUrl = value();
    else if (argument === '--platform') options.platform = value();
    else if (argument === '--auth') options.authStrategy = value();
    else if (argument === '--safe-chain') options.safeChain = value();
    else if (argument === '--plan') options.plan = true;
    else if (argument === '--approve-system-changes') options.approveSystemChanges = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else fail(`Unknown argument: ${argument}`);
  }
  return options;
}

function showHelp() {
  console.log(`Usage: bootstrap-template --target <absolute-path> [options]

Options:
  --mode auto|new|existing       Detect by default; never overwrite an unrelated directory
  --repo-url <url>               Override the canonical Azure DevOps template URL
  --auth auto|git-credential-manager|azure-cli
                                 Prefer ordinary Git credentials by default; prove read access before clone
  --safe-chain yes|no            Used only when the cloned/current AGENTS.md contains the one-time choice
  --plan                         Inspect prerequisites and print actions as JSON without changing anything
  --approve-system-changes       Confirm only the missing global prerequisites listed by the plan
`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return showHelp();
  if (!AUTH_STRATEGIES.has(options.authStrategy)) fail(`Unsupported auth strategy: ${options.authStrategy}`);
  const target = normalizeTarget(options.target, options.platform);
  const mode = options.mode === 'auto' ? await classifyTarget(target) : options.mode;
  const systemState = inspectSystemState(options.platform);
  const authState = mode === 'new' && options.authStrategy !== 'azure-cli'
    ? inspectStoredGitAccess(options.repositoryUrl)
    : undefined;
  const plan = buildBootstrapPlan({
    platform: options.platform,
    mode,
    target,
    repositoryUrl: options.repositoryUrl,
    authStrategy: options.authStrategy,
    systemState,
    authState,
  });
  if (options.plan) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (options.platform !== process.platform) fail('--platform may only override the OS in --plan mode');
  if (mode === 'existing') {
    preflightExistingCheckout(target);
    preflightExistingSafeChain(target, options.safeChain);
  }
  if (plan.requiresSystemApproval && !options.approveSystemChanges) {
    fail('The plan contains actual system changes. Review it, obtain one bundled confirmation, then add --approve-system-changes.');
  }
  if (options.platform === 'win32') prepareWindows(systemState, options.authStrategy);
  else prepareMac(systemState, options.authStrategy);

  if (mode === 'new') {
    const authentication = authenticateRepository({
      repositoryUrl: options.repositoryUrl,
      authStrategy: options.authStrategy,
      platform: options.platform,
      approveSystemChanges: options.approveSystemChanges,
    });
    console.log(`Repository read access proven with ${authentication.selected}.`);
    if (authentication.identity) {
      console.log(`Azure CLI identity: ${authentication.identity.user}; tenant: ${authentication.identity.tenantId}.`);
    }
    cloneWithProvenAuthentication(options.repositoryUrl, target, authentication);
    verifyTemplateSymlinks(target);
    resolveSafeChain(target, options.safeChain, options.platform);
    const beforeInstallStatus = capture('git', ['status', '--porcelain'], { cwd: target, trim: false }).stdout;
    runMakeInstall(target, mode, beforeInstallStatus);
    initializeApplicationRepository(target);
  } else {
    repairTemplateSymlinks(target);
    resolveSafeChain(target, options.safeChain, options.platform);
    runMakeInstall(target, mode);
  }
  console.log(`Template ready at ${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
