import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const resourceRoot = resolve(
  process.argv[3] ?? join(projectRoot, 'src-tauri', 'resources', 'document-processing', 'v1'),
);
if (!inputPath || !existsSync(inputPath) || !statSync(inputPath).isFile()) {
  throw new Error('Usage: node scripts/document-worker-smoke.mjs <input-file> [resource-root]');
}

const workerName = process.platform === 'win32'
  ? 'myagents-document-worker.exe'
  : 'myagents-document-worker';
const workerPath = join(resourceRoot, workerName);
const manifestPath = join(resourceRoot, 'manifest.json');
if (!existsSync(workerPath) || !existsSync(manifestPath)) {
  throw new Error(`Prepared Worker resources are missing under ${resourceRoot}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'myagents-document-worker-smoke-'));
const stagingPath = join(scratch, 'staging');
mkdirSync(stagingPath, { mode: 0o700 });
writeFileSync(join(stagingPath, '.myagents-owner'), '00000000000000000000000000000001', {
  mode: 0o600,
});
const now = new Date();
const localDate = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
].join('');
const jobId = `${localDate}_000000000001`;

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  payload.fill(0);
  return frame;
}

function decodeFrames(bytes) {
  const messages = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) throw new Error('Worker returned a truncated frame prefix');
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    if (length === 0 || length > 1024 * 1024 || bytes.length - offset < length) {
      throw new Error('Worker returned an invalid frame');
    }
    messages.push(JSON.parse(bytes.subarray(offset, offset + length).toString('utf8')));
    offset += length;
  }
  return messages;
}

try {
  const child = spawn(workerPath, [], {
    cwd: scratch,
    env: {},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.end(encodeFrame({
    type: 'start',
    protocolVersion: 1,
    jobId,
    workerGeneration: 1,
    inputPath,
    sourceName: basename(inputPath),
    stagingPath,
    resourceManifestPath: manifestPath,
  }));
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', resolveExit);
  });
  const stderrText = Buffer.concat(stderr).toString('utf8').trim();
  if (code !== 0 || stderrText) {
    throw new Error(`Worker exited ${code}; stderr=${stderrText || '(empty)'}`);
  }
  const messages = decodeFrames(Buffer.concat(stdout));
  const ready = messages.find(message => message.type === 'ready');
  const terminal = messages.findLast(message => message.type === 'completed');
  const documentPath = join(stagingPath, 'document.md');
  if (!ready || terminal?.jobId !== jobId || !terminal.result?.detectedFormat || !existsSync(documentPath)) {
    throw new Error(`Worker smoke failed: ${JSON.stringify(terminal ?? messages)}`);
  }
  console.log(JSON.stringify({
    success: true,
    inputPath,
    resourceRoot,
    terminal,
    documentPreview: readFileSync(documentPath, 'utf8').slice(0, 500),
    keptOutput: process.env.MYAGENTS_KEEP_SMOKE_OUTPUT === '1' ? scratch : undefined,
  }, null, 2));
} finally {
  if (process.env.MYAGENTS_KEEP_SMOKE_OUTPUT !== '1') {
    rmSync(scratch, { recursive: true, force: true });
  }
}
