import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('Task Center responsive layout contract', () => {
  it('keeps the thought panel fixed while allowing the task panel to shrink', () => {
    const taskCenter = source('src/renderer/pages/TaskCenter.tsx');

    expect(taskCenter).toContain('w-[480px] shrink-0');
    expect(taskCenter).toContain('flex min-w-0 flex-1 flex-col overflow-hidden');
  });

  it('compacts the task toolbar without allowing its title to break', () => {
    const panel = source('src/renderer/components/task-center/TaskListPanel.tsx');
    const search = source('src/renderer/components/task-center/SearchPill.tsx');
    const workspaceFilter = panel.slice(
      panel.indexOf('{workspaceOptions.length > 2 && ('),
      panel.indexOf('<SearchPill'),
    );

    expect(panel).toContain('@container/task-panel');
    expect(panel).toContain('whitespace-nowrap text-base font-semibold');
    expect(panel).toContain('sr-only @[720px]:not-sr-only');
    expect(panel).toContain('collapseWhenNarrow');
    expect(workspaceFilter).toContain('<CustomSelect\n              className=');
    expect(workspaceFilter).not.toContain('<div\n              className=');
    expect(search).toContain('<button');
    expect(search).toContain("w-7 @[720px]:w-[var(--search-pill-collapsed-width)]");
  });

  it('keeps both task-card badges intact in narrow cards', () => {
    const category = source('src/renderer/components/task-center/TaskCategoryBadge.tsx');
    const status = source('src/renderer/components/task-center/TaskStatusBadge.tsx');

    expect(category).toContain('inline-flex shrink-0 items-center gap-1 whitespace-nowrap');
    expect(status).toContain('inline-flex shrink-0 items-center gap-1 whitespace-nowrap');
  });

  it('uses one task-card column until the task panel has enough room for two', () => {
    const panel = source('src/renderer/components/task-center/TaskListPanel.tsx');

    expect(panel).toContain(
      'grid grid-cols-1 gap-3 @[560px]:grid-cols-2 @[900px]:grid-cols-3',
    );
  });
});
