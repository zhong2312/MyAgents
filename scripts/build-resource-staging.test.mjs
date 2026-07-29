import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const buildDev = readFileSync(resolve(repoRoot, 'build_dev.sh'), 'utf8');
const buildMacos = readFileSync(resolve(repoRoot, 'build_macos.sh'), 'utf8');

test('macOS dev build replaces every mutable native resource staging directory', () => {
  for (const resource of ['claude-agent-sdk', 'sharp-runtime', 'tsx-runtime']) {
    const remove = `rm -rf "\${PROJECT_DIR}/src-tauri/resources/${resource}"`;
    const create = `mkdir -p "\${PROJECT_DIR}/src-tauri/resources/${resource}"`;
    const removeAt = buildDev.indexOf(remove);
    const createAt = buildDev.indexOf(create);

    assert.notEqual(removeAt, -1, `${resource} must be removed before dev staging`);
    assert.notEqual(createAt, -1, `${resource} must be recreated for the Tauri resource map`);
    assert.ok(removeAt < createAt, `${resource} must be replaced, not prepared additively`);
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
  const tauriBuildAt = buildMacos.indexOf('npm run tauri:build -- --target "$TARGET"', targetLoopAt);

  assert.match(buildMacos, /prepare_sharp_runtime\(\) \{/);
  assert.notEqual(targetLoopAt, -1, 'target build loop must exist');
  assert.notEqual(targetArchReadyAt, -1, 'target architecture selection must exist');
  assert.ok(prepareAt > targetLoopAt, 'Sharp staging must be owned by the current target loop');
  assert.ok(
    prepareAt > targetArchReadyAt,
    'Sharp staging must run after the current target architecture is selected',
  );
  assert.ok(prepareAt < tauriBuildAt, 'Sharp must be ready before Tauri snapshots resources');
  assert.equal(buildMacos.match(new RegExp(prepareCall.replaceAll('$', '\\$'), 'g'))?.length, 1);

  const prepareFunctionAt = buildMacos.indexOf('prepare_sharp_runtime() {');
  const nextFunctionAt = buildMacos.indexOf('\nvalidate_claude_sdk_package() {', prepareFunctionAt);
  const prepareFunction = buildMacos.slice(prepareFunctionAt, nextFunctionAt);

  assert.match(prepareFunction, /rm -rf "\$SHARP_DIR"/);
  assert.match(prepareFunction, /--os=darwin --cpu="\$ARCH"/);
  assert.match(prepareFunction, /validate_macho_binary/);
  assert.match(prepareFunction, /codesign --force --options runtime --timestamp/);
  assert.doesNotMatch(
    buildMacos,
    /@img\/sharp-darwin-arm64@[^\n]*@img\/sharp-darwin-x64@/,
    'a thin target must not install both Sharp architectures',
  );
});
