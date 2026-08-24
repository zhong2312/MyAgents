import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const buildDev = readFileSync(resolve(repoRoot, 'build_dev.sh'), 'utf8');
const buildDevWindows = readFileSync(
  resolve(repoRoot, 'build_dev_win.ps1'),
  'utf8',
);
const buildMacos = readFileSync(resolve(repoRoot, 'build_macos.sh'), 'utf8');
const esbuildBundle = readFileSync(
  resolve(repoRoot, 'scripts/esbuild-bundle.mjs'),
  'utf8',
);
const buildLinux = readFileSync(resolve(repoRoot, 'build_linux.sh'), 'utf8');
const buildWindows = readFileSync(
  resolve(repoRoot, 'build_windows.ps1'),
  'utf8',
);
const rebuildV050Release = readFileSync(
  resolve(repoRoot, '.github', 'workflows', 'rebuild-v050-release.yml'),
  'utf8',
);
const azgaarRuntime = readFileSync(
  resolve(repoRoot, 'scripts', 'prepare-azgaar-runtime.mjs'),
  'utf8',
);
const setupUnix = readFileSync(resolve(repoRoot, 'setup.sh'), 'utf8');
const setupWindows = readFileSync(
  resolve(repoRoot, 'setup_windows.ps1'),
  'utf8',
);
const documentResourceScript = readFileSync(
  resolve(repoRoot, 'scripts/prepare-document-processing.mjs'),
  'utf8',
);
const documentResourceCache = readFileSync(
  resolve(repoRoot, 'scripts/document-processing-resource-cache.mjs'),
  'utf8',
);
const syncVersionScript = readFileSync(
  resolve(repoRoot, 'scripts/sync-version.js'),
  'utf8',
);
const documentWorkerSmoke = readFileSync(
  resolve(repoRoot, 'scripts/document-worker-smoke.mjs'),
  'utf8',
);
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
);
const packageLock = JSON.parse(
  readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8'),
);
const documentResourceLock = JSON.parse(
  readFileSync(
    resolve(repoRoot, 'src-tauri/document-worker/resource-lock.json'),
    'utf8',
  ),
);
const tauriConfig = JSON.parse(
  readFileSync(resolve(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
);
const unsignedMacosConfig = JSON.parse(
  readFileSync(
    resolve(repoRoot, 'src-tauri/tauri.macos.unsigned.conf.json'),
    'utf8',
  ),
);
const linuxTauriConfig = JSON.parse(
  readFileSync(resolve(repoRoot, 'src-tauri/tauri.linux.conf.json'), 'utf8'),
);

test('bundled workspace templates are committed, clean, and setup-independent', () => {
  const templateRoot = resolve(repoRoot, 'bundled-workspaces', 'mino');
  assert.ok(
    existsSync(resolve(templateRoot, 'CLAUDE.md')),
    'the committed mino template must include its workspace marker',
  );
  assert.equal(
    tauriConfig.bundle.resources['../bundled-workspaces'],
    'bundled-workspaces',
  );
  assert.equal(tauriConfig.bundle.resources['../mino'], undefined);
  const bundledSkills = readdirSync(
    resolve(templateRoot, '.claude', 'skills'),
    { withFileTypes: true },
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(bundledSkills, [
    'apple-notes',
    'apple-reminders',
    'bird',
    'github',
    'peekaboo',
    'remotion-best-practices',
  ]);

  const pending = [templateRoot];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      assert.notEqual(entry.name, '.DS_Store');
      assert.notEqual(entry.name, '.git');
      assert.equal(
        lstatSync(path).isSymbolicLink(),
        false,
        `bundled templates cannot contain skipped symlinks: ${path}`,
      );
      if (entry.isDirectory()) pending.push(path);
    }
  }

  for (const setup of [setupUnix, setupWindows]) {
    assert.doesNotMatch(setup, /openmino/i);
    assert.doesNotMatch(setup, /git clone[^\n]*mino/i);
  }
  assert.match(
    buildMacos,
    /bundled-workspaces\/mino\/CLAUDE\.md/,
  );
});

test('macOS dev build replaces every mutable native resource staging directory', () => {
  for (const resource of ['claude-agent-sdk', 'sharp-runtime', 'tsx-runtime']) {
    const remove = `rm -rf "\${PROJECT_DIR}/src-tauri/resources/${resource}"`;
    const create = `mkdir -p "\${PROJECT_DIR}/src-tauri/resources/${resource}"`;
    const removeAt = buildDev.indexOf(remove);
    const createAt = buildDev.indexOf(create);

    assert.notEqual(
      removeAt,
      -1,
      `${resource} must be removed before dev staging`,
    );
    assert.notEqual(
      createAt,
      -1,
      `${resource} must be recreated for the Tauri resource map`,
    );
    assert.ok(
      removeAt < createAt,
      `${resource} must be replaced, not prepared additively`,
    );
  }
});

test('macOS release prepares and validates Sharp inside each target build', () => {
  const prepareCall = 'prepare_sharp_runtime "$NODE_TARGET_ARCH"';
  const prepareAt = buildMacos.indexOf(prepareCall);
  const targetLoopAt = buildMacos.lastIndexOf(
    'for TARGET in "${BUILD_TARGETS[@]}"; do',
    prepareAt,
  );
  const targetArchReadyAt = buildMacos.indexOf(
    'NODE_TARGET_ARCH="x64"',
    targetLoopAt,
  );
  const tauriBuildAt = buildMacos.indexOf(
    'npm run tauri:build -- --target "$TARGET"',
    targetLoopAt,
  );

  assert.match(buildMacos, /prepare_sharp_runtime\(\) \{/);
  assert.notEqual(targetLoopAt, -1, 'target build loop must exist');
  assert.notEqual(
    targetArchReadyAt,
    -1,
    'target architecture selection must exist',
  );
  assert.ok(
    prepareAt > targetLoopAt,
    'Sharp staging must be owned by the current target loop',
  );
  assert.ok(
    prepareAt > targetArchReadyAt,
    'Sharp staging must run after the current target architecture is selected',
  );
  assert.ok(
    prepareAt < tauriBuildAt,
    'Sharp must be ready before Tauri snapshots resources',
  );
  assert.equal(
    buildMacos.match(new RegExp(prepareCall.replaceAll('$', '\\$'), 'g'))
      ?.length,
    1,
  );

  const prepareFunctionAt = buildMacos.indexOf('prepare_sharp_runtime() {');
  const nextFunctionAt = buildMacos.indexOf(
    '\nvalidate_claude_sdk_package() {',
    prepareFunctionAt,
  );
  const prepareFunction = buildMacos.slice(prepareFunctionAt, nextFunctionAt);

  assert.match(prepareFunction, /rm -rf "\$SHARP_DIR"/);
  assert.match(prepareFunction, /--os=darwin --cpu="\$ARCH"/);
  assert.match(prepareFunction, /validate_macho_binary/);
  assert.match(
    prepareFunction,
    /codesign --force --options runtime --timestamp/,
  );
  assert.doesNotMatch(
    buildMacos,
    /@img\/sharp-darwin-arm64@[^\n]*@img\/sharp-darwin-x64@/,
    'a thin target must not install both Sharp architectures',
  );
});

test('macOS unsigned release is explicit, non-interactive, and DMG-only', () => {
  assert.equal(unsignedMacosConfig.bundle.createUpdaterArtifacts, false);
  assert.match(buildMacos, /MYAGENTS_UNSIGNED_BUILD/);
  assert.match(buildMacos, /MYAGENTS_NONINTERACTIVE/);
  assert.match(buildMacos, /MYAGENTS_MACOS_BUILD_TARGET/);
  assert.match(
    buildMacos,
    /unset APPLE_SIGNING_IDENTITY[\s\S]*unset TAURI_SIGNING_PRIVATE_KEY/,
  );
  assert.match(
    buildMacos,
    /--bundles dmg[\s\\]*\n\s*--config "\$\{PROJECT_DIR\}\/src-tauri\/tauri\.macos\.unsigned\.conf\.json"/,
  );
  assert.match(
    buildMacos,
    /if \[ "\$NONINTERACTIVE" = "1" \]; then\n\s*exit 0/,
  );
});

test('Linux release excludes macOS and Windows-only external binaries', () => {
  assert.deepEqual(linuxTauriConfig.bundle.externalBin, []);
  assert.equal(linuxTauriConfig.bundle.createUpdaterArtifacts, false);
  assert.match(
    buildLinux,
    /--config "\$\{PROJECT_DIR\}\/src-tauri\/tauri\.linux\.conf\.json"/,
  );
});

test('Claude Agent SDK declaration matches the locked native packages', () => {
  const sdkName = '@anthropic-ai/claude-agent-sdk';
  const sdkVersion = packageJson.dependencies[sdkName];

  assert.equal(packageLock.packages[''].dependencies[sdkName], sdkVersion);
  assert.equal(
    packageLock.packages[`node_modules/${sdkName}`].version,
    sdkVersion,
  );

  for (const [name, version] of Object.entries(
    packageJson.optionalDependencies,
  ).filter(([name]) => name.startsWith(`${sdkName}-`))) {
    assert.equal(version, sdkVersion, `${name} must match the SDK version`);
    assert.equal(
      packageLock.packages[`node_modules/${name}`].version,
      sdkVersion,
      `${name} must be locked at the SDK version`,
    );
  }
});

test('v0.5.0 rebuild keeps cross-platform project instructions during source restore', () => {
  assert.match(
    rebuildV050Release,
    /git checkout "\$SOURCE_REF" -- \. ':\(exclude\)AGENTS\.md'/,
  );
  assert.match(
    rebuildV050Release,
    /- name: Build unsigned DMG[\s\S]*NODE_OPTIONS: "--max-old-space-size=4096"/,
  );
  assert.equal(
    rebuildV050Release.match(/scripts\/prepare-azgaar-runtime\.mjs/g)?.length,
    2,
    'macOS and Linux source restores must retain the current Azgaar runtime builder',
  );
});

test('Azgaar runtime verifies its staged bytes through the generated manifest', () => {
  assert.doesNotMatch(azgaarRuntime, /AZGAAR_INDEX_SHA256/);
  assert.match(azgaarRuntime, /manifest\.commit === AZGAAR_COMMIT/);
  assert.match(azgaarRuntime, /manifest\.version === AZGAAR_VERSION/);
  assert.match(azgaarRuntime, /manifest\.indexSha256 === indexSha256/);
  assert.match(azgaarRuntime, /indexSha256: sha256\(indexHtml\)/);
});

test('CLI bundle staging owns its complete mutable resource inventory', () => {
  const cliTargetAt = esbuildBundle.indexOf('cli: {');
  const cleanAt = esbuildBundle.indexOf("if (targetName === 'cli')");
  const buildAt = esbuildBundle.indexOf('await build({');

  assert.notEqual(cliTargetAt, -1, 'CLI esbuild target must exist');
  assert.notEqual(
    cleanAt,
    -1,
    'CLI target must clear stale resource artifacts',
  );
  assert.ok(
    cleanAt < buildAt,
    'stale CLI resources must be removed before esbuild emits the bundle',
  );
  assert.match(esbuildBundle, /entry !== '\.gitkeep'/);
  assert.match(esbuildBundle, /resources\/cli\/myagents\.cjs/);
  assert.doesNotMatch(esbuildBundle, /resources\/cli\/myagents\.js/);
  assert.doesNotMatch(esbuildBundle, /copyFile|src\/cli\/myagents\.cmd/);
});

test('every setup, dev, and release entry point delegates document resources to the prepare owner', () => {
  const macPreflight = buildMacos.indexOf(
    'prepare-document-processing.mjs" "$TARGET" --check-prerequisites',
  );
  const macTargetBuildLoop = buildMacos.indexOf(
    'for TARGET in "${BUILD_TARGETS[@]}"; do',
    macPreflight + 1,
  );
  assert.ok(
    macPreflight >= 0 && macPreflight < macTargetBuildLoop,
    'macOS selected targets must run owner preflight before the app build loop',
  );

  const macDevPrepare = buildDev.indexOf(
    'prepare-document-processing.mjs" "$DEV_DOCUMENT_TARGET"',
  );
  const macDevBuild = buildDev.indexOf('npm run tauri:build -- --debug');
  assert.ok(macDevPrepare >= 0 && macDevPrepare < macDevBuild);

  const windowsDevPrepare = buildDevWindows.indexOf(
    'prepare-document-processing.mjs" "x86_64-pc-windows-msvc"',
  );
  const windowsDevBuild = buildDevWindows.indexOf(
    'npm run tauri:build -- --debug',
  );
  assert.ok(windowsDevPrepare >= 0 && windowsDevPrepare < windowsDevBuild);

  const macPrepare = buildMacos.indexOf(
    'prepare-document-processing.mjs" "$TARGET"',
  );
  const macBuild = buildMacos.indexOf(
    'npm run tauri:build -- --target "$TARGET"',
  );
  assert.ok(macPrepare >= 0 && macPrepare < macBuild);

  const linuxPrepare = buildLinux.indexOf(
    'prepare-document-processing.mjs" "$TARGET"',
  );
  const linuxBuild = buildLinux.indexOf(
    'npm run tauri:build -- --target "$TARGET"',
  );
  assert.ok(linuxPrepare >= 0 && linuxPrepare < linuxBuild);

  const windowsPrepare = buildWindows.indexOf(
    'prepare-document-processing.mjs',
  );
  const windowsBuild = buildWindows.indexOf(
    'npm run tauri:build -- --target x86_64-pc-windows-msvc',
  );
  assert.ok(windowsPrepare >= 0 && windowsPrepare < windowsBuild);

  assert.match(
    setupUnix,
    /node "\$\{PROJECT_DIR\}\/scripts\/prepare-document-processing\.mjs"/,
  );
  assert.match(
    setupWindows,
    /node "\$ProjectDir\\scripts\\prepare-document-processing\.mjs" "x86_64-pc-windows-msvc"/,
  );
  assert.equal(
    packageJson.scripts['prepare:document-processing'],
    'node scripts/prepare-document-processing.mjs',
  );
  assert.match(
    packageJson.scripts['tauri:dev'],
    /^npm run prepare:document-processing && npm run build:cli && tauri dev$/,
  );
});

test('document processing locks all release targets and publishes only verified reusable resources', () => {
  assert.deepEqual(Object.keys(documentResourceLock.targets).sort(), [
    'aarch64-apple-darwin',
    'aarch64-unknown-linux-gnu',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
    'x86_64-unknown-linux-gnu',
  ]);
  assert.equal(
    documentResourceLock.pipelineVersion,
    'anydoc-0.1.9_ppocrv6-small_v1',
  );
  assert.match(
    documentResourceLock.shared.dictionary.url,
    /ppocrv6_dict\.txt$/,
  );
  for (const resource of Object.values(documentResourceLock.shared)) {
    assert.match(resource.sha256, /^[0-9a-f]{64}$/);
    assert.ok(resource.size > 0);
    assert.ok(resource.upstreamRevision);
  }
  for (const target of Object.values(documentResourceLock.targets)) {
    assert.ok(
      target.onnxRuntime.sha256 || target.onnxRuntime.sourceBuild?.commit,
    );
    assert.match(target.pdfium.sha256, /^[0-9a-f]{64}$/);
  }
  assert.match(
    documentResourceScript,
    /cargo[\s\S]*--locked[\s\S]*--release[\s\S]*--target/,
  );
  assert.match(documentResourceScript, /Locked size\/digest mismatch/);
  assert.match(
    documentResourceScript,
    /writeFileSync\(\s*join\(stageRoot, 'manifest\.json'\)/,
  );
  assert.match(documentResourceScript, /buildFingerprint/);
  assert.match(documentResourceScript, /publishPreparedBundle\(preparedRoot\)/);
  assert.match(
    documentResourceScript,
    /renameSync\(projectionStage, publishRoot\)/,
  );
  assert.match(
    documentResourceScript,
    /renameSync\(projectionBackup, publishRoot\)/,
  );
  assert.match(
    documentResourceScript,
    /const cacheRoot = join\([\s\S]*?'resources',[\s\S]*?'document-processing-cache'/,
  );
  assert.match(documentResourceCache, /mkdirSync\(lockPath\)/);
  assert.match(documentResourceCache, /lockedEntryDigest\(entry\)/);
  assert.doesNotMatch(packageJson.scripts.clean, /document-processing-cache/);
  assert.match(documentResourceScript, /`MyAgents\/\$\{appVersion\}`/);
  assert.match(documentResourceScript, /WINDOWS_SIGNTOOL_PATH/);
  assert.match(documentResourceScript, /WINDOWS_CERTIFICATE_SHA1/);
  assert.match(documentResourceScript, /'authenticode'/);
  assert.match(documentResourceScript, /artifactSource/);
  assert.match(documentResourceScript, /signing/);
  const windowsSignAt = documentResourceScript.search(
    /'sign',\s*'\/fd',\s*'SHA256'/,
  );
  const manifestWriteAt = documentResourceScript.search(
    /writeFileSync\(\s*join\(stageRoot, 'manifest\.json'\)/,
  );
  assert.ok(
    windowsSignAt >= 0 &&
      manifestWriteAt >= 0 &&
      windowsSignAt < manifestWriteAt,
    'Windows native resources must be signed before manifest hashes are committed',
  );
  assert.match(syncVersionScript, /src-tauri\/document-worker\/Cargo\.toml/);
  assert.match(documentWorkerSmoke, /protocolVersion: 1/);
  assert.match(documentWorkerSmoke, /resourceManifestPath: manifestPath/);
  assert.match(documentWorkerSmoke, /message\.type === 'ready'/);
  assert.match(documentWorkerSmoke, /message\.type === 'completed'/);
  assert.equal(
    tauriConfig.bundle.resources['../src-tauri/resources/document-processing'],
    'document-processing',
  );
});
