import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const PREPARE_LOCK_NAME = '.prepare.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MALFORMED_LOCK_GRACE_MS = 60 * 1000;

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function hostDocumentTarget(
  platform = process.platform,
  architecture = process.arch,
) {
  const key = `${platform}:${architecture}`;
  const targets = {
    'darwin:arm64': 'aarch64-apple-darwin',
    'darwin:x64': 'x86_64-apple-darwin',
    'win32:x64': 'x86_64-pc-windows-msvc',
    'linux:x64': 'x86_64-unknown-linux-gnu',
    'linux:arm64': 'aarch64-unknown-linux-gnu',
  };
  const target = targets[key];
  if (!target) throw new Error(`Unsupported document-processing host: ${key}`);
  return target;
}

export function lockedEntryDigest(entry) {
  if (typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)) {
    return entry.sha256;
  }
  if (typeof entry.sha512Base64 === 'string' && entry.sha512Base64.length > 0) {
    return createHash('sha256').update(entry.sha512Base64).digest('hex');
  }
  throw new Error('Locked resource entry omitted a supported digest');
}

export function validateLockedFile(path, entry) {
  if (!existsSync(path)) return false;
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== entry.size
  )
    return false;
  if (entry.sha256) return sha256File(path) === entry.sha256;
  return (
    createHash('sha512').update(readFileSync(path)).digest('base64') ===
    entry.sha512Base64
  );
}

function sourceFilesUnder(path, result) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink())
    throw new Error(`Fingerprint input must not be a symlink: ${path}`);
  if (metadata.isFile()) {
    result.push(path);
    return;
  }
  if (!metadata.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'target') continue;
    sourceFilesUnder(join(path, entry.name), result);
  }
}

export function computeBuildFingerprint({ projectRoot, inputs, metadata }) {
  const files = [];
  for (const input of inputs) sourceFilesUnder(input, files);
  files.sort((a, b) =>
    relative(projectRoot, a).localeCompare(relative(projectRoot, b)),
  );

  const hash = createHash('sha256');
  hash.update(`${JSON.stringify(metadata)}\0`);
  for (const file of files) {
    const name = relative(projectRoot, file).replaceAll('\\', '/');
    hash.update(`${name}\0`);
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function isSafeBundlePath(root, candidate) {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    isAbsolute(candidate)
  )
    return false;
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(root, candidate);
  return (
    resolvedCandidate.startsWith(`${resolvedRoot}${sep}`) &&
    relative(resolvedRoot, resolvedCandidate)
      .split(/[\\/]/)
      .every((part) => part && part !== '.' && part !== '..')
  );
}

function filesUnder(root, result = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink())
      throw new Error(`Prepared bundle contains a symlink: ${path}`);
    if (metadata.isDirectory()) filesUnder(path, result);
    else if (metadata.isFile()) result.push(path);
    else throw new Error(`Prepared bundle contains a special file: ${path}`);
  }
  return result;
}

function hasRequiredResourceMetadata(resource) {
  return (
    typeof resource?.license === 'string' &&
    resource.license.trim().length > 0 &&
    typeof resource.upstreamRevision === 'string' &&
    resource.upstreamRevision.trim().length > 0 &&
    typeof resource.artifactSource === 'string' &&
    resource.artifactSource.trim().length > 0 &&
    typeof resource.signing?.kind === 'string' &&
    resource.signing.kind.trim().length > 0 &&
    typeof resource.signing?.identity === 'string' &&
    resource.signing.identity.trim().length > 0
  );
}

function validateIntegrityFile(root, resource) {
  if (!resource || !isSafeBundlePath(root, resource.path)) return false;
  const path = resolve(root, resource.path);
  const metadata = lstatSync(path);
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.size > 0 &&
    metadata.size === resource.size &&
    /^[0-9a-f]{64}$/.test(resource.sha256) &&
    sha256File(path) === resource.sha256
  );
}

