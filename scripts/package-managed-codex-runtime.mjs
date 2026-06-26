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

function defaultPlatformsForHost() {
  if (process.platform === 'darwin') return ['darwin-arm64', 'darwin-x64'];
  if (process.platform === 'win32') return ['win32-x64'];
  throw new Error('Managed Codex runtime packaging is only supported on macOS and Windows hosts unless --platforms is provided');
}

function parseArgs(argv) {
  const args = {
    codexVersion: DEFAULT_CODEX_VERSION,
    appVersion: DEFAULT_APP_VERSION,
    outDir: resolve('dist/managed-codex'),
    baseUrl: DEFAULT_BASE_URL,
    allowUnsigned: false,
    platforms: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--codex-version') args.codexVersion = argv[++i];
    else if (arg === '--app-version') args.appVersion = argv[++i];
    else if (arg === '--out') args.outDir = resolve(argv[++i]);
    else if (arg === '--base-url') args.baseUrl = argv[++i].replace(/\/$/, '');
    else if (arg === '--platforms') args.platforms = argv[++i].split(',').map(p => p.trim()).filter(Boolean);
    else if (arg === '--allow-unsigned') args.allowUnsigned = true;
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  args.platforms ??= defaultPlatformsForHost();
  for (const platform of args.platforms) {
    if (!PLATFORMS.includes(platform)) {
      throw new Error(`Unsupported Managed Codex platform: ${platform}`);
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
    const renderedArgs = args.map((arg) => (
      /password|private[-_]?key|secret|token/i.test(arg) ? '<redacted>' : arg
    ));
    throw new Error([
      `Command failed: ${command} ${renderedArgs.join(' ')}`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join('\n'));
  }
  return result.stdout ?? '';
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio ?? 'pipe',
    encoding: 'utf8',
    ...options,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha1File(path) {
  return createHash('sha1').update(readFileSync(path)).digest('hex');
}

function sha512IntegrityFile(path) {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
}

function normalizeSha256(value, label) {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 64-character SHA-256 hex string`);
  }
  return normalized;
}

function verifyNpmDistMetadata(tgzPath, npmDist, spec) {
  const actualShasum = sha1File(tgzPath);
  const actualIntegrity = sha512IntegrityFile(tgzPath);
  if (!npmDist?.shasum || npmDist.shasum !== actualShasum) {
    throw new Error(`npm shasum mismatch for ${spec}: expected ${npmDist?.shasum ?? '<missing>'}, got ${actualShasum}`);
  }
  if (!npmDist?.integrity || npmDist.integrity !== actualIntegrity) {
    throw new Error(`npm integrity mismatch for ${spec}: expected ${npmDist?.integrity ?? '<missing>'}, got ${actualIntegrity}`);
  }
  return { shasum: actualShasum, integrity: actualIntegrity };
}

function listPackageFiles(packageDir) {
  const files = [];
  const queue = [''];
  while (queue.length > 0) {
    const relDir = queue.shift();
    const absDir = join(packageDir, relDir);
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const rel = join(relDir, entry.name).split('\\').join('/');
      if (entry.isSymbolicLink()) {
        throw new Error(`Managed Codex package contains unsupported symlink: ${rel}`);
      }
      if (entry.isDirectory()) {
        queue.push(rel);
      } else if (entry.isFile()) {
        files.push(rel);
      } else {
        throw new Error(`Managed Codex package contains unsupported special file: ${rel}`);
      }
    }
  }
  files.sort();
  if (files.length === 0) throw new Error(`Managed Codex package has no files: ${packageDir}`);
  return files;
}

function npmDistMetadata(spec) {
  try {
    const raw = run('npm', ['view', spec, 'dist', '--json']);
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[managed-codex] warning: failed to read npm dist metadata for ${spec}: ${err.message}`);
    return {};
  }
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
  const npmDist = npmDistMetadata(spec);
  const verifiedDist = verifyNpmDistMetadata(tgzPath, npmDist, spec);

  run('tar', ['-xzf', tgzPath, '-C', extractDir]);
  const packageDir = join(extractDir, 'package');
  if (!existsSync(packageDir)) throw new Error(`npm tarball did not contain package/: ${tgzPath}`);
  return {
    packageDir,
    npmSpec: spec,
    npmTarballPath: tgzPath,
    npmDist,
    verifiedDist,
  };
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

function signFile(filePath, allowUnsigned, label) {
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY;
  if (!key) {
    if (allowUnsigned) return '';
    throw new Error(`TAURI_SIGNING_PRIVATE_KEY is required to sign Managed Codex ${label}`);
  }
  const keyPath = join(tmpdir(), `myagents-managed-codex-key-${randomUUID()}`);
  writeFileSync(keyPath, key);
  chmodSync(keyPath, 0o600);
  try {
    const env = { ...process.env };
    const password = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? env.TAURI_PRIVATE_KEY_PASSWORD;
    if (password) env.TAURI_PRIVATE_KEY_PASSWORD = password;
    const args = ['tauri', 'signer', 'sign', '-f', keyPath, filePath];
    run('npx', args, { stdio: 'inherit', env });
  } finally {
    rmSync(keyPath, { force: true });
  }

  const sigPath = `${filePath}.sig`;
  if (!existsSync(sigPath)) throw new Error(`tauri signer did not create ${sigPath}`);
  return readFileSync(sigPath, 'utf8').trim();
}

function signingSpecForPlatform(platform, allowUnsigned) {
  if (platform.startsWith('darwin-')) {
    const teamId = process.env.MANAGED_CODEX_MACOS_TEAM_ID?.trim();
    const signingIdentity = process.env.MANAGED_CODEX_MACOS_SIGNING_IDENTITY?.trim();
    if (!teamId) {
      if (allowUnsigned) return undefined;
      throw new Error('MANAGED_CODEX_MACOS_TEAM_ID is required for Managed Codex macOS artifact metadata');
    }
    return {
      type: 'codesign',
      teamId,
      ...(signingIdentity ? { signingIdentity } : {}),
      notarization: 'spctl-assess',
    };
  }
  if (platform === 'win32-x64') {
    const certificateSha256 = process.env.MANAGED_CODEX_WINDOWS_CERT_SHA256?.trim();
    const publisher = process.env.MANAGED_CODEX_WINDOWS_PUBLISHER?.trim();
    if (!certificateSha256) {
      if (allowUnsigned) return undefined;
      throw new Error('MANAGED_CODEX_WINDOWS_CERT_SHA256 is required for Managed Codex Windows artifact metadata');
    }
    return {
      type: 'authenticode',
      ...(publisher ? { publisher } : {}),
      certificateSha256: normalizeSha256(certificateSha256, 'MANAGED_CODEX_WINDOWS_CERT_SHA256'),
    };
  }
  throw new Error(`Unsupported Managed Codex platform: ${platform}`);
}

function verifyMacSigning(executablePath, signing) {
  if (process.platform !== 'darwin') {
    return { checked: false, reason: 'not-macos-host' };
  }
  const verify = tryRun('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', executablePath]);
  if (!verify.ok) {
    throw new Error(`codesign verify failed for ${executablePath}\n${verify.stderr || verify.stdout}`);
  }
  const details = tryRun('/usr/bin/codesign', ['-dv', '--verbose=4', executablePath]);
  if (!details.ok) {
    throw new Error(`codesign details failed for ${executablePath}\n${details.stderr || details.stdout}`);
  }
  const combined = `${details.stdout}\n${details.stderr}`;
  const teamId = combined.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (teamId !== signing.teamId) {
    throw new Error(`codesign Team ID mismatch for ${executablePath}: expected ${signing.teamId}, got ${teamId || '<none>'}`);
  }
  const assess = tryRun('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', executablePath]);
  if (!assess.ok) {
    throw new Error(`spctl assess failed for ${executablePath}\n${assess.stderr || assess.stdout}`);
  }
  return {
    checked: true,
    type: 'codesign',
    teamId,
    notarization: 'spctl-assess',
  };
}

function psSingleQuote(value) {
  return value.replace(/'/g, "''");
}

function verifyWindowsSigning(executablePath, signing) {
  if (process.platform !== 'win32') {
    return { checked: false, reason: 'not-windows-host' };
  }
  const script = `
$ErrorActionPreference = 'Stop'
$sig = Get-AuthenticodeSignature -LiteralPath '${psSingleQuote(executablePath)}'
$cert = $sig.SignerCertificate
$sha256 = $null
if ($cert -ne $null) {
  $sha256 = [System.BitConverter]::ToString($cert.GetCertHash('SHA256')).Replace('-', '').ToLowerInvariant()
}
[ordered]@{
  status = [string]$sig.Status
  statusMessage = [string]$sig.StatusMessage
  subject = if ($cert -ne $null) { [string]$cert.Subject } else { $null }
  sha256 = $sha256
} | ConvertTo-Json -Compress
`;
  const result = tryRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (!result.ok) {
    throw new Error(`Get-AuthenticodeSignature failed for ${executablePath}\n${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout.trim());
  if (parsed.status !== 'Valid') {
    throw new Error(`Authenticode status for ${executablePath} is ${parsed.status}: ${parsed.statusMessage ?? ''}`);
  }
  const actualSha = normalizeSha256(parsed.sha256, 'Authenticode signer certificate SHA-256');
  if (actualSha !== signing.certificateSha256) {
    throw new Error(`Authenticode cert SHA-256 mismatch: expected ${signing.certificateSha256}, got ${actualSha}`);
  }
  if (signing.publisher && !String(parsed.subject ?? '').toLowerCase().includes(signing.publisher.toLowerCase())) {
    throw new Error(`Authenticode publisher mismatch: expected ${signing.publisher}, got ${parsed.subject ?? '<none>'}`);
  }
  return {
    checked: true,
    type: 'authenticode',
    publisher: parsed.subject ?? null,
    certificateSha256: actualSha,
  };
}

function verifyPlatformSigning(platform, executablePath, signing) {
  if (!signing) {
    return { checked: false, reason: 'unsigned-development-artifact' };
  }
  if (platform.startsWith('darwin-')) return verifyMacSigning(executablePath, signing);
  if (platform === 'win32-x64') return verifyWindowsSigning(executablePath, signing);
  throw new Error(`Unsupported Managed Codex platform: ${platform}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const appOutDir = join(args.outDir, 'by-app', args.appVersion);
  rmSync(appOutDir, { recursive: true, force: true });

  const tmpRoot = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
  try {
    for (const platform of args.platforms) {
      const platformOutDir = join(appOutDir, platform);
      const artifactDir = join(platformOutDir, 'artifacts');
      mkdirSync(artifactDir, { recursive: true });

      const packed = packNpmPlatformPackage(tmpRoot, args.codexVersion, platform);
      const packageDir = packed.packageDir;
      const executableRelativePath = findExecutable(packageDir, platform);
      const fileAllowlist = listPackageFiles(packageDir);
      if (!fileAllowlist.includes(executableRelativePath)) {
        throw new Error(`Managed Codex fileAllowlist does not contain executable ${executableRelativePath}`);
      }
      const executablePath = join(packageDir, executableRelativePath);
      const signing = signingSpecForPlatform(platform, args.allowUnsigned);
      const signingVerification = verifyPlatformSigning(platform, executablePath, signing);
      if (!args.allowUnsigned && signingVerification.checked !== true) {
        throw new Error(
          `Managed Codex ${platform} platform signing was not verified on this release host: ${signingVerification.reason ?? 'unknown'}`,
        );
      }
      const zipName = `managed-codex-${args.codexVersion}-${platform}.zip`;
      const zipPath = join(artifactDir, zipName);
      const archiveStats = zipPackage(packageDir, zipPath);
      const sha256 = sha256File(zipPath);
      writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`);
      const signature = signFile(zipPath, args.allowUnsigned, 'artifact');
      const artifacts = {};
      artifacts[platform] = {
        url: `${args.baseUrl}/${args.appVersion}/${platform}/artifacts/${zipName}`,
        sha256,
        signature,
        ...(signing ? { signing } : {}),
        executableRelativePath,
        fileAllowlist,
        archiveType: 'zip',
        ...archiveStats,
      };
      const audit = {
        schemaVersion: 1,
        appVersion: args.appVersion,
        codexVersion: args.codexVersion,
        platform,
        generatedAt: new Date().toISOString(),
        artifact: {
          npmSpec: packed.npmSpec,
          npmTarball: packed.npmDist?.tarball,
          npmIntegrity: packed.verifiedDist.integrity,
          npmShasum: packed.verifiedDist.shasum,
          executableRelativePath,
          fileAllowlistCount: fileAllowlist.length,
          archiveName: zipName,
          sha256,
          signature,
          ...archiveStats,
          signingVerification,
        },
      };
      const manifest = {
        schemaVersion: 1,
        appVersion: args.appVersion,
        codexVersion: args.codexVersion,
        platform,
        generatedAt: new Date().toISOString(),
        artifacts,
      };
      const manifestPath = join(platformOutDir, 'manifest-v1.json');
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const manifestSignature = signFile(manifestPath, args.allowUnsigned, 'manifest');
      if (manifestSignature) {
        writeFileSync(`${manifestPath}.sig`, `${manifestSignature}\n`);
      }
      audit.manifestSignature = manifestSignature || undefined;
      writeFileSync(join(platformOutDir, 'release-audit-v1.json'), `${JSON.stringify(audit, null, 2)}\n`);
      console.log(`[managed-codex] ${platform}: ${zipName} ${archiveStats.archiveSizeBytes} bytes`);
      console.log(`[managed-codex] wrote ${manifestPath}`);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log(`[managed-codex] upload ${appOutDir}/ to R2 path runtimes/codex/by-app/${args.appVersion}/`);
}

main();
