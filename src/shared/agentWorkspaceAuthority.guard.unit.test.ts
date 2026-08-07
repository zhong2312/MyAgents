import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function sourceFiles(root: string, extensions: ReadonlySet<string>): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, extensions);
    if (!extensions.has(extname(entry.name)) || entry.name.includes('.test.')) return [];
    return [path];
  });
}

describe('Agent workspace authority source guard', () => {
  it('keeps workspacePath out of the normal AgentConfig contract', () => {
    const source = readFileSync(join(repoRoot, 'src/shared/types/agent.ts'), 'utf8');
    expect(source).not.toMatch(/\bworkspacePath\??\s*:/);
  });

  it('prevents normal renderer and Node Agent code from reading agent.workspacePath', () => {
    const roots = [
      'src/renderer/config',
      'src/renderer/components/AgentSettings',
      'src/server/utils',
      'src/server/plugins',
    ];
    const explicit = [
      'src/renderer/App.tsx',
      'src/renderer/context/TabProvider.tsx',
      'src/renderer/hooks/useDeliveryChannels.tsx',
      'src/server/admin-api.ts',
    ];
    const files = [
      ...roots.flatMap(root => sourceFiles(join(repoRoot, root), new Set(['.ts', '.tsx']))),
      ...explicit.map(file => join(repoRoot, file)),
    ];
    const violations = files.flatMap(file => {
      const source = readFileSync(file, 'utf8');
      return /\b(?:agent|candidate|currentAgent|freshAgent|updatedAgent|a)\.workspacePath\b/.test(source)
        ? [relative(repoRoot, file)]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps the Rust legacy JSON read inside the config-store adapter', () => {
    const roots = ['src-tauri/src/im', 'src-tauri/src/sidecar'];
    const files = [
      ...roots.flatMap(root => sourceFiles(join(repoRoot, root), new Set(['.rs']))),
      join(repoRoot, 'src-tauri/src/memory_auto_update.rs'),
    ];
    const violations = files.flatMap(file => {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('get("workspacePath")')) return [];
      return file.endsWith(join('src-tauri', 'src', 'im', 'config_store.rs'))
        ? []
        : [relative(repoRoot, file)];
    });
    const agentType = readFileSync(join(repoRoot, 'src-tauri/src/im/types.rs'), 'utf8');
    const block = agentType.slice(
      agentType.indexOf('pub struct AgentConfigRust'),
      agentType.indexOf('// AI config (Agent-level defaults)', agentType.indexOf('pub struct AgentConfigRust')),
    );

    expect(violations).toEqual([]);
    expect(block).not.toContain('pub workspace_path');
    expect(block).toContain('pub resolved_workspace_path');
  });
});
