import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('Launcher layout contract', () => {
  it('keeps the brand surface and project rail in independently sized Grid areas', () => {
    const launcher = source('src/renderer/pages/Launcher.tsx');
    const css = source('src/renderer/index.css');

    expect(launcher).toContain('className="launcher-layout flex-1 overflow-hidden"');
    expect(launcher).toContain('className="launcher-brand relative flex items-center justify-center overflow-hidden"');
    expect(launcher).toContain('<LauncherRightRail');
    expect(css).toContain('.launcher-layout {\n  display: grid;');
    expect(css).toContain("grid-template-areas: 'brand workspaces';");
    expect(css).toContain('.launcher-brand {\n  grid-area: brand;');
    expect(css).toContain('.launcher-workspaces {\n  grid-area: workspaces;');
  });
});
