// Prepare the pinned Azgaar Fantasy Map Generator browser distribution used
// by the novel workbench runtime host. The generated resource directory is
// intentionally ignored: release/test builds run this script, while source
// control keeps only the exact upstream revision and verification contract.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const AZGAAR_REPOSITORY = 'https://github.com/Azgaar/Fantasy-Map-Generator.git';
const AZGAAR_COMMIT = '49f75b9e003468bfe9e7cbad08a359210507350d';
const AZGAAR_VERSION = '1.141.2';
const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const TARGET_DIR = resolve(PROJECT_ROOT, 'src-tauri/resources/azgaar');
const MANIFEST_PATH = resolve(TARGET_DIR, 'myagents-runtime.json');

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function isPrepared() {
  try {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
    const indexHtml = await readFile(resolve(TARGET_DIR, 'index.html'));
    const indexSha256 = sha256(indexHtml);
    return manifest.commit === AZGAAR_COMMIT
      && manifest.version === AZGAAR_VERSION
      && typeof manifest.indexSha256 === 'string'
      && /^[a-f0-9]{64}$/.test(manifest.indexSha256)
      && manifest.indexSha256 === indexSha256
      && existsSync(resolve(TARGET_DIR, 'LICENSE'));
  } catch {
    return false;
  }
}

async function verifySource(sourceDir) {
  const packageJson = JSON.parse(await readFile(resolve(sourceDir, 'package.json'), 'utf8'));
  if (packageJson.version !== AZGAAR_VERSION) {
    throw new Error(`Azgaar version mismatch: expected ${AZGAAR_VERSION}, got ${packageJson.version}`);
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceDir,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (commit !== AZGAAR_COMMIT) {
    throw new Error(`Azgaar commit mismatch: expected ${AZGAAR_COMMIT}, got ${commit}`);
  }
}

async function main() {
  if (await isPrepared()) {
    console.log(`✓ Azgaar runtime ${AZGAAR_VERSION} already prepared`);
    return;
  }

  const explicitSource = process.env.MYAGENTS_AZGAAR_SOURCE_DIR?.trim();
  const tempRoot = await mkdtemp(resolve(tmpdir(), 'myagents-azgaar-build-'));
  const checkoutDir = explicitSource ? resolve(explicitSource) : resolve(tempRoot, 'source');
  const stagingDir = resolve(tempRoot, 'runtime');
  try {
    if (!explicitSource) {
      run('git', ['clone', '--filter=blob:none', '--no-checkout', AZGAAR_REPOSITORY, checkoutDir]);
      run('git', ['checkout', '--detach', AZGAAR_COMMIT], { cwd: checkoutDir });
    }
    await verifySource(checkoutDir);
    if (!existsSync(resolve(checkoutDir, 'dist/index.html'))) {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      run(npm, ['ci', '--no-audit', '--no-fund'], { cwd: checkoutDir, shell: process.platform === 'win32' });
      run(npm, ['run', 'build'], { cwd: checkoutDir, shell: process.platform === 'win32' });
    }
    await cp(resolve(checkoutDir, 'dist'), stagingDir, { recursive: true });
    await cp(resolve(checkoutDir, 'LICENSE'), resolve(stagingDir, 'LICENSE'));
    await writeFile(resolve(stagingDir, '.gitkeep'), '', 'utf8');
    const indexHtml = await readFile(resolve(stagingDir, 'index.html'));
    if (!indexHtml.toString('utf8').includes('/Fantasy-Map-Generator/')) {
      throw new Error('Azgaar dist index is missing the expected production asset prefix');
    }
    await writeFile(
      resolve(stagingDir, 'myagents-runtime.json'),
      `${JSON.stringify({
        repository: AZGAAR_REPOSITORY,
        commit: AZGAAR_COMMIT,
        version: AZGAAR_VERSION,
        indexSha256: sha256(indexHtml),
      }, null, 2)}\n`,
      'utf8',
    );
    await mkdir(dirname(TARGET_DIR), { recursive: true });
    // The source checkout may live on the system temp volume while the
    // repository is on another Windows volume. Copy into a same-volume
    // staging directory before using rename for the atomic swap.
    const targetStagingDir = `${TARGET_DIR}.new`;
    const previousDir = `${TARGET_DIR}.previous`;
    await rm(targetStagingDir, { recursive: true, force: true });
    await cp(stagingDir, targetStagingDir, { recursive: true });
    await rm(previousDir, { recursive: true, force: true });
    if (existsSync(TARGET_DIR)) await rename(TARGET_DIR, previousDir);
    try {
      await rename(targetStagingDir, TARGET_DIR);
      await rm(previousDir, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(previousDir) && !existsSync(TARGET_DIR)) await rename(previousDir, TARGET_DIR);
      throw error;
    }
    console.log(`✓ Azgaar runtime ${AZGAAR_VERSION} prepared at ${TARGET_DIR}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
