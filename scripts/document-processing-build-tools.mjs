const MINIMUM_CMAKE_VERSION = [3, 28, 0];
const MINIMUM_PYTHON_VERSION = [3, 8, 0];

export const MINIMUM_MAC_X64_CMAKE_VERSION = MINIMUM_CMAKE_VERSION.join('.');
export const MINIMUM_MAC_X64_PYTHON_VERSION =
  MINIMUM_PYTHON_VERSION.join('.');

export function parseCmakeVersion(output) {
  const match = /\bcmake version\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(
    output ?? '',
  );
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function parsePythonVersion(output) {
  const match = /\bPython\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(output ?? '');
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

export function macX64SourceBuildPrerequisiteFailures(tools) {
  const failures = [];
  if (!tools.gitVersion) {
    failures.push({
      name: 'Git',
      reason: 'git was not found',
      install: 'xcode-select --install  # or: brew install git',
      verify: 'git --version',
    });
  }
  const pythonVersion = parsePythonVersion(tools.pythonVersion);
  if (!tools.pythonVersion) {
    failures.push({
      name: `Python >= ${MINIMUM_MAC_X64_PYTHON_VERSION}`,
      reason: 'python3 was not found',
      install: 'brew install python',
      verify: 'python3 --version',
    });
  } else if (!pythonVersion) {
    failures.push({
      name: `Python >= ${MINIMUM_MAC_X64_PYTHON_VERSION}`,
      reason: `could not parse: ${tools.pythonVersion.split('\n')[0]}`,
      install: 'brew upgrade python',
      verify: 'python3 --version',
    });
  } else if (!versionAtLeast(pythonVersion, MINIMUM_PYTHON_VERSION)) {
    failures.push({
      name: `Python >= ${MINIMUM_MAC_X64_PYTHON_VERSION}`,
      reason: `found ${pythonVersion.join('.')}`,
      install: 'brew upgrade python',
      verify: 'python3 --version',
    });
  }

  const cmakeVersion = parseCmakeVersion(tools.cmakeVersion);
  if (!tools.cmakeVersion) {
    failures.push({
      name: `CMake >= ${MINIMUM_MAC_X64_CMAKE_VERSION}`,
      reason: 'cmake was not found',
      install: 'brew install cmake',
      verify: 'cmake --version',
    });
  } else if (!cmakeVersion) {
    failures.push({
      name: `CMake >= ${MINIMUM_MAC_X64_CMAKE_VERSION}`,
      reason: `could not parse: ${tools.cmakeVersion.split('\n')[0]}`,
      install: 'brew upgrade cmake',
      verify: 'cmake --version',
    });
  } else if (!versionAtLeast(cmakeVersion, MINIMUM_CMAKE_VERSION)) {
    failures.push({
      name: `CMake >= ${MINIMUM_MAC_X64_CMAKE_VERSION}`,
      reason: `found ${cmakeVersion.join('.')}`,
      install: 'brew upgrade cmake',
      verify: 'cmake --version',
    });
  }

  if (!tools.appleClangPath || !tools.appleClangPlusPlusPath) {
    failures.push({
      name: 'Apple Clang',
      reason: 'xcrun could not resolve clang and clang++',
      install: 'xcode-select --install',
      verify: 'xcrun --find clang && xcrun --find clang++',
    });
  }
  return failures;
}
