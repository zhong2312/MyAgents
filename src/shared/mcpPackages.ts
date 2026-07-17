/**
 * Exact package versions for MyAgents-owned npm MCP presets.
 *
 * Presets are product dependencies, not user-selected floating dependencies.
 * Keeping their package spec exact prevents every runtime process from paying
 * an npm registry metadata lookup for `@latest`.
 */
export const PLAYWRIGHT_MCP_PACKAGE_NAME = '@playwright/mcp';
export const PLAYWRIGHT_MCP_PACKAGE_VERSION = '0.0.68';
export const PLAYWRIGHT_MCP_PACKAGE_SPEC =
  `${PLAYWRIGHT_MCP_PACKAGE_NAME}@${PLAYWRIGHT_MCP_PACKAGE_VERSION}`;

const PINNED_PRESET_MCP_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  [PLAYWRIGHT_MCP_PACKAGE_NAME]: PLAYWRIGHT_MCP_PACKAGE_VERSION,
});

/** Normalize legacy persisted preset specs such as `@playwright/mcp@latest`. */
export function pinPresetMcpPackageVersions(args: readonly string[]): string[] {
  return args.map((arg) => {
    const latestMatch = arg.match(/^(@?[^@]+)@latest$/);
    if (!latestMatch) return arg;
    const packageName = latestMatch[1];
    const version = PINNED_PRESET_MCP_VERSIONS[packageName];
    return version ? `${packageName}@${version}` : arg;
  });
}
