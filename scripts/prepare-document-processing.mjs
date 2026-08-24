import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeBuildFingerprint,
  contentAddressedDownloadPath,
  hostDocumentTarget,
  validateLockedFile,
  validatePreparedBundle,
  withResourcePrepareLock,
} from './document-processing-resource-cache.mjs';
import { macX64SourceBuildPrerequisiteFailures } from './document-processing-build-tools.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appVersion = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8'),
).version;
const workerRoot = join(projectRoot, 'src-tauri', 'document-worker');
const lockPath = join(workerRoot, 'resource-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const args = process.argv.slice(2);
const positional = args.filter((argument) => !argument.startsWith('--'));
const unknownFlags = args.filter(
  (argument) =>
    argument.startsWith('--') &&
    !['--force', '--offline', '--check-prerequisites'].includes(argument),
);
if (positional.length > 1 || unknownFlags.length > 0) {
  throw new Error(
    'Usage: node scripts/prepare-document-processing.mjs [target] [--force] [--offline] [--check-prerequisites]',
  );
}
const target = positional[0] ?? hostDocumentTarget();
const force = args.includes('--force');
const checkPrerequisites = args.includes('--check-prerequisites');
const offline =
  args.includes('--offline') ||
  process.env.MYAGENTS_DOCUMENT_RESOURCES_OFFLINE === '1';
if (checkPrerequisites && (force || args.includes('--offline'))) {
  throw new Error(
    '--check-prerequisites cannot be combined with --force or --offline',
  );
}
if (!lock.targets[target])
  throw new Error(`Unsupported document-processing target: ${target}`);
const targetLock = lock.targets[target];
const cacheRoot = join(
  projectRoot,
  'src-tauri',
  'resources',
  'document-processing-cache',
);
const legacyCacheRoot = join(
  projectRoot,
  'src-tauri',
  'target',
  'document-processing-cache',
);
const resourceRoot = join(
  projectRoot,
  'src-tauri',
  'resources',
  'document-processing',
);
const publishRoot = join(resourceRoot, 'v1');
const helperPath = join(
  projectRoot,
  'scripts',
  'document-processing-resource-cache.mjs',
);
const preparePath = fileURLToPath(import.meta.url);
const requiredLegalFiles = [
  'DOCUMENT_PROCESSING_NOTICES.md',
  'ANYDOC-LICENSE',
  'OFFICE-CRYPTO-LICENSE',
  'PADDLEOCR-LICENSE',
  'ONNXRUNTIME-LICENSE',
  'PDFIUM-LICENSE',
];
const cacheStats = { hits: 0, migrated: 0, downloaded: 0 };
let extractRoot;
let stageRoot;

function probeCommand(command, commandArgs) {
  try {
    return execFileSync(command, commandArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function assertSourceBuildPrerequisites() {
  if (!targetLock.onnxRuntime.sourceBuild) return;
  const failures = macX64SourceBuildPrerequisiteFailures({
    gitVersion: probeCommand('git', ['--version']),
    pythonVersion: probeCommand('python3', ['--version']),
    cmakeVersion: probeCommand('cmake', ['--version']),
    appleClangPath: probeCommand('xcrun', ['--find', 'clang']),
    appleClangPlusPlusPath: probeCommand('xcrun', ['--find', 'clang++']),
  });
  if (failures.length === 0) {
    console.log(
      `Document-processing source build prerequisites ready for ${target}`,
    );
    return;
  }

  const details = failures.flatMap((failure) => [
    `- ${failure.name}: ${failure.reason}`,
    `  Install: ${failure.install}`,
    `  Verify: ${failure.verify}`,
  ]);
  throw new Error(
    [
      `Document-processing source build prerequisites are missing for ${target}.`,
      'MyAgents builds ONNX Runtime from its locked source because upstream does not publish a macOS x64 binary.',
      ...details,
      'The source cache is preserved; install the missing tools and rerun the same command.',
    ].join('\n'),
  );
}

mkdirSync(cacheRoot, { recursive: true });

function digestFile(path, algorithm = 'sha256', encoding = 'hex') {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

async function download(entry, cacheName) {
  const destination = contentAddressedDownloadPath(cacheRoot, entry, cacheName);
  const legacy = join(legacyCacheRoot, cacheName);
  mkdirSync(dirname(destination), { recursive: true });
  if (validateLockedFile(destination, entry)) {
    cacheStats.hits += 1;
    return destination;
  }
  if (validateLockedFile(legacy, entry)) {
    copyFileSync(legacy, destination);
    cacheStats.migrated += 1;
    console.log(
      `  [cache] migrated ${cacheName} from legacy Cargo target cache`,
    );
    return destination;
  }
  if (offline) {
    throw new Error(
      `Offline document resource cache miss: ${cacheName} (${destination})`,
    );
  }

  rmSync(destination, { force: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.partial`;
  rmSync(temporary, { force: true });
  console.log(
    `  [download] ${cacheName} (${(entry.size / 1024 / 1024).toFixed(1)} MiB)`,
  );
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(entry.url, { redirect: 'follow' });
      if (!response.ok || !response.body) {
        throw new Error(`Download failed (${response.status}): ${entry.url}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      writeFileSync(temporary, bytes, { mode: 0o600 });
      if (!validateLockedFile(temporary, entry))
        throw new Error(`Locked size/digest mismatch: ${entry.url}`);
      renameSync(temporary, destination);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      rmSync(temporary, { force: true });
      if (attempt < 3) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, attempt * 500),
        );
      }
    }
  }
  if (lastError) {
    console.warn(
      `  [download] Node fetch failed; falling back to curl: ${lastError.message}`,
    );
    let curlError;
    try {
      execFileSync(
        'curl',
        [
          '--fail',
          '--location',
          '--retry',
          '3',
          '--retry-delay',
          '1',
          '--output',
          temporary,
          entry.url,
        ],
        { stdio: 'inherit' },
      );
      if (!validateLockedFile(temporary, entry))
        throw new Error(`Locked size/digest mismatch: ${entry.url}`);
      renameSync(temporary, destination);
      curlError = undefined;
    } catch (error) {
      curlError = error;
      rmSync(temporary, { force: true });
    }
    if (curlError) throw curlError;
  }
  if (!validateLockedFile(destination, entry))
    throw new Error(`Locked size/digest mismatch: ${entry.url}`);
  cacheStats.downloaded += 1;
  return destination;
}

function filesUnder(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function directoriesUnder(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    result.push(path, ...directoriesUnder(path));
  }
  return result;
}

function findLockedLibrary(root, pattern) {
  const normalized = pattern.replaceAll('\\', '/');
  const regex = new RegExp(
    `^${normalized
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  const matches = filesUnder(root).filter((path) => {
    const rel = relative(root, path).replaceAll('\\', '/');
    return (
      !rel.includes('.dSYM/') && (regex.test(rel) || regex.test(basename(path)))
    );
  });
  if (matches.length === 1) return matches[0];
  // macOS archives contain both an unversioned loader name and the pinned
  // versioned payload. Package the versioned payload under MyAgents' stable
  // resource name; excluding dSYM contents prevents debug symbols from ever
  // being mistaken for the runtime library.
  const versioned = matches.filter((path) =>
    /(?:^|\.)1\.28\.0\.(?:dylib|so)$/.test(basename(path)),
  );
  if (versioned.length === 1) return versioned[0];
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${pattern} under ${root}, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
  return matches[0];
}

async function extractArchive(entry, name) {
  const archive = await download(
    entry,
    `${target}-${name}-${basename(new URL(entry.url).pathname)}`,
  );
  const destination = join(extractRoot, name);
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', destination], {
    stdio: 'inherit',
  });
  return destination;
}

function prepareMacX64OrtSourceBuild(entry) {
  const source = join(
    cacheRoot,
    'source',
    `onnxruntime-${entry.sourceBuild.commit}`,
  );
  const legacySource = join(legacyCacheRoot, 'onnxruntime-1.28.0-source');
  mkdirSync(dirname(source), { recursive: true });
  if (!existsSync(source) && existsSync(join(legacySource, '.git'))) {
    renameSync(legacySource, source);
    console.log(
      '  [cache] migrated ONNX Runtime source/build cache from legacy Cargo target cache',
    );
  }
  if (!existsSync(join(source, '.git'))) {
    mkdirSync(source, { recursive: true });
    execFileSync('git', ['init'], { cwd: source, stdio: 'inherit' });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', entry.sourceBuild.repository],
      { cwd: source, stdio: 'inherit' },
    );
  }
  execFileSync(
    'git',
    ['fetch', '--depth', '1', 'origin', entry.sourceBuild.commit],
    { cwd: source, stdio: 'inherit' },
  );
  execFileSync(
    'git',
    ['checkout', '--detach', '--force', entry.sourceBuild.commit],
    { cwd: source, stdio: 'inherit' },
  );
  const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8',
  }).trim();
  if (actualCommit !== entry.sourceBuild.commit)
    throw new Error(`ONNX Runtime source mismatch: ${actualCommit}`);
  execFileSync('git', ['submodule', 'sync', '--recursive'], {
    cwd: source,
    stdio: 'inherit',
  });
  execFileSync(
    'git',
    ['submodule', 'update', '--init', '--recursive', '--depth', '1'],
    { cwd: source, stdio: 'inherit' },
  );
  execFileSync(
    './build.sh',
    [
      '--config',
      'Release',
      '--build_shared_lib',
      '--parallel',
      '--skip_tests',
      '--cmake_extra_defines',
      'CMAKE_OSX_ARCHITECTURES=x86_64',
      'CMAKE_OSX_DEPLOYMENT_TARGET=13.0',
      'onnxruntime_BUILD_UNIT_TESTS=OFF',
    ],
    { cwd: source, stdio: 'inherit' },
  );
  return source;
}

const appleSigningIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim();
const windowsSignTool = process.env.WINDOWS_SIGNTOOL_PATH?.trim();
const windowsCertificateSha1 = process.env.WINDOWS_CERTIFICATE_SHA1?.trim();
if (
  targetLock.platform === 'windows' &&
  Boolean(windowsSignTool) !== Boolean(windowsCertificateSha1)
) {
  throw new Error(
    'WINDOWS_SIGNTOOL_PATH and WINDOWS_CERTIFICATE_SHA1 must be set together',
  );
}
const rustcIdentity = execFileSync('rustc', ['-Vv'], {
  encoding: 'utf8',
}).trim();
const signingIdentity =
  targetLock.platform === 'macos'
    ? appleSigningIdentity || 'development-build'
    : targetLock.platform === 'windows'
      ? windowsCertificateSha1?.toLowerCase() || 'development-build'
      : 'MyAgents-resource-manifest-v1';
const buildFingerprint = computeBuildFingerprint({
  projectRoot,
  metadata: {
    prepareSchemaVersion: 2,
    appVersion,
    target,
    pipelineVersion: lock.pipelineVersion,
    targetLock,
    sharedLock: lock.shared,
    rustcIdentity,
    signingIdentity,
    windowsSignTool: windowsSignTool || '',
    windowsTimestampUrl: process.env.WINDOWS_TIMESTAMP_URL?.trim() || '',
  },
  inputs: [
    preparePath,
    helperPath,
    join(projectRoot, 'rust-toolchain.toml'),
    join(workerRoot, 'Cargo.toml'),
    join(workerRoot, 'Cargo.lock'),
    join(workerRoot, 'DOCUMENT_PROCESSING_NOTICES.md'),
    join(workerRoot, 'src'),
    join(projectRoot, 'src-tauri', 'vendor', 'anydoc', 'Cargo.toml'),
    join(projectRoot, 'src-tauri', 'vendor', 'anydoc', 'LICENSE'),
    join(projectRoot, 'src-tauri', 'vendor', 'anydoc', 'src'),
    join(projectRoot, 'src-tauri', 'vendor', 'office-crypto', 'Cargo.toml'),
    join(projectRoot, 'src-tauri', 'vendor', 'office-crypto', 'LICENSE'),
    join(projectRoot, 'src-tauri', 'vendor', 'office-crypto', 'src'),
  ],
});
const expectedBundle = {
  pipelineVersion: lock.pipelineVersion,
  platform: targetLock.platform,
  architecture: targetLock.architecture,
  buildFingerprint,
  requiredLegalFiles,
};
const preparedRoot = join(cacheRoot, 'prepared', target, buildFingerprint);

function recoverProjection() {
  mkdirSync(resourceRoot, { recursive: true });
  const entries = readdirSync(resourceRoot, { withFileTypes: true });
  const backups = entries
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith('.v1-backup-'),
    )
    .map((entry) => join(resourceRoot, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (!existsSync(publishRoot) && backups.length > 0) {
    renameSync(backups.shift(), publishRoot);
    console.log(
      '  [recover] restored the previous document resource projection',
    );
  }
  for (const backup of backups)
    rmSync(backup, { recursive: true, force: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.v1-staging-')) {
      rmSync(join(resourceRoot, entry.name), { recursive: true, force: true });
    }
  }
}

function publishPreparedBundle(source) {
  if (validatePreparedBundle(publishRoot, expectedBundle)) return false;

  const token = `${process.pid}-${randomUUID()}`;
  const projectionStage = join(resourceRoot, `.v1-staging-${token}`);
  const projectionBackup = join(resourceRoot, `.v1-backup-${token}`);
  cpSync(source, projectionStage, {
    recursive: true,
    errorOnExist: true,
    preserveTimestamps: true,
  });
  if (!validatePreparedBundle(projectionStage, expectedBundle)) {
    rmSync(projectionStage, { recursive: true, force: true });
    throw new Error(
      `Prepared document resource projection failed validation: ${source}`,
    );
  }

  let movedPrevious = false;
  try {
    if (existsSync(publishRoot)) {
      renameSync(publishRoot, projectionBackup);
      movedPrevious = true;
    }
    renameSync(projectionStage, publishRoot);
  } catch (error) {
    rmSync(projectionStage, { recursive: true, force: true });
    if (
      movedPrevious &&
      !existsSync(publishRoot) &&
      existsSync(projectionBackup)
    ) {
      renameSync(projectionBackup, publishRoot);
    }
    throw error;
  }
  if (movedPrevious) {
    try {
      rmSync(projectionBackup, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `  [cleanup] published resources are valid, but the old projection could not be removed: ${error.message}`,
      );
    }
  }
  return true;
}

await withResourcePrepareLock(
  cacheRoot,
  async () => {
    if (checkPrerequisites) {
      if (
        validatePreparedBundle(publishRoot, expectedBundle) ||
        validatePreparedBundle(preparedRoot, expectedBundle)
      ) {
        console.log(
          `Document-processing build prerequisites not needed for ${target} (prepared cache hit)`,
        );
        return;
      }
      assertSourceBuildPrerequisites();
      return;
    }
    recoverProjection();
    if (!force && validatePreparedBundle(publishRoot, expectedBundle)) {
      console.log(
        `Document-processing resources already ready for ${target} (fingerprint ${buildFingerprint.slice(0, 12)})`,
      );
      return;
    }
    if (!force && validatePreparedBundle(preparedRoot, expectedBundle)) {
      publishPreparedBundle(preparedRoot);
      console.log(
        `Restored cached document-processing resources for ${target} (fingerprint ${buildFingerprint.slice(0, 12)})`,
      );
      return;
    }
    if (offline) {
      throw new Error(
        `Offline prepared document bundle cache miss for ${target} (${preparedRoot}); run the prepare command online once`,
      );
    }

    // This is deliberately after prepared-cache validation but before any
    // download/source mutation: a warm cache remains fully reusable without
    // local source-build tools, while a cold build fails before large fetches.
    assertSourceBuildPrerequisites();

    if (existsSync(preparedRoot))
      rmSync(preparedRoot, { recursive: true, force: true });
    const workParent = join(cacheRoot, 'work');
    mkdirSync(workParent, { recursive: true });
    const workRoot = mkdtempSync(join(workParent, `${target}-`));
    extractRoot = join(workRoot, 'extract');
    stageRoot = join(workRoot, 'v1');
    mkdirSync(extractRoot, { recursive: true });
    mkdirSync(join(stageRoot, 'native'), { recursive: true });
    mkdirSync(join(stageRoot, 'models'), { recursive: true });
    mkdirSync(join(stageRoot, 'legal'), { recursive: true });

    try {
      const ortExtract = targetLock.onnxRuntime.sourceBuild
        ? prepareMacX64OrtSourceBuild(targetLock.onnxRuntime)
        : await extractArchive(targetLock.onnxRuntime, 'onnxruntime');
      const pdfiumExtract = await extractArchive(targetLock.pdfium, 'pdfium');
      const extension =
        targetLock.platform === 'windows'
          ? '.dll'
          : targetLock.platform === 'macos'
            ? '.dylib'
            : '.so';
      const ortDestination = join(
        stageRoot,
        'native',
        `onnxruntime${extension}`,
      );
      const pdfiumDestination = join(stageRoot, 'native', `pdfium${extension}`);
      copyFileSync(
        findLockedLibrary(ortExtract, targetLock.onnxRuntime.libraryPattern),
        ortDestination,
      );
      copyFileSync(
        findLockedLibrary(pdfiumExtract, targetLock.pdfium.libraryPattern),
        pdfiumDestination,
      );

      const sharedEntries = [
        ['detectorModel', 'ppocrv6-small-det.onnx'],
        ['recognizerModel', 'ppocrv6-small-rec.onnx'],
        ['dictionary', 'ppocrv6-dict.txt'],
      ];
      const sharedPaths = {};
      for (const [key, filename] of sharedEntries) {
        const cached = await download(lock.shared[key], filename);
        const destination = join(stageRoot, 'models', filename);
        copyFileSync(cached, destination);
        sharedPaths[key] = destination;
      }

      execFileSync(
        'cargo',
        [
          'build',
          '--locked',
          '--release',
          '--target',
          target,
          '--manifest-path',
          join(workerRoot, 'Cargo.toml'),
        ],
        { cwd: projectRoot, stdio: 'inherit' },
      );
      const workerName = target.includes('windows')
        ? 'myagents-document-worker.exe'
        : 'myagents-document-worker';
      const workerSource = join(
        workerRoot,
        'target',
        target,
        'release',
        workerName,
      );
      if (!existsSync(workerSource))
        throw new Error(`Worker build did not produce ${workerSource}`);
      copyFileSync(workerSource, join(stageRoot, workerName));
      if (!target.includes('windows')) {
        const mode = statSync(join(stageRoot, workerName)).mode | 0o111;
        chmodSync(join(stageRoot, workerName), mode);
      }

      let nativeSigning = { kind: 'unsigned', identity: 'development-build' };
      if (targetLock.platform === 'macos' && appleSigningIdentity) {
        for (const path of [
          ortDestination,
          pdfiumDestination,
          join(stageRoot, workerName),
        ]) {
          execFileSync(
            'codesign',
            [
              '--force',
              '--options',
              'runtime',
              '--timestamp',
              '--sign',
              appleSigningIdentity,
              path,
            ],
            { stdio: 'inherit' },
          );
          execFileSync(
            'codesign',
            ['--verify', '--strict', '--verbose=2', path],
            { stdio: 'inherit' },
          );
        }
        nativeSigning = {
          kind: 'codesign',
          identity: appleSigningIdentity,
        };
      }

      if (targetLock.platform === 'windows') {
        if (windowsSignTool && windowsCertificateSha1) {
          const timestampUrl =
            process.env.WINDOWS_TIMESTAMP_URL?.trim() ||
            'http://timestamp.digicert.com';
          for (const path of [
            ortDestination,
            pdfiumDestination,
            join(stageRoot, workerName),
          ]) {
            execFileSync(
              windowsSignTool,
              [
                'sign',
                '/fd',
                'SHA256',
                '/sha1',
                windowsCertificateSha1,
                '/tr',
                timestampUrl,
                '/td',
                'SHA256',
                path,
              ],
              { stdio: 'inherit' },
            );
            execFileSync(windowsSignTool, ['verify', '/pa', '/all', path], {
              stdio: 'inherit',
            });
          }
          nativeSigning = {
            kind: 'authenticode',
            identity: windowsCertificateSha1.toLowerCase(),
          };
        }
      }

      if (targetLock.platform === 'linux') {
        nativeSigning = {
          kind: 'sha256-manifest',
          identity: 'MyAgents-resource-manifest-v1',
        };
      }

      const noticeSource = join(workerRoot, 'DOCUMENT_PROCESSING_NOTICES.md');
      copyFileSync(
        noticeSource,
        join(stageRoot, 'legal', 'DOCUMENT_PROCESSING_NOTICES.md'),
      );
      copyFileSync(
        join(projectRoot, 'src-tauri', 'vendor', 'anydoc', 'LICENSE'),
        join(stageRoot, 'legal', 'ANYDOC-LICENSE'),
      );
      copyFileSync(
        join(projectRoot, 'src-tauri', 'vendor', 'office-crypto', 'LICENSE'),
        join(stageRoot, 'legal', 'OFFICE-CRYPTO-LICENSE'),
      );
      const paddleLicense = await download(
        lock.shared.paddleLicense,
        'paddleocr-license.txt',
      );
      copyFileSync(
        paddleLicense,
        join(stageRoot, 'legal', 'PADDLEOCR-LICENSE'),
      );
      for (const [name, root] of [
        ['ONNXRUNTIME', ortExtract],
        ['PDFIUM', pdfiumExtract],
      ]) {
        const license = filesUnder(root).find(
          (path) => basename(path).toLowerCase() === 'license',
        );
        if (!license) throw new Error(`${name} archive/source omitted LICENSE`);
        copyFileSync(license, join(stageRoot, 'legal', `${name}-LICENSE`));
        const thirdParty = filesUnder(root).find(
          (path) => basename(path).toLowerCase() === 'thirdpartynotices.txt',
        );
        if (thirdParty)
          copyFileSync(
            thirdParty,
            join(stageRoot, 'legal', `${name}-ThirdPartyNotices.txt`),
          );
      }
      const pdfiumLicenses = directoriesUnder(pdfiumExtract).find(
        (path) => basename(path) === 'licenses',
      );
      if (!pdfiumLicenses)
        throw new Error(
          'PDFium archive omitted third-party licenses directory',
        );
      cpSync(
        pdfiumLicenses,
        join(stageRoot, 'legal', 'PDFIUM-third-party-licenses'),
        { recursive: true },
      );

      function resourceFile(
        path,
        license,
        upstreamRevision,
        artifactSource,
        signing,
      ) {
        return {
          path: relative(stageRoot, path).replaceAll('\\', '/'),
          sha256: digestFile(path),
          size: statSync(path).size,
          license,
          upstreamRevision,
          artifactSource,
          signing,
        };
      }

      const manifestSigning = {
        kind: 'sha256-manifest',
        identity: 'MyAgents-resource-manifest-v1',
      };

      function integrityFile(path) {
        return {
          path: relative(stageRoot, path).replaceAll('\\', '/'),
          sha256: digestFile(path),
          size: statSync(path).size,
        };
      }

      const manifest = {
        schemaVersion: 1,
        pipelineVersion: lock.pipelineVersion,
        platform: targetLock.platform,
        architecture: targetLock.architecture,
        buildFingerprint,
        worker: resourceFile(
          join(stageRoot, workerName),
          'AGPL-3.0-only',
          `MyAgents/${appVersion}`,
          'current MyAgents source tree',
          nativeSigning,
        ),
        files: {
          onnxRuntime: resourceFile(
            ortDestination,
            targetLock.onnxRuntime.license,
            targetLock.onnxRuntime.upstreamRevision,
            targetLock.onnxRuntime.sourceBuild?.repository ??
              targetLock.onnxRuntime.url,
            nativeSigning,
          ),
          pdfium: resourceFile(
            pdfiumDestination,
            targetLock.pdfium.license,
            targetLock.pdfium.upstreamRevision,
            targetLock.pdfium.url,
            nativeSigning,
          ),
          detectorModel: resourceFile(
            sharedPaths.detectorModel,
            lock.shared.detectorModel.license,
            lock.shared.detectorModel.upstreamRevision,
            lock.shared.detectorModel.url,
            manifestSigning,
          ),
          recognizerModel: resourceFile(
            sharedPaths.recognizerModel,
            lock.shared.recognizerModel.license,
            lock.shared.recognizerModel.upstreamRevision,
            lock.shared.recognizerModel.url,
            manifestSigning,
          ),
          dictionary: resourceFile(
            sharedPaths.dictionary,
            lock.shared.dictionary.license,
            lock.shared.dictionary.upstreamRevision,
            lock.shared.dictionary.url,
            manifestSigning,
          ),
        },
        legalFiles: filesUnder(join(stageRoot, 'legal'))
          .sort()
          .map(integrityFile),
      };
      writeFileSync(
        join(stageRoot, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600 },
      );

      if (!validatePreparedBundle(stageRoot, expectedBundle)) {
        throw new Error(
          `Newly prepared document-processing resources failed validation for ${target}`,
        );
      }
      mkdirSync(dirname(preparedRoot), { recursive: true });
      renameSync(stageRoot, preparedRoot);
      publishPreparedBundle(preparedRoot);
      console.log(
        `Prepared locked document-processing resources for ${target} ` +
          `(fingerprint ${buildFingerprint.slice(0, 12)}; cache hits ${cacheStats.hits}, ` +
          `migrated ${cacheStats.migrated}, downloaded ${cacheStats.downloaded})`,
      );
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  },
  {
    onWait: () =>
      console.log(
        '  [lock] another document resource preparation is active; waiting...',
      ),
  },
);
