import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import {
  computeBuildFingerprint,
  contentAddressedDownloadPath,
  hostDocumentTarget,
  sha256File,
  validateLockedFile,
  validatePreparedBundle,
  withResourcePrepareLock,
} from './document-processing-resource-cache.mjs';

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'myagents-document-cache-test-'));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('host target selection covers every supported build host', () => {
  assert.equal(hostDocumentTarget('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(hostDocumentTarget('darwin', 'x64'), 'x86_64-apple-darwin');
  assert.equal(hostDocumentTarget('win32', 'x64'), 'x86_64-pc-windows-msvc');
  assert.equal(hostDocumentTarget('linux', 'x64'), 'x86_64-unknown-linux-gnu');
  assert.equal(
    hostDocumentTarget('linux', 'arm64'),
    'aarch64-unknown-linux-gnu',
  );
  assert.throws(() => hostDocumentTarget('win32', 'arm64'), /Unsupported/);
});

test('download cache paths are content addressed and reject corrupt bytes', () => {
  const root = scratch();
  const bytes = Buffer.from('locked document resource');
  const source = join(root, 'source.bin');
  writeFileSync(source, bytes);
  const entry = { size: bytes.length, sha256: sha256File(source) };
  const cached = contentAddressedDownloadPath(root, entry, 'model.onnx');

  assert.equal(basename(cached), `${entry.sha256}-model.onnx`);
  mkdirSync(join(root, 'downloads'), { recursive: true });
  writeFileSync(cached, bytes);
  assert.equal(validateLockedFile(cached, entry), true);
  writeFileSync(cached, Buffer.from('corrupt'));
  assert.equal(validateLockedFile(cached, entry), false);
});

test('build fingerprint is deterministic and invalidates source or metadata changes', () => {
  const root = scratch();
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'worker.rs'), 'fn main() {}\n');
  const args = {
    projectRoot: root,
    inputs: [source],
    metadata: { target: 'test', schema: 2 },
  };
  const first = computeBuildFingerprint(args);
  assert.equal(computeBuildFingerprint(args), first);

  writeFileSync(
    join(source, 'worker.rs'),
    'fn main() { println!("changed"); }\n',
  );
  assert.notEqual(computeBuildFingerprint(args), first);
  assert.notEqual(
    computeBuildFingerprint({
      ...args,
      metadata: { target: 'other', schema: 2 },
    }),
    computeBuildFingerprint(args),
  );
});

function createPreparedBundle(root, fingerprint) {
  const files = {
    worker: 'myagents-document-worker',
    onnxRuntime: 'native/onnxruntime.dylib',
    pdfium: 'native/pdfium.dylib',
    detectorModel: 'models/det.onnx',
    recognizerModel: 'models/rec.onnx',
    dictionary: 'models/dict.txt',
  };
  for (const path of Object.values(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `fixture:${path}`);
  }
  const resource = (path) => ({
    path,
    size: readFileSync(join(root, path)).length,
    sha256: sha256File(join(root, path)),
    license: 'MIT',
    upstreamRevision: 'fixture-v1',
    artifactSource: 'fixture',
    signing: { kind: 'sha256-manifest', identity: 'fixture' },
  });
  mkdirSync(join(root, 'legal', 'PDFIUM-third-party-licenses'), {
    recursive: true,
  });
  for (const name of [
    'NOTICE',
    'ANYDOC',
    'OFFICE',
    'PADDLE',
    'ORT',
    'PDFIUM',
  ]) {
    writeFileSync(join(root, 'legal', name), name);
  }
  writeFileSync(
    join(root, 'legal', 'PDFIUM-third-party-licenses', 'LICENSE'),
    'third party',
  );
  chmodSync(join(root, files.worker), 0o755);
  const legalFiles = [
    ...['NOTICE', 'ANYDOC', 'OFFICE', 'PADDLE', 'ORT', 'PDFIUM'].map((name) =>
      join(root, 'legal', name),
    ),
    join(root, 'legal', 'PDFIUM-third-party-licenses', 'LICENSE'),
  ].map((path) => ({
    path: path.slice(root.length + 1).replaceAll('\\', '/'),
    size: readFileSync(path).length,
    sha256: sha256File(path),
  }));
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      pipelineVersion: 'pipeline-v1',
      platform: 'macos',
      architecture: 'arm64',
      buildFingerprint: fingerprint,
      worker: resource(files.worker),
      files: {
        onnxRuntime: resource(files.onnxRuntime),
        pdfium: resource(files.pdfium),
        detectorModel: resource(files.detectorModel),
        recognizerModel: resource(files.recognizerModel),
        dictionary: resource(files.dictionary),
      },
      legalFiles,
    }),
  );
}

test('prepared bundle validation closes warm-cache corruption and target drift', () => {
  const root = scratch();
  createPreparedBundle(root, 'a'.repeat(64));
  const expected = {
    pipelineVersion: 'pipeline-v1',
    platform: 'macos',
    architecture: 'arm64',
    buildFingerprint: 'a'.repeat(64),
    requiredLegalFiles: [
      'NOTICE',
      'ANYDOC',
      'OFFICE',
      'PADDLE',
      'ORT',
      'PDFIUM',
    ],
  };
  assert.equal(validatePreparedBundle(root, expected), true);
  assert.equal(
    validatePreparedBundle(root, { ...expected, architecture: 'x64' }),
    false,
  );

  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files.unexpected = manifest.files.dictionary;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(validatePreparedBundle(root, expected), false);
  delete manifest.files.unexpected;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  manifest.worker.signing.identity = '';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(validatePreparedBundle(root, expected), false);
  manifest.worker.signing.identity = 'fixture';
  writeFileSync(manifestPath, JSON.stringify(manifest));

  chmodSync(join(root, manifest.worker.path), 0o644);
  assert.equal(validatePreparedBundle(root, expected), false);
  chmodSync(join(root, manifest.worker.path), 0o755);

  writeFileSync(join(root, 'legal', 'NOTICE'), 'corrupt but nonempty');
  assert.equal(validatePreparedBundle(root, expected), false);
  writeFileSync(join(root, 'legal', 'NOTICE'), 'NOTICE');

  writeFileSync(join(root, 'models', 'det.onnx'), 'corrupt');
  assert.equal(validatePreparedBundle(root, expected), false);
});

test('prepare lock serializes concurrent callers in one repository cache', async () => {
  const root = scratch();
  const events = [];
  let releaseFirst;
  let markFirstEntered;
  let markSecondWaiting;
  const firstEntered = new Promise((resolve) => {
    markFirstEntered = resolve;
  });
  const secondWaiting = new Promise((resolve) => {
    markSecondWaiting = resolve;
  });
  const release = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = withResourcePrepareLock(
    root,
    async () => {
      events.push('first:start');
      markFirstEntered();
      await release;
      events.push('first:end');
    },
    { pollMs: 1 },
  );
  await firstEntered;
  const second = withResourcePrepareLock(
    root,
    async () => {
      events.push('second:start');
    },
    { pollMs: 1, onWait: markSecondWaiting },
  );
  await secondWaiting;
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});
