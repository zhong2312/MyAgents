import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTextLineEndings } from './verify-license-contract-utils.mjs';

test('normalizes Windows Cargo.lock line endings before contract matching', () => {
  const cargoLock = '[[package]]\r\nname = "myagents"\r\nversion = "0.4.0"\r\n';
  const expectedPackage = 'name = "myagents"\nversion = "0.4.0"';

  assert.ok(normalizeTextLineEndings(cargoLock).includes(expectedPackage));
});

test('normalizes standalone carriage returns in text contracts', () => {
  assert.equal(normalizeTextLineEndings('first\rsecond\nthird'), 'first\nsecond\nthird');
});
