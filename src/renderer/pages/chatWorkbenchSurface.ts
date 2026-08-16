export interface ChatWorkbenchSurface {
  readonly promptId?: string;
  readonly title?: string;
  readonly promptContent?: string;
  readonly embedded?: boolean;
}

/** The parent workbench owns the companion area for embedded Agent sessions. */
export function shouldRenderWorkbenchReferencePanel(
  surface: ChatWorkbenchSurface | undefined,
): boolean {
  return surface !== undefined && surface.embedded !== true;
}
