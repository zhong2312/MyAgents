import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { normalizeTextLineEndings } from './verify-license-contract-utils.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => normalizeTextLineEndings(readFileSync(resolve(root, path), 'utf8'));
const json = (path) => JSON.parse(read(path));

const expectedLicense = 'AGPL-3.0-only';
const expectedEmail = 'myagents.io@gmail.com';
const canonicalLicenseSha256 = '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0';
const legalFiles = [
  'LICENSE',
  'LICENSING.md',
  'COMMERCIAL-LICENSING.md',
  'TRADEMARKS.md',
  'THIRD_PARTY_NOTICES.md',
];
const failures = [];

function requireEqual(label, actual, expected) {
  if (actual !== expected) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function requireContains(label, content, expected) {
  if (!content.includes(expected)) {
    failures.push(`${label}: missing ${JSON.stringify(expected)}`);
  }
}

const packageJson = json('package.json');
const packageLock = json('package-lock.json');
const tauri = json('src-tauri/tauri.conf.json');
const cargo = read('src-tauri/Cargo.toml');
const cargoLock = read('src-tauri/Cargo.lock');
const license = read('LICENSE');
const readme = read('README.md');
const settingsPage = read('src/renderer/pages/settings/SettingsPage.tsx');
const settingsZh = read('src/renderer/i18n/locales/zh-CN/settings.json');
const settingsEn = read('src/renderer/i18n/locales/en-US/settings.json');
const expectedVersion = packageJson.version;
const versionParts = expectedVersion.split('.').map(Number);

if (process.argv.includes('--list-legal-files')) {
  for (const path of legalFiles) console.log(path);
  process.exit(0);
}

requireEqual('package.json license', packageJson.license, expectedLicense);
requireEqual('package-lock root version', packageLock.version, expectedVersion);
requireEqual('package-lock root package version', packageLock.packages?.['']?.version, expectedVersion);
requireEqual('package-lock root package license', packageLock.packages?.['']?.license, expectedLicense);
requireEqual('tauri version', tauri.version, expectedVersion);
requireEqual('tauri bundle license', tauri.bundle?.license, expectedLicense);
requireEqual(
  'tauri bundle licenseFile (installer click-through disabled)',
  tauri.bundle?.licenseFile,
  undefined,
);
requireContains('Cargo package version', cargo, `version = "${expectedVersion}"`);
requireContains('Cargo package license', cargo, `license = "${expectedLicense}"`);
requireContains('Cargo.lock root package version', cargoLock, `name = "myagents"\nversion = "${expectedVersion}"`);
requireContains('AGPL license text', license, 'GNU AFFERO GENERAL PUBLIC LICENSE');
requireContains('AGPL version text', license, 'Version 3, 19 November 2007');
requireEqual(
  'standard AGPLv3 text SHA-256',
  createHash('sha256').update(license).digest('hex'),
  canonicalLicenseSha256,
);
requireContains('README license identifier', readme, expectedLicense);
requireContains('README commercial contact', readme, expectedEmail);
requireContains('Settings commercial contact', settingsPage, `mailto:${expectedEmail}`);
requireContains('Settings version-pinned source revision', settingsPage, '`v${appVersion}`');
requireContains('Settings license link', settingsPage, '/blob/${sourceRevision}/LICENSE');
requireContains('Settings third-party notices link', settingsPage, '/blob/${sourceRevision}/THIRD_PARTY_NOTICES.md');
requireContains('Chinese Settings license copy', settingsZh, expectedLicense);
requireContains('English Settings license copy', settingsEn, expectedLicense);
requireContains('Chinese Settings localized footer', settingsZh, 'licensingCopyright');
requireContains('English Settings localized footer', settingsEn, 'licensingCopyright');

if (
  versionParts.length !== 3
  || versionParts.some(part => !Number.isInteger(part) || part < 0)
  || versionParts[0] === 0 && versionParts[1] < 4
) {
  failures.push(`package.json version: expected a canonical version at or after 0.4.0, got ${JSON.stringify(expectedVersion)}`);
}

for (const path of legalFiles) {
  requireEqual(
    `tauri bundle resource ../${path}`,
    tauri.bundle?.resources?.[`../${path}`],
    `legal/${path}`,
  );
}

for (const path of ['LICENSING.md', 'COMMERCIAL-LICENSING.md', 'TRADEMARKS.md']) {
  requireContains(`${path} commercial contact`, read(path), expectedEmail);
  requireContains(`${path} English section`, read(path), '## English');
  requireContains(`${path} Chinese section`, read(path), '## 中文');
}

requireContains('THIRD_PARTY_NOTICES.md English section', read('THIRD_PARTY_NOTICES.md'), '## English');
requireContains('THIRD_PARTY_NOTICES.md Chinese section', read('THIRD_PARTY_NOTICES.md'), '## 中文');

if (failures.length > 0) {
  console.error('License contract verification failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`License contract verified: MyAgents ${expectedVersion} (${expectedLicense})`);
