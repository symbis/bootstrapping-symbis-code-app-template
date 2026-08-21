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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPOSITORY_URL =
  'https://Symbis-AI-Team@dev.azure.com/Symbis-AI-Team/symbis-code-app-template/_git/symbis-code-app-template';

const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const EXPECTED_LINKS = new Map([
  ['CLAUDE.md', 'AGENTS.md'],
  ['.github/copilot-instructions.md', '../AGENTS.md'],
  ['.claude/skills', '../.agents/skills'],
]);

function action(id, command, systemChange = false) {
  return { id, command, systemChange };
}

export function buildBootstrapPlan({ platform, mode, target, repositoryUrl = DEFAULT_REPOSITORY_URL }) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  if (!['new', 'existing'].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
  if (!target) throw new Error('A target path is required');

  const actions = platform === 'win32'
    ? [
        action(
          'enable-windows-developer-mode',
          'Run the bundled elevated PowerShell helper and verify AllowDevelopmentWithoutDevLicense=1',
          true,
        ),
        action('install-git', 'winget install --exact --id Git.Git --source winget', true),
        action('install-node', 'winget install --exact --id OpenJS.NodeJS.LTS --source winget', true),
        action('install-gnu-make', 'winget install --exact --id ezwinports.make --source winget', true),
        action('install-azure-cli', 'winget install --exact --id Microsoft.AzureCLI --source winget', true),
        action('enable-git-symlinks', 'git config --global core.symlinks true', true),
      ]
    : [
        action('install-homebrew', 'Install Homebrew from its official installer when it is missing', true),
        action('install-git', 'brew install git', true),
        action('install-node', 'brew install node@22', true),
        action('install-gnu-make', 'brew install make and use its gnubin path', true),
        action('install-azure-cli', 'brew install azure-cli', true),
      ];

  if (mode === 'existing') {
    actions.unshift(action(
      'preflight-existing-checkout',
      'Reject dirty package manifests and unsafe symlink overlap before any system or repository change',
    ));
  }

  if (mode === 'new') {
    actions.push(
      action('authenticate-azure-devops', `az login, then request a token for ${AZURE_DEVOPS_RESOURCE}`),
      action('clone-template', `Clone ${repositoryUrl} into ${target} without placing the token in argv`),
      action('verify-symlinks', 'Verify every tracked template link is a real symbolic link'),
      action('resolve-safe-chain-choice', 'Apply the required one-time Safe Chain yes/no choice when present'),
      action('initialize-application-repository', 'Remove only the fresh template .git directory and initialize main'),
    );
  } else {
    actions.push(
      action('repair-symlinks', 'Repair only unchanged tracked symlinks and preserve every unrelated worktree change'),
      action('resolve-safe-chain-choice', 'Apply the required one-time Safe Chain yes/no choice when present'),
    );
  }

  actions.push(action('run-make-install', 'Run GNU Make target: make install'));
  return { platform, mode, target, repositoryUrl, requiresSystemApproval: actions.some(({ systemChange }) => systemChange), actions };
}

export async function classifyTarget(target) {
  if (!existsSync(target)) return 'new';
  const entries = readdirSync(target);
  if (entries.length === 0) return 'new';
  if (existsSync(join(target, 'Makefile')) && existsSync(join(target, 'package.json'))) return 'existing';
  throw new Error(`Target ${target} is not empty and is not a recognized template checkout`);
}

export function assertSymlinkRepairIsSafe(
  status,
  linkPaths = [...EXPECTED_LINKS.keys()],
  repairablePlainLinks = [],
) {
  const changed = status
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  for (const link of linkPaths) {
    if (!repairablePlainLinks.includes(link) && changed.some((path) => path === link || path.endsWith(` -> ${link}`))) {
      throw new Error(`${link} has local changes; refusing to replace it`);
    }
  }
}

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
  return { status: result.status, stdout: String(result.stdout ?? '').trim(), stderr: String(result.stderr ?? '').trim() };
}

function commandWorks(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore', shell: false });
  return !result.error && result.status === 0;
}

function nodeIsSupported(command = 'node') {
  const result = capture(command, ['--version'], { allowFailure: true });
  const major = Number.parseInt(result.stdout.replace(/^v/, '').split('.')[0], 10);
  return result.status === 0 && Number.isInteger(major) && major >= 22;
}

export function isGnuMakeVersion(output) {
  return /^GNU Make\s+\d/m.test(String(output));
}

