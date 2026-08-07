#!/usr/bin/env node
import AdmZip from 'adm-zip';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  formatCommandFailure,
  resolveSpawnInvocation,
} from './package-managed-codex-spawn.js';
import {
  isCanonicalCodexVersion,
  managedCodexMacHelperSigningCandidates,
  managedCodexSignerEnv,
  resolveManagedCodexPackageIdentity,
  shouldSignManagedCodexPackage,
} from './package-managed-codex-policy.js';

const RUNTIME_LOCK_SOURCE = new URL('../src/shared/managed-codex-runtime.json', import.meta.url);
const DEFAULT_RUNTIME_LOCK = readRuntimeLock();
const DEFAULT_CODEX_VERSION = DEFAULT_RUNTIME_LOCK.version;
const DEFAULT_BASE_URL = 'https://download.myagents.io/runtimes/codex/sets';
const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_NPM_DOWNLOAD_REGISTRY = 'https://registry.npmmirror.com';
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
const RUNTIME_SET_RE = /^codex-[0-9A-Za-z._-]+$/;
const DEFAULT_MACOS_CODEX_TEAM_ID = '2DC432GLL2';
const DEFAULT_MACOS_CODEX_SIGNING_IDENTITY = 'Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)';
const DEFAULT_WINDOWS_CODEX_PUBLISHER = 'OpenAI OpCo, LLC';

function readRuntimeLock() {
  const lock = JSON.parse(readFileSync(RUNTIME_LOCK_SOURCE, 'utf8'));
  const version = lock.version;
  if (!isCanonicalCodexVersion(version)) {
    throw new Error(`Managed Codex runtime lock requires a canonical semver version: ${RUNTIME_LOCK_SOURCE.pathname}`);
  }
  return { version };
}

function defaultPlatformsForHost() {
  if (process.platform === 'darwin') return ['darwin-arm64', 'darwin-x64'];
  if (process.platform === 'win32') return ['win32-x64'];
  throw new Error('Managed Codex runtime packaging is only supported on macOS and Windows hosts unless --platforms is provided');
}

function parseArgs(argv) {
  const args = {
    codexVersion: DEFAULT_CODEX_VERSION,
    outDir: resolve('dist/managed-codex'),
    baseUrl: DEFAULT_BASE_URL,
    allowUnsigned: false,
    platforms: null,
  };
  const readValue = (index, option) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--codex-version') args.codexVersion = readValue(i++, arg);
    else if (arg === '--out') args.outDir = resolve(readValue(i++, arg));
    else if (arg === '--base-url') args.baseUrl = readValue(i++, arg).replace(/\/$/, '');
    else if (arg === '--platforms') args.platforms = readValue(i++, arg).split(',').map(p => p.trim()).filter(Boolean);
    else if (arg === '--allow-unsigned') args.allowUnsigned = true;
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const identity = resolveManagedCodexPackageIdentity({
    lockedVersion: DEFAULT_CODEX_VERSION,
    requestedVersion: args.codexVersion,
    allowUnsigned: args.allowUnsigned,
  });
  args.codexVersion = identity.codexVersion;
  args.runtimeSet = identity.runtimeSet;
  args.platforms ??= defaultPlatformsForHost();
  if (!RUNTIME_SET_RE.test(args.runtimeSet)) {
    throw new Error(`Invalid runtime set: ${args.runtimeSet}`);
  }
  for (const platform of args.platforms) {
    if (!PLATFORMS.includes(platform)) {
      throw new Error(`Unsupported Managed Codex platform: ${platform}`);
    }
  }
  return args;
}

function run(command, args, options = {}) {
  const invocation = resolveSpawnInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: options.stdio ?? 'pipe',
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(formatCommandFailure(invocation.displayCommand, invocation.displayArgs, result));
  }
  return result.stdout ?? '';
}

