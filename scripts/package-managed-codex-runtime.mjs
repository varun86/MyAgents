#!/usr/bin/env node
import AdmZip from 'adm-zip';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_CODEX_VERSION = '0.142.2';
const DEFAULT_APP_VERSION = '0.2.43';
const DEFAULT_BASE_URL = 'https://download.myagents.io/runtimes/codex/by-app';
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64'];

function parseArgs(argv) {
  const args = {
    codexVersion: DEFAULT_CODEX_VERSION,
    appVersion: DEFAULT_APP_VERSION,
    outDir: resolve('dist/managed-codex'),
    baseUrl: DEFAULT_BASE_URL,
    allowUnsigned: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--codex-version') args.codexVersion = argv[++i];
    else if (arg === '--app-version') args.appVersion = argv[++i];
    else if (arg === '--out') args.outDir = resolve(argv[++i]);
    else if (arg === '--base-url') args.baseUrl = argv[++i].replace(/\/$/, '');
    else if (arg === '--allow-unsigned') args.allowUnsigned = true;
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio ?? 'pipe',
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join('\n'));
  }
  return result.stdout ?? '';
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function findExecutable(root, platform) {
  const wanted = platform === 'win32-x64'
    ? new Set(['codex.exe', 'codex.cmd'])
    : new Set(['codex']);
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (entry.isFile() && wanted.has(entry.name)) {
        return relative(root, path).split('\\').join('/');
      }
    }
  }
  throw new Error(`Could not find Codex executable in packed ${platform} package`);
}

function packNpmPlatformPackage(tmpRoot, codexVersion, platform) {
  const packDir = join(tmpRoot, `pack-${platform}`);
  const extractDir = join(tmpRoot, `extract-${platform}`);
  mkdirSync(packDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });

  const spec = `@openai/codex@${codexVersion}-${platform}`;
  console.log(`[managed-codex] npm pack ${spec}`);
  const stdout = run('npm', ['pack', '--silent', '--pack-destination', packDir, spec]);
  const tgzName = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!tgzName) throw new Error(`npm pack did not return a tarball name for ${spec}`);
  const tgzPath = join(packDir, basename(tgzName));
  if (!existsSync(tgzPath)) throw new Error(`npm pack tarball missing: ${tgzPath}`);

  run('tar', ['-xzf', tgzPath, '-C', extractDir]);
  const packageDir = join(extractDir, 'package');
  if (!existsSync(packageDir)) throw new Error(`npm tarball did not contain package/: ${tgzPath}`);
  return packageDir;
}

function zipPackage(packageDir, zipPath) {
  mkdirSync(dirname(zipPath), { recursive: true });
  const zip = new AdmZip();
  zip.addLocalFolder(packageDir, '');
  zip.writeZip(zipPath);
  const stats = statSync(zipPath);
  const verifyZip = new AdmZip(zipPath);
  const entries = verifyZip.getEntries();
  const unpackedSizeBytes = entries.reduce((sum, entry) => (
    entry.isDirectory ? sum : sum + entry.header.size
  ), 0);
  return {
    archiveSizeBytes: stats.size,
    unpackedSizeBytes,
    entryCount: entries.length,
  };
}

function signArtifact(zipPath, allowUnsigned) {
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY;
  if (!key) {
    if (allowUnsigned) return '';
    throw new Error('TAURI_SIGNING_PRIVATE_KEY is required to sign Managed Codex artifacts');
  }
  const keyPath = join(tmpdir(), `myagents-managed-codex-key-${randomUUID()}`);
  writeFileSync(keyPath, key);
  chmodSync(keyPath, 0o600);
  try {
    const args = ['sign', '-k', keyPath];
    if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
      args.push('-p', process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD);
    }
    args.push(zipPath);
    run('tauri', args, { stdio: 'inherit' });
  } finally {
    rmSync(keyPath, { force: true });
  }

  const sigPath = `${zipPath}.sig`;
  if (!existsSync(sigPath)) throw new Error(`tauri signer did not create ${sigPath}`);
  return readFileSync(sigPath, 'utf8').trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const appOutDir = join(args.outDir, 'by-app', args.appVersion);
  const artifactDir = join(appOutDir, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });

  const tmpRoot = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
  const artifacts = {};
  try {
    for (const platform of PLATFORMS) {
      const packageDir = packNpmPlatformPackage(tmpRoot, args.codexVersion, platform);
      const executableRelativePath = findExecutable(packageDir, platform);
      const zipName = `managed-codex-${args.codexVersion}-${platform}.zip`;
      const zipPath = join(artifactDir, zipName);
      const archiveStats = zipPackage(packageDir, zipPath);
      const sha256 = sha256File(zipPath);
      writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`);
      const signature = signArtifact(zipPath, args.allowUnsigned);
      artifacts[platform] = {
        url: `${args.baseUrl}/${args.appVersion}/artifacts/${zipName}`,
        sha256,
        signature,
        executableRelativePath,
        archiveType: 'zip',
        ...archiveStats,
      };
      console.log(`[managed-codex] ${platform}: ${zipName} ${archiveStats.archiveSizeBytes} bytes`);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  const manifest = {
    schemaVersion: 1,
    appVersion: args.appVersion,
    codexVersion: args.codexVersion,
    generatedAt: new Date().toISOString(),
    artifacts,
  };
  const manifestPath = join(appOutDir, 'manifest-v1.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[managed-codex] wrote ${manifestPath}`);
  console.log(`[managed-codex] upload ${appOutDir}/ to R2 path runtimes/codex/by-app/${args.appVersion}/`);
}

main();
