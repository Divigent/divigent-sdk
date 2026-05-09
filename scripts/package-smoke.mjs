import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'divigent-sdk-package-smoke-'));
const npmCache = process.env.DIVIGENT_PACKAGE_SMOKE_NPM_CACHE ?? '/private/tmp/divigent-npm-cache';
const npmHome = join(tmp, 'npm-home');
const npmLogs = join(tmp, 'npm-logs');
const npmUserConfig = join(tmp, '.npmrc');
mkdirSync(npmCache, { recursive: true });
mkdirSync(npmHome, { recursive: true });
mkdirSync(npmLogs, { recursive: true });
writeFileSync(npmUserConfig, [
  `cache=${npmCache}`,
  `logs-dir=${npmLogs}`,
  'audit=false',
  'fund=false',
].join('\n'));

function npmEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith('npm_config_')) {
      delete env[key];
      continue;
    }
    if (key.startsWith('NPM_CONFIG_')) delete env[key];
  }
  return {
    ...env,
    HOME: npmHome,
    USERPROFILE: npmHome,
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_logs_dir: npmLogs,
    NPM_CONFIG_LOGS_DIR: npmLogs,
    npm_config_userconfig: npmUserConfig,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    env: npmEnv(),
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function symlinkPackage(name) {
  const source = join(root, 'node_modules', name);
  const target = join(tmp, 'node_modules', name);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target, 'dir');
}

try {
  const packOutput = spawnSync('npm', [
    '--cache',
    npmCache,
    'pack',
    '--json',
    '--pack-destination',
    tmp,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: npmEnv(),
  });
  if (packOutput.status !== 0) {
    process.stderr.write(packOutput.stderr);
    throw new Error(`npm pack failed with exit code ${packOutput.status}`);
  }
  const [{ filename }] = JSON.parse(packOutput.stdout);
  const tarball = join(tmp, filename);

  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2));
  run('npm', [
    '--cache',
    npmCache,
    'install',
    tarball,
    '--legacy-peer-deps',
    '--ignore-scripts',
    '--no-audit',
  ], { cwd: tmp });

  symlinkPackage('viem');
  symlinkPackage('@x402/core');

  writeFileSync(join(tmp, 'esm.mjs'), [
    "import { Divigent, parseUsdc, formatUsdc } from '@divigent/sdk';",
    "if (typeof Divigent.create !== 'function') throw new Error('Divigent.create missing');",
    "if (typeof Divigent.prototype.attachTo !== 'function') throw new Error('Divigent.attachTo missing');",
    "if (formatUsdc(parseUsdc('1.230000')) !== '1.23') throw new Error('USDC helpers broken');",
  ].join('\n'));
  run('node', ['esm.mjs'], { cwd: tmp });

  writeFileSync(join(tmp, 'cjs.cjs'), [
    "const sdk = require('@divigent/sdk');",
    "if (typeof sdk.Divigent.create !== 'function') throw new Error('CJS Divigent.create missing');",
    "if (sdk.formatUsdc(sdk.parseUsdc('2.500000')) !== '2.5') throw new Error('CJS USDC helpers broken');",
  ].join('\n'));
  run('node', ['cjs.cjs'], { cwd: tmp });

  writeFileSync(join(tmp, 'types.ts'), [
    "import { Divigent, parseUsdc, type DepositPlan } from '@divigent/sdk';",
    "const amount: bigint = parseUsdc('1');",
    "const create: typeof Divigent.create = Divigent.create;",
    "const _plan = null as unknown as DepositPlan;",
    "void amount;",
    "void create;",
    "void _plan;",
  ].join('\n'));
  run('node', [
    join(root, 'node_modules/typescript/bin/tsc'),
    '--target', 'ES2022',
    '--module', 'ESNext',
    '--moduleResolution', 'Bundler',
    '--strict',
    '--skipLibCheck',
    '--noEmit',
    'types.ts',
  ], { cwd: tmp });

  const installedPkg = JSON.parse(
    readFileSync(join(tmp, 'node_modules/@divigent/sdk/package.json'), 'utf8'),
  );
  if (installedPkg.files?.includes('src')) {
    throw new Error('package unexpectedly publishes src directory');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