function tryRun(command, args, options = {}) {
  const invocation = resolveSpawnInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: options.stdio ?? 'pipe',
    encoding: 'utf8',
    ...options,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
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
    const raw = run('npm', [
      'view',
      spec,
      'dist',
      '--json',
      `--registry=${OFFICIAL_NPM_REGISTRY}`,
    ]);
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[managed-codex] warning: failed to read npm dist metadata for ${spec}: ${err.message}`);
    return {};
  }
}

function downloadTarball(url, outPath, spec) {
  if (!url) {
    throw new Error(`npm dist metadata did not include tarball URL for ${spec}`);
  }
  console.log(`[managed-codex] fetch npm package ${spec}`);
  rmSync(outPath, { force: true });
  const packArgs = [
    'pack',
    spec,
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    dirname(outPath),
  ];
  const registry = process.env.MANAGED_CODEX_NPM_DOWNLOAD_REGISTRY?.trim()
    || DEFAULT_NPM_DOWNLOAD_REGISTRY;
  let offline = tryRun('npm', [...packArgs, '--offline']);
  if (!offline.ok && registry !== OFFICIAL_NPM_REGISTRY) {
    offline = tryRun('npm', [...packArgs, '--offline', `--registry=${registry}`]);
  }
  let packedOutput;
  if (offline.ok) {
    console.log(`[managed-codex] npm cache hit ${spec}`);
    packedOutput = offline.stdout;
  } else {
    console.log(`[managed-codex] npm cache miss; download via ${registry}`);
    try {
      packedOutput = run('npm', [...packArgs, `--registry=${registry}`]);
    } catch (mirrorError) {
      if (registry === OFFICIAL_NPM_REGISTRY) throw mirrorError;
      console.warn(`[managed-codex] mirror download failed; retry official npm registry`);
      packedOutput = run('npm', [...packArgs, `--registry=${OFFICIAL_NPM_REGISTRY}`]);
    }
  }
  const packed = JSON.parse(packedOutput);
  const filename = Array.isArray(packed) ? packed[0]?.filename : undefined;
  if (!filename || basename(filename) !== filename) {
    throw new Error(`npm pack did not return a safe tarball filename for ${spec}`);
  }
  const packedPath = join(dirname(outPath), filename);
  if (!existsSync(packedPath)) {
    throw new Error(`npm pack did not create ${packedPath}`);
  }
  if (resolve(packedPath) !== resolve(outPath)) {
    renameSync(packedPath, outPath);
  }
  if (!existsSync(outPath)) {
    throw new Error(`Downloaded npm tarball missing: ${outPath}`);
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
  console.log(`[managed-codex] fetch npm metadata ${spec}`);
  const npmDist = npmDistMetadata(spec);
  if (!npmDist?.tarball) {
    throw new Error(`npm dist metadata did not include tarball URL for ${spec}`);
  }
  const tarballName = basename(new URL(npmDist.tarball).pathname);
  const tgzPath = join(packDir, tarballName);
  downloadTarball(npmDist.tarball, tgzPath, spec);
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
  if (!shouldSignManagedCodexPackage({ allowUnsigned })) return '';
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY;
  if (!key) {
    throw new Error(`TAURI_SIGNING_PRIVATE_KEY is required to sign Managed Codex ${label}`);
  }
  const keyPath = join(tmpdir(), `myagents-managed-codex-key-${randomUUID()}`);
  writeFileSync(keyPath, key);
  chmodSync(keyPath, 0o600);
  try {
    const env = managedCodexSignerEnv(process.env);
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
    const teamId = process.env.MANAGED_CODEX_MACOS_TEAM_ID?.trim() || DEFAULT_MACOS_CODEX_TEAM_ID;
    const signingIdentity = process.env.MANAGED_CODEX_MACOS_SIGNING_IDENTITY?.trim()
      || DEFAULT_MACOS_CODEX_SIGNING_IDENTITY;
    return {
      type: 'codesign',
      teamId,
      signingIdentity,
    };
  }
  if (platform === 'win32-x64') {
    if (allowUnsigned) return undefined;
    const publisher = process.env.MANAGED_CODEX_WINDOWS_PUBLISHER?.trim()
      || DEFAULT_WINDOWS_CODEX_PUBLISHER;
    return {
      type: 'authenticode',
      publisher,
    };
  }
  throw new Error(`Unsupported Managed Codex platform: ${platform}`);
}

function readWindowsAuthenticode(executablePath) {
  const script = `
$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$sig = Get-AuthenticodeSignature -LiteralPath '${psSingleQuote(executablePath)}'
$cert = $sig.SignerCertificate
$sha256 = $null
if ($cert -ne $null) {
  $sha256 = [System.BitConverter]::ToString($cert.GetCertHash('SHA256')).Replace('-', '').ToLowerInvariant()
}
$json = [ordered]@{
  status = [string]$sig.Status
  statusMessage = [string]$sig.StatusMessage
  subject = if ($cert -ne $null) { [string]$cert.Subject } else { $null }
  sha256 = $sha256
} | ConvertTo-Json -Compress
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
`;
  const result = tryRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (!result.ok) {
    throw new Error(`Get-AuthenticodeSignature failed for ${executablePath}\n${result.error?.message || result.stderr || result.stdout}`);
  }
  const encodedJson = result.stdout.replace(/[^A-Za-z0-9+/=]/g, '');
  return JSON.parse(Buffer.from(encodedJson, 'base64').toString('utf8'));
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
  const authorities = [...combined.matchAll(/^Authority=(.+)$/gm)].map(match => match[1].trim());
  if (!teamId) {
    throw new Error(`codesign details did not include TeamIdentifier for ${executablePath}`);
  }
  if (signing.teamId && teamId !== signing.teamId) {
    throw new Error(`codesign Team ID mismatch for ${executablePath}: expected ${signing.teamId}, got ${teamId || '<none>'}`);
  }
  if (signing.signingIdentity && !authorities.includes(signing.signingIdentity)) {
    throw new Error(
      `codesign identity mismatch for ${executablePath}: expected ${signing.signingIdentity}, `
      + `got ${authorities[0] || '<none>'}`,
    );
  }
  return {
    checked: true,
    type: 'codesign',
    teamId,
    signingIdentity: authorities[0] || signing.signingIdentity,
  };
}

function psSingleQuote(value) {
  return value.replace(/'/g, "''");
}

function verifyWindowsSigning(executablePath, signing) {
  if (process.platform !== 'win32') {
    return { checked: false, reason: 'not-windows-host' };
  }
  const parsed = readWindowsAuthenticode(executablePath);
  if (parsed.status !== 'Valid') {
    throw new Error(`Authenticode status for ${executablePath} is ${parsed.status}: ${parsed.statusMessage ?? ''}`);
  }
  const actualSha = normalizeSha256(parsed.sha256, 'Authenticode signer certificate SHA-256');
  if (signing.certificateSha256 && actualSha !== signing.certificateSha256) {
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

function verifyWindowsUnsignedHelper(executablePath) {
  if (process.platform !== 'win32') {
    return { checked: false, reason: 'not-windows-host' };
  }
  const parsed = readWindowsAuthenticode(executablePath);
  if (parsed.status !== 'NotSigned') {
    throw new Error(
      `Managed Codex unsigned Windows helper policy expected NotSigned for ${executablePath}, ` +
      `got ${parsed.status}: ${parsed.statusMessage ?? ''}`,
    );
  }
  return {
    checked: true,
    type: 'unsigned-helper',
    status: parsed.status,
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

function isNativeExecutableForPlatform(path, platform) {
  const header = Buffer.alloc(4);
  const fd = openSync(path, 'r');
  try {
    if (readSync(fd, header, 0, header.length, 0) < 2) return false;
  } finally {
    closeSync(fd);
  }
  if (platform === 'win32-x64') {
    return header[0] === 0x4d && header[1] === 0x5a;
  }
  const magic = header.readUInt32BE(0);
  return new Set([
    0xfeedface,
    0xcefaedfe,
    0xfeedfacf,
    0xcffaedfe,
    0xcafebabe,
    0xbebafeca,
    0xcafebabf,
    0xbfbafeca,
  ]).has(magic);
}

function macNativePathPolicy(platform) {
  const vendorTriple = platform === 'darwin-arm64'
    ? 'aarch64-apple-darwin'
    : 'x86_64-apple-darwin';
  const codexPath = `vendor/${vendorTriple}/bin/codex`;
  return {
    codexPath,
    openAiSignedPaths: new Set([
      codexPath,
      `vendor/${vendorTriple}/bin/codex-code-mode-host`,
    ]),
    helperPaths: new Set([
      `vendor/${vendorTriple}/codex-path/rg`,
      `vendor/${vendorTriple}/codex-resources/zsh/bin/zsh`,
    ]),
  };
}

function windowsNativePathPolicy() {
  const vendorTriple = 'x86_64-pc-windows-msvc';
  const codexPath = `vendor/${vendorTriple}/bin/codex.exe`;
  return {
    codexPath,
    openAiSignedPaths: new Set([
      codexPath,
      `vendor/${vendorTriple}/bin/codex-code-mode-host.exe`,
      `vendor/${vendorTriple}/codex-resources/codex-command-runner.exe`,
      `vendor/${vendorTriple}/codex-resources/codex-windows-sandbox-setup.exe`,
    ]),
    unsignedHelperPaths: new Set([
      `vendor/${vendorTriple}/codex-path/rg.exe`,
    ]),
  };
}

function teamIdFromSigningIdentity(identity) {
  const teamId = identity.match(/\(([A-Z0-9]{10})\)\s*$/)?.[1];
  if (!teamId) {
    throw new Error(`Cannot derive Apple Team ID from signing identity: ${identity}`);
  }
  return teamId;
}

function prepareMacHelperSigning(platform, packageDir, allowUnsigned) {
  if (!platform.startsWith('darwin-')) {
    return { helperSigningByPath: new Map(), preparations: [] };
  }
  if (process.platform !== 'darwin') {
    return { helperSigningByPath: new Map(), preparations: [] };
  }

  const { helperPaths } = macNativePathPolicy(platform);
  const upstreamSigning = signingSpecForPlatform(platform, allowUnsigned);
  const signingCandidates = managedCodexMacHelperSigningCandidates(upstreamSigning);
  const helperSigningByPath = new Map();
  const preparations = [];
  for (const relativePath of helperPaths) {
    const helperPath = join(packageDir, relativePath);
    if (!existsSync(helperPath)) {
      throw new Error(`Managed Codex ${platform} missing pinned native helper: ${relativePath}`);
    }

    let signedVerificationError;
    let preservedSignedHelper = false;
    for (const candidate of signingCandidates) {
      try {
        const verification = verifyMacSigning(helperPath, candidate.signing);
        helperSigningByPath.set(relativePath, candidate.signing);
        preparations.push({
          relativePath,
          action: candidate.action,
          teamId: verification.teamId,
          signingIdentity: verification.signingIdentity,
        });
        preservedSignedHelper = true;
        break;
      } catch (verificationError) {
        signedVerificationError ??= verificationError;
      }
    }
    if (preservedSignedHelper) continue;

    const details = tryRun('/usr/bin/codesign', ['-dv', '--verbose=4', helperPath]);
    const detailOutput = `${details.stdout}\n${details.stderr}`;
    if (!detailOutput.includes('code object is not signed at all')) {
      throw signedVerificationError;
    }

    const identity = allowUnsigned
      ? '-'
      : (process.env.MANAGED_CODEX_MACOS_HELPER_SIGNING_IDENTITY?.trim()
        || process.env.APPLE_SIGNING_IDENTITY?.trim());
    if (!identity) {
      throw new Error(
        `APPLE_SIGNING_IDENTITY is required to sign unsigned Managed Codex ${platform} helpers`,
      );
    }
    const signArgs = ['--force', '--sign', identity];
    if (identity !== '-') signArgs.push('--timestamp', '--options', 'runtime');
    signArgs.push(helperPath);
    run('/usr/bin/codesign', signArgs, { stdio: 'inherit' });

    const expectedSigning = identity === '-'
      ? { type: 'codesign', teamId: 'not set' }
      : {
          type: 'codesign',
          teamId: teamIdFromSigningIdentity(identity),
          signingIdentity: identity,
        };
    const verification = verifyMacSigning(helperPath, expectedSigning);
    helperSigningByPath.set(relativePath, expectedSigning);
    preparations.push({
      relativePath,
      action: identity === '-' ? 'added-local-ad-hoc-signature' : 'added-myagents-developer-id-signature',
      teamId: verification.teamId,
      signingIdentity: verification.signingIdentity,
    });
  }
  return { helperSigningByPath, preparations };
}

function verifyPackageNativeSigning(
  platform,
  packageDir,
  fileAllowlist,
  executableRelativePath,
  signing,
  helperSigningByPath,
) {
  const nativePaths = fileAllowlist.filter(relativePath => (
    isNativeExecutableForPlatform(join(packageDir, relativePath), platform)
  ));
  if (nativePaths.length === 0) {
    throw new Error(`Managed Codex ${platform} package has no native executables to verify`);
  }
  if (platform.startsWith('darwin-')) {
    const policy = macNativePathPolicy(platform);
    const expectedPaths = new Set([...policy.openAiSignedPaths, ...policy.helperPaths]);
    if (
      nativePaths.length !== expectedPaths.size
      || nativePaths.some(relativePath => !expectedPaths.has(relativePath))
    ) {
      throw new Error(
        `Managed Codex ${platform} native file set changed: ${nativePaths.join(', ')}`,
      );
    }
  }
  if (platform === 'win32-x64') {
    const policy = windowsNativePathPolicy();
    const expectedPaths = new Set([...policy.openAiSignedPaths, ...policy.unsignedHelperPaths]);
    if (
      nativePaths.length !== expectedPaths.size
      || nativePaths.some(relativePath => !expectedPaths.has(relativePath))
    ) {
      throw new Error(
        `Managed Codex ${platform} native file set changed: ${nativePaths.join(', ')}`,
      );
    }
  }
  return nativePaths.map((relativePath) => {
    let nativeSigning = signing;
    if (platform.startsWith('darwin-')) {
      const policy = macNativePathPolicy(platform);
      if (executableRelativePath !== policy.codexPath) {
        throw new Error(
          `Managed Codex ${platform} executable moved from its pinned path: ${executableRelativePath}`,
        );
      }
      if (policy.openAiSignedPaths.has(relativePath)) {
        nativeSigning = signing;
      } else if (policy.helperPaths.has(relativePath)) {
        nativeSigning = helperSigningByPath.get(relativePath);
        if (!nativeSigning) {
          throw new Error(`Managed Codex ${platform} helper was not prepared: ${relativePath}`);
        }
      } else {
        throw new Error(
          `Managed Codex ${platform} contains an unrecognized native helper: ${relativePath}`,
        );
      }
    } else if (platform === 'win32-x64') {
      const policy = windowsNativePathPolicy();
      if (executableRelativePath !== policy.codexPath) {
        throw new Error(
          `Managed Codex ${platform} executable moved from its pinned path: ${executableRelativePath}`,
        );
      }
      if (policy.openAiSignedPaths.has(relativePath)) {
        nativeSigning = signing;
      } else if (policy.unsignedHelperPaths.has(relativePath)) {
        const verification = verifyWindowsUnsignedHelper(join(packageDir, relativePath));
        if (verification.checked !== true) {
          throw new Error(
            `Managed Codex ${platform} unsigned helper was not verified for ${relativePath}: ` +
            `${verification.reason ?? 'unknown'}`,
          );
        }
        return { relativePath, ...verification };
      } else {
        throw new Error(
          `Managed Codex ${platform} contains an unrecognized native helper: ${relativePath}`,
        );
      }
    }
    const verification = verifyPlatformSigning(platform, join(packageDir, relativePath), nativeSigning);
    if (nativeSigning && verification.checked !== true) {
      throw new Error(
        `Managed Codex ${platform} native signing was not verified for ${relativePath}: ` +
        `${verification.reason ?? 'unknown'}`,
      );
    }
    return { relativePath, ...verification };
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeSetOutDir = join(args.outDir, 'sets', args.runtimeSet);
  rmSync(runtimeSetOutDir, { recursive: true, force: true });

  const tmpRoot = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
  try {
    for (const platform of args.platforms) {
      const platformOutDir = join(runtimeSetOutDir, platform);
      const artifactDir = join(platformOutDir, 'artifacts');
      mkdirSync(artifactDir, { recursive: true });

      const packed = packNpmPlatformPackage(tmpRoot, args.codexVersion, platform);
      const packageDir = packed.packageDir;
      const executableRelativePath = findExecutable(packageDir, platform);
      const fileAllowlist = listPackageFiles(packageDir);
      if (!fileAllowlist.includes(executableRelativePath)) {
        throw new Error(`Managed Codex fileAllowlist does not contain executable ${executableRelativePath}`);
      }
      const signing = signingSpecForPlatform(platform, args.allowUnsigned);
      const helperSigning = prepareMacHelperSigning(platform, packageDir, args.allowUnsigned);
      const nativeSigningVerifications = verifyPackageNativeSigning(
        platform,
        packageDir,
        fileAllowlist,
        executableRelativePath,
        signing,
        helperSigning.helperSigningByPath,
      );
      const executableNativeVerification = nativeSigningVerifications.find(
        verification => verification.relativePath === executableRelativePath,
      );
      if (!executableNativeVerification) {
        throw new Error(`Managed Codex declared executable is not a native binary: ${executableRelativePath}`);
      }
      const { relativePath: _relativePath, ...signingVerification } = executableNativeVerification;
      if (!args.allowUnsigned && signingVerification.checked !== true) {
        throw new Error(
          `Managed Codex ${platform} platform signing was not verified on this release host: ${signingVerification.reason ?? 'unknown'}`,
        );
      }
      const artifactSigning = signingVerification.checked === true
        ? {
            type: signingVerification.type,
            ...(signingVerification.teamId ? { teamId: signingVerification.teamId } : {}),
            ...(signingVerification.signingIdentity ? { signingIdentity: signingVerification.signingIdentity } : {}),
            ...(signingVerification.publisher ? { publisher: signingVerification.publisher } : {}),
            ...(signingVerification.certificateSha256 ? { certificateSha256: signingVerification.certificateSha256 } : {}),
            ...(signingVerification.notarization ? { notarization: signingVerification.notarization } : {}),
          }
        : signing;
      const zipName = `managed-codex-${args.codexVersion}-${platform}.zip`;
      const zipPath = join(artifactDir, zipName);
      const archiveStats = zipPackage(packageDir, zipPath);
      const sha256 = sha256File(zipPath);
      writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`);
      const signature = signFile(zipPath, args.allowUnsigned, 'artifact');
      const artifacts = {};
      artifacts[platform] = {
        url: `${args.baseUrl}/${args.runtimeSet}/${platform}/artifacts/${zipName}`,
        sha256,
        signature,
        ...(artifactSigning ? { signing: artifactSigning } : {}),
        executableRelativePath,
        fileAllowlist,
        archiveType: 'zip',
        ...archiveStats,
      };
      const audit = {
        schemaVersion: 1,
        runtimeSet: args.runtimeSet,
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
          nativeSigningVerifications,
          nativeSigningPreparations: helperSigning.preparations,
        },
      };
      const manifest = {
        schemaVersion: 1,
        runtimeSet: args.runtimeSet,
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
  console.log(`[managed-codex] upload ${runtimeSetOutDir}/ to R2 path runtimes/codex/sets/${args.runtimeSet}/`);
}

try {
  main();
} catch (err) {
  console.error(`[managed-codex] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
