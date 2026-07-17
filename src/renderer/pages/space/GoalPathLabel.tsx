interface GoalPathLabelProps {
  label: string;
  leafLabel: string;
}

interface GoalPathParts {
  ancestor: string;
  separator: string;
  leaf: string;
}

function splitStructuredGoalPath(
  label: string,
  leafLabel: string,
): GoalPathParts | null {
  const leaf = leafLabel.trim();
  if (!leaf || label.trim() === leaf || !label.endsWith(leaf)) return null;

  const prefix = label.slice(0, -leaf.length);
  if (prefix.endsWith(" / ")) {
    const ancestor = prefix.slice(0, -3).trim();
    return ancestor ? { ancestor, separator: " / ", leaf } : null;
  }
  if (label.startsWith("../") && prefix.endsWith("/")) {
    const ancestor = prefix.slice(0, -1);
    return ancestor ? { ancestor, separator: "/", leaf } : null;
  }
  return null;
}

export function GoalPathLabel({ label, leafLabel }: GoalPathLabelProps) {
  const path = splitStructuredGoalPath(label, leafLabel);
  if (!path) {
    return (
      <span
        className="block w-full truncate text-left font-normal text-[var(--ink)]"
        title={label}
      >
        {label}
      </span>
    );
  }

  return (
    <span
      className="flex w-full min-w-0 items-baseline justify-start text-left"
      title={label}
    >
      <span className="min-w-0 truncate text-[var(--ink-muted)]/75">
        {path.ancestor}
      </span>
      <span className="shrink-0 whitespace-pre text-[var(--ink-muted)]/75">
        {path.separator}
      </span>
      <span className="min-w-0 max-w-full shrink-0 truncate font-normal text-[var(--ink)]">
        {path.leaf}
      </span>
    </span>
  );
}
