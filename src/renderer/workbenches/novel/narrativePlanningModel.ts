import type {
  NarrativeChapterPlan,
  NarrativeDirectory,
} from "./narrativeEngineeringSchema";

export function compareNarrativeOrder(
  left: { readonly order: number; readonly id: string },
  right: { readonly order: number; readonly id: string },
): number {
  return left.order !== right.order
    ? left.order - right.order
    : left.id.localeCompare(right.id);
}

export function orderedNarrativeChapters(
  chapters: readonly NarrativeChapterPlan[],
): readonly NarrativeChapterPlan[] {
  return [...chapters].sort(compareNarrativeOrder);
}

export function narrativeDirectoryChildren(
  directories: readonly NarrativeDirectory[],
): ReadonlyMap<string | null, readonly NarrativeDirectory[]> {
  const children = new Map<string | null, NarrativeDirectory[]>();
  directories.forEach((directory) => {
    const siblings = children.get(directory.parentId) ?? [];
    siblings.push(directory);
    children.set(directory.parentId, siblings);
  });
  children.forEach((siblings, parentId) => {
    children.set(parentId, [...siblings].sort(compareNarrativeOrder));
  });
  return children;
}

export function narrativeDirectoryRows(
  directories: readonly NarrativeDirectory[],
): readonly { readonly directory: NarrativeDirectory; readonly depth: number }[] {
  const children = narrativeDirectoryChildren(directories);
  const rows: { directory: NarrativeDirectory; depth: number }[] = [];
  const visited = new Set<string>();
  const append = (parentId: string | null, depth: number) => {
    (children.get(parentId) ?? []).forEach((directory) => {
      if (visited.has(directory.id)) return;
      visited.add(directory.id);
      rows.push({ directory, depth });
      append(directory.id, depth + 1);
    });
  };
  append(null, 0);
  directories.forEach((directory) => {
    if (!visited.has(directory.id)) {
      rows.push({ directory, depth: 0 });
      visited.add(directory.id);
      append(directory.id, 1);
    }
  });
  return rows;
}

export function narrativeDirectoryDescendantIds(
  directories: readonly NarrativeDirectory[],
  directoryId: string,
): ReadonlySet<string> {
  const children = narrativeDirectoryChildren(directories);
  const result = new Set<string>([directoryId]);
  const append = (parentId: string) => {
    (children.get(parentId) ?? []).forEach((directory) => {
      if (result.has(directory.id)) return;
      result.add(directory.id);
      append(directory.id);
    });
  };
  append(directoryId);
  return result;
}

export function narrativeDirectoryPath(
  directories: readonly NarrativeDirectory[],
  directoryId: string | null,
): string {
  if (!directoryId) return "未归类";
  const byId = new Map(directories.map((directory) => [directory.id, directory]));
  const parts: string[] = [];
  const visited = new Set<string>();
  let cursor: string | null = directoryId;
  while (cursor) {
    if (visited.has(cursor)) {
      parts.unshift("循环目录");
      break;
    }
    visited.add(cursor);
    const directory = byId.get(cursor);
    if (!directory) {
      parts.unshift("失效目录");
      break;
    }
    parts.unshift(directory.title);
    cursor = directory.parentId;
  }
  return parts.join(" / ");
}

export function nextNarrativeOrder(
  records: readonly { readonly order: number }[],
): number {
  return records.reduce((highest, record) => Math.max(highest, record.order), -1) + 1;
}

export function swapNarrativeOrder<T extends { readonly id: string; readonly order: number }>(
  records: readonly T[],
  firstId: string,
  secondId: string,
): T[] {
  const first = records.find((record) => record.id === firstId);
  const second = records.find((record) => record.id === secondId);
  if (!first || !second) return [...records];
  return records.map((record) =>
    record.id === firstId
      ? { ...record, order: second.order }
      : record.id === secondId
        ? { ...record, order: first.order }
        : record,
  );
}