export function validatePreparedBundle(root, expected) {
  try {
    const manifestPath = join(root, 'manifest.json');
    const manifestMetadata = lstatSync(manifestPath);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink())
      return false;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (
      manifest.schemaVersion !== 1 ||
      manifest.pipelineVersion !== expected.pipelineVersion ||
      manifest.platform !== expected.platform ||
      manifest.architecture !== expected.architecture ||
      manifest.buildFingerprint !== expected.buildFingerprint
    )
      return false;

    const fileKeys = Object.keys(manifest.files ?? {}).sort();
    const expectedFileKeys = [
      'detectorModel',
      'dictionary',
      'onnxRuntime',
      'pdfium',
      'recognizerModel',
    ];
    if (JSON.stringify(fileKeys) !== JSON.stringify(expectedFileKeys))
      return false;
    const resources = [manifest.worker, ...Object.values(manifest.files)];
    if (resources.length !== 6) return false;
    for (const resource of resources) {
      if (
        !hasRequiredResourceMetadata(resource) ||
        !validateIntegrityFile(root, resource)
      )
        return false;
    }
    const workerMetadata = lstatSync(resolve(root, manifest.worker.path));
    if (expected.platform !== 'windows' && (workerMetadata.mode & 0o111) === 0)
      return false;

    if (!Array.isArray(manifest.legalFiles) || manifest.legalFiles.length === 0)
      return false;
    const declaredLegalPaths = [];
    for (const resource of manifest.legalFiles) {
      if (
        !resource.path.startsWith('legal/') ||
        !validateIntegrityFile(root, resource)
      )
        return false;
      declaredLegalPaths.push(resource.path);
    }
    declaredLegalPaths.sort();
    if (new Set(declaredLegalPaths).size !== declaredLegalPaths.length)
      return false;
    const actualLegalPaths = filesUnder(join(root, 'legal'))
      .map((path) => relative(root, path).replaceAll('\\', '/'))
      .sort();
    if (JSON.stringify(declaredLegalPaths) !== JSON.stringify(actualLegalPaths))
      return false;

    for (const legalPath of expected.requiredLegalFiles) {
      const path = join(root, 'legal', legalPath);
      const metadata = lstatSync(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size === 0
      )
        return false;
    }
    const pdfiumLicenses = join(root, 'legal', 'PDFIUM-third-party-licenses');
    if (
      !lstatSync(pdfiumLicenses).isDirectory() ||
      filesUnder(pdfiumLicenses).length === 0
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function staleLockOwner(lockPath, now) {
  try {
    const owner = JSON.parse(
      readFileSync(join(lockPath, 'owner.json'), 'utf8'),
    );
    return !processIsAlive(owner.pid);
  } catch {
    try {
      return now() - statSync(lockPath).mtimeMs > MALFORMED_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
}

export async function withResourcePrepareLock(
  cacheRoot,
  callback,
  options = {},
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 250;
  const now = options.now ?? Date.now;
  const wait =
    options.wait ??
    ((delay) => new Promise((resolveDelay) => setTimeout(resolveDelay, delay)));
  const onWait = options.onWait ?? (() => {});
  const lockPath = join(cacheRoot, PREPARE_LOCK_NAME);
  const token = randomUUID();
  const startedAt = now();
  let announcedWait = false;

  mkdirSync(cacheRoot, { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, token })}\n`,
        {
          mode: 0o600,
        },
      );
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (staleLockOwner(lockPath, now)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (!announcedWait) {
        announcedWait = true;
        onWait();
      }
      if (now() - startedAt >= timeoutMs) {
        throw new Error(
          `Timed out waiting for document-processing resource lock: ${lockPath}`,
        );
      }
      await wait(pollMs);
    }
  }

  try {
    return await callback();
  } finally {
    try {
      const owner = JSON.parse(
        readFileSync(join(lockPath, 'owner.json'), 'utf8'),
      );
      if (owner.token === token)
        rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // A missing lock means a higher-level process cleanup already reclaimed it.
    }
  }
}

export function contentAddressedDownloadPath(cacheRoot, entry, cacheName) {
  const safeName = basename(cacheName).replaceAll(/[^A-Za-z0-9._-]/g, '_');
  return join(
    cacheRoot,
    'downloads',
    `${lockedEntryDigest(entry)}-${safeName}`,
  );
}
