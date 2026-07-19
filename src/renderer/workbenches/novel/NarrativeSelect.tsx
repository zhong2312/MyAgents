import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

import { CustomSelect, type SelectOption } from "@/workbench-sdk";

interface OptionElementProps {
  readonly value?: string | number;
  readonly children?: ReactNode;
}

interface NarrativeSelectProps {
  readonly value: string;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly "aria-label"?: string;
  readonly onChange: (event: { readonly target: { readonly value: string } }) => void;
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!isValidElement<{ readonly children?: ReactNode }>(node)) return "";
  return Children.toArray(node.props.children).map(nodeText).join("");
}

function collectOptions(node: ReactNode, options: SelectOption[]): void {
  Children.forEach(node, (child) => {
    if (!isValidElement<OptionElementProps>(child)) return;
    if (child.type === "option") {
      const option = child as ReactElement<OptionElementProps>;
      options.push({
        value: String(option.props.value ?? ""),
        label: nodeText(option.props.children),
        content: option.props.children,
      });
      return;
    }
    collectOptions(child.props.children, options);
  });
}

export default function NarrativeSelect({
  value,
  children,
  disabled = false,
  className,
  "aria-label": ariaLabel,
  onChange,
}: NarrativeSelectProps) {
  const options: SelectOption[] = [];
  collectOptions(children, options);
  const wrapperClassName = className
    ?.replace(/\bns-select\b/gu, "")
    .trim();
  return (
    <CustomSelect
      value={value}
      options={options}
      disabled={disabled}
      ariaLabel={ariaLabel}
      className={wrapperClassName}
      size="toolbar"
      onChange={(nextValue) => onChange({ target: { value: nextValue } })}
    />
  );
}

