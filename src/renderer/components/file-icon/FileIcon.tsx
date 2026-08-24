import { memo } from "react";

import { FILE_ICON_ASSETS } from "./fileIconAssets";
import {
  resolveFileIconDescriptor,
  type FileIconResolveInput,
} from "./fileIconRegistry";

export const FILE_ICON_SIZES = {
  dense: 16,
  regular: 20,
  display: 24,
} as const;

export type FileIconSize = keyof typeof FILE_ICON_SIZES;

export interface FileIconProps extends FileIconResolveInput {
  size?: FileIconSize;
  className?: string;
  /** Leave unset when a visible filename already labels the icon. */
  label?: string;
}

/**
 * The sole renderer for concrete file/folder identity. Classification is pure
 * and synchronous; SVG URLs are bundled locally by Vite.
 */
export const FileIcon = memo(function FileIcon({
  name,
  nodeKind = "file",
  expanded = false,
  size = "dense",
  className,
  label,
}: FileIconProps) {
  const descriptor = resolveFileIconDescriptor({ name, nodeKind, expanded });
  const asset = FILE_ICON_ASSETS[descriptor.iconId];
  const pixels = FILE_ICON_SIZES[size];

  return (
    <img
      src={asset.src}
      width={pixels}
      height={pixels}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      draggable={false}
      className={`inline-block shrink-0 select-none object-contain${className ? ` ${className}` : ""}`}
      style={{ width: pixels, height: pixels }}
      data-file-icon-id={descriptor.iconId}
      data-file-icon-category={descriptor.category}
      data-file-icon-matched-by={descriptor.matchedBy}
    />
  );
});
