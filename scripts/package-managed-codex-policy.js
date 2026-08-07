export const CODEX_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function isCanonicalCodexVersion(value) {
  return typeof value === 'string'
    && value.trim() === value
    && CODEX_VERSION_RE.test(value);
}

export function resolveManagedCodexPackageIdentity({
  lockedVersion,
  requestedVersion,
  allowUnsigned,
}) {
  if (!isCanonicalCodexVersion(lockedVersion)) {
    throw new Error('Managed Codex runtime lock requires a canonical semver version');
  }
  if (!isCanonicalCodexVersion(requestedVersion)) {
    throw new Error(`Invalid Codex version: ${requestedVersion}`);
  }
  if (!allowUnsigned && requestedVersion !== lockedVersion) {
    throw new Error(
      `Signed Managed Codex packages must use locked version ${lockedVersion}; `
      + 'version overrides are only allowed with --allow-unsigned',
    );
  }
  return {
    codexVersion: requestedVersion,
    runtimeSet: `codex-${requestedVersion}`,
  };
}

export function shouldSignManagedCodexPackage({ allowUnsigned }) {
  return allowUnsigned !== true;
}

export function managedCodexMacHelperSigningCandidates({ teamId, signingIdentity }) {
  return [
    {
      action: 'preserved-upstream-openai-signature',
      signing: { type: 'codesign', teamId, signingIdentity },
    },
    {
      action: 'preserved-upstream-ad-hoc-signature',
      signing: { type: 'codesign', teamId: 'not set' },
    },
  ];
}

export function managedCodexSignerEnv(baseEnv) {
  const env = { ...baseEnv };
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  delete env.TAURI_PRIVATE_KEY;
  const password = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? env.TAURI_PRIVATE_KEY_PASSWORD;
  if (password) env.TAURI_PRIVATE_KEY_PASSWORD = password;
  return env;
}