function gnuMakeWorks(command) {
  const result = capture(command, ['--version'], { allowFailure: true });
  return result.status === 0 && isGnuMakeVersion(result.stdout);
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

function wingetInstall(packageId) {
  run('winget.exe', [
    'install', '--exact', '--id', packageId, '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
  ]);
  refreshWindowsPath();
}

function prepareWindows() {
  const helper = join(SCRIPT_ROOT, 'enable-windows-developer-mode.ps1');
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper]);

  if (!commandWorks('winget.exe', ['--version'])) {
    fail('WinGet is required. Install or update Microsoft App Installer, then rerun the same bootstrap command.');
  }
  if (!commandWorks('git', ['--version'])) wingetInstall('Git.Git');
  if (!nodeIsSupported()) wingetInstall('OpenJS.NodeJS.LTS');
  if (!gnuMakeWorks('make')) wingetInstall('ezwinports.make');
  if (!commandWorks('az', ['version'])) wingetInstall('Microsoft.AzureCLI');

  refreshWindowsPath();
  if (!nodeIsSupported()) fail('Node.js 22+ was installed but is not visible yet. Reopen PowerShell and rerun this command.');
  for (const command of ['git', 'az']) {
    if (!commandWorks(command, command === 'az' ? ['version'] : ['--version'])) {
      fail(`${command} was installed but is not visible yet. Reopen PowerShell and rerun this command.`);
    }
  }
  if (!gnuMakeWorks('make')) fail('GNU Make was installed but is not visible yet. Reopen PowerShell and rerun this command.');
  run('git', ['config', '--global', 'core.symlinks', 'true']);
}

function findBrew() {
  for (const candidate of ['brew', '/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (commandWorks(candidate, ['--version'])) return candidate;
  }
  return undefined;
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

function prepareMac() {
  let brew = findBrew();
  if (!brew) {
    installHomebrew();
    brew = findBrew();
  }
  if (!brew) fail('Homebrew installation completed, but brew is not available');
  refreshBrewPath(brew);

  if (!commandWorks('git', ['--version'])) brewInstall(brew, 'git');
  if (!nodeIsSupported()) brewInstall(brew, 'node@22');
  if (!gnuMakeWorks('make')) brewInstall(brew, 'make');
  if (!commandWorks('az', ['version'])) brewInstall(brew, 'azure-cli');
  refreshBrewPath(brew);

  if (!nodeIsSupported()) fail('Node.js 22+ is still unavailable after Homebrew setup');
  for (const command of ['git', 'az']) {
    if (!commandWorks(command, command === 'az' ? ['version'] : ['--version'])) fail(`${command} is unavailable after setup`);
  }
  if (!gnuMakeWorks('make') && !gnuMakeWorks('gmake')) fail('GNU Make is unavailable after setup');
}

function getAzureDevOpsToken() {
  let token = capture('az', [
    'account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE,
    '--query', 'accessToken', '--output', 'tsv',
  ], { allowFailure: true });
  if (token.status !== 0 || !token.stdout) {
    run('az', ['login', '--allow-no-subscriptions']);
    token = capture('az', [
      'account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE,
      '--query', 'accessToken', '--output', 'tsv',
    ]);
  }
  if (!token.stdout) fail('Azure CLI did not return an Azure DevOps access token');
  return token.stdout;
}

function authenticatedClone(repositoryUrl, target) {
  mkdirSync(dirname(target), { recursive: true });
  const token = getAzureDevOpsToken();
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}`,
  };
  run('git', ['-c', 'core.symlinks=true', 'clone', '--depth', '1', '--single-branch', repositoryUrl, target], { env });
}

function verifyTemplateSymlinks(target) {
  for (const [path, expectedTarget] of EXPECTED_LINKS) {
    const absolute = join(target, path);
    if (!existsSync(absolute) && !lstatSync(absolute, { throwIfNoEntry: false })) fail(`Required link is missing: ${path}`);
    const stat = lstatSync(absolute);
    if (!stat.isSymbolicLink()) fail(`${path} is not a symbolic link`);
    const actualTarget = readlinkSync(absolute);
    if (actualTarget !== expectedTarget) fail(`${path} must target ${expectedTarget}; found ${actualTarget}`);
    const trackedTarget = capture('git', ['show', `HEAD:${path}`], { cwd: target }).stdout;
    if (trackedTarget !== expectedTarget) fail(`${path} must target ${expectedTarget}; found ${trackedTarget}`);
  }
}

function initializeApplicationRepository(target) {
  const gitDirectory = join(target, '.git');
  if (!existsSync(gitDirectory)) fail('Fresh clone has no .git directory; refusing repository reinitialization');
  rmSync(gitDirectory, { recursive: true, force: true });
  run('git', ['init', '-b', 'main'], { cwd: target });
  run('git', ['config', 'core.symlinks', 'true'], { cwd: target });
}

export function repairTemplateSymlinks(target) {
  const status = capture('git', ['status', '--porcelain'], { cwd: target }).stdout;
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

function resolveSafeChain(target, decision, platform) {
  const agents = join(target, 'AGENTS.md');
  const heading = '## Safe Chain Project Setup';
  if (!existsSync(agents) || !readFileSync(agents, 'utf8').includes(heading)) return;
  if (!['yes', 'no'].includes(decision)) {
    fail('Safe Chain is undecided. Rerun with --safe-chain yes or --safe-chain no after asking the user once.');
  }
  const status = capture('git', ['status', '--porcelain', '--', 'AGENTS.md'], { cwd: target }).stdout;
  if (status) fail('AGENTS.md has local changes; refusing to resolve the Safe Chain section automatically');

  if (platform === 'win32') {
    const script = decision === 'yes' ? 'scripts/setup-safe-chain.ps1' : 'scripts/remove-safe-chain-setup.ps1';
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(target, script)], { cwd: target });
  } else {
    const script = decision === 'yes' ? 'scripts/setup-safe-chain.sh' : 'scripts/remove-safe-chain-setup.sh';
    run('/bin/bash', [join(target, script)], { cwd: target });
  }
  removeMarkdownSection(agents, heading);
}

export function assertSafeChainDecisionIsReady(mode, hasSection, decision) {
  if (hasSection && !['yes', 'no'].includes(decision)) {
    throw new Error(`Safe Chain choice is required before ${mode} bootstrap side effects`);
  }
}

function preflightSafeChain(target, mode, decision) {
  const agents = join(target, 'AGENTS.md');
  const hasSection = mode === 'new'
    ? true
    : existsSync(agents) && readFileSync(agents, 'utf8').includes('## Safe Chain Project Setup');
  assertSafeChainDecisionIsReady(mode, hasSection, decision);
  if (mode === 'existing' && hasSection) {
    const status = capture('git', ['status', '--porcelain', '--', 'AGENTS.md'], { cwd: target }).stdout;
    if (status) fail('AGENTS.md has local changes; refusing to resolve the Safe Chain section automatically');
  }
}

export function assertPackageInstallIsSafe(status, mode) {
  if (mode === 'new') return;
  for (const line of status.split(/\r?\n/)) {
    const path = line.slice(3).trim();
    if (path === 'package.json' || path === 'package-lock.json') {
      throw new Error(`${path} already has local changes; refusing to mix them with installation changes`);
    }
  }
}

function runMakeInstall(target, mode) {
  const manifests = capture('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json'], {
    cwd: target,
    allowFailure: true,
  });
  if (manifests.status === 0) assertPackageInstallIsSafe(manifests.stdout, mode);
  const command = gnuMakeWorks('make') ? 'make' : gnuMakeWorks('gmake') ? 'gmake' : undefined;
  if (!command) fail('GNU Make is unavailable');
  run(command, ['install'], { cwd: target });
}

function preflightExistingCheckout(target) {
  const insideWorktree = capture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: target, allowFailure: true });
  if (insideWorktree.status !== 0 || insideWorktree.stdout !== 'true') {
    fail(`${target} is not a Git worktree`);
  }
  const manifests = capture('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json'], { cwd: target });
  assertPackageInstallIsSafe(manifests.stdout, 'existing');
}

function parseArguments(argv) {
  const options = {
    mode: 'auto',
    repositoryUrl: DEFAULT_REPOSITORY_URL,
    platform: process.platform,
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
    else if (argument === '--safe-chain') options.safeChain = value();
    else if (argument === '--plan') options.plan = true;
    else if (argument === '--approve-system-changes') options.approveSystemChanges = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else fail(`Unknown argument: ${argument}`);
  }
  return options;
}

function showHelp() {
  console.log(`Usage: bootstrap-template --target <path> [options]

Options:
  --mode auto|new|existing       Detect by default; never overwrite an unrelated directory
  --repo-url <url>               Override the canonical Azure DevOps template URL
  --safe-chain yes|no            Required only while the target still contains the one-time choice
  --plan                         Print the planned actions as JSON without changing anything
  --approve-system-changes       Confirm global installs and Windows Developer Mode changes
`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return showHelp();
  if (!options.target) fail('--target is required');
  const target = resolve(options.target);
  const mode = options.mode === 'auto' ? await classifyTarget(target) : options.mode;
  const plan = buildBootstrapPlan({
    platform: options.platform,
    mode,
    target,
    repositoryUrl: options.repositoryUrl,
  });
  if (options.plan) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (options.platform !== process.platform) fail('--platform may only override the OS in --plan mode');
  if (mode === 'existing') preflightExistingCheckout(target);
  preflightSafeChain(target, mode, options.safeChain);
  if (!options.approveSystemChanges) {
    fail('System changes were not approved. Review --plan, obtain one bundled confirmation, then add --approve-system-changes.');
  }

  if (options.platform === 'win32') prepareWindows();
  else prepareMac();

  if (mode === 'new') {
    authenticatedClone(options.repositoryUrl, target);
    verifyTemplateSymlinks(target);
    resolveSafeChain(target, options.safeChain, options.platform);
    initializeApplicationRepository(target);
  } else {
    repairTemplateSymlinks(target);
    resolveSafeChain(target, options.safeChain, options.platform);
  }
  runMakeInstall(target, mode);
  console.log(`Template ready at ${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
