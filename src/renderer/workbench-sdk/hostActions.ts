export interface WorkbenchHostActionDetail {
  readonly workbenchId: string;
  readonly workspacePath: string;
  readonly action: string;
  readonly payload?: Readonly<Record<string, string>>;
}

export type WorkbenchHostActionFilter = WorkbenchHostActionDetail;

const WORKBENCH_HOST_ACTION_EVENT = "myagents:workbench-host-action";

export function dispatchWorkbenchHostAction(
  detail: WorkbenchHostActionDetail,
): void {
  window.dispatchEvent(
    new CustomEvent<WorkbenchHostActionDetail>(WORKBENCH_HOST_ACTION_EVENT, {
      detail,
    }),
  );
}

export function subscribeWorkbenchHostAction(
  filter: WorkbenchHostActionFilter,
  listener: (detail: WorkbenchHostActionDetail) => void,
): () => void {
  const handleAction = (event: Event) => {
    const detail = (event as CustomEvent<WorkbenchHostActionDetail>).detail;
    if (
      detail?.workbenchId !== filter.workbenchId ||
      detail.workspacePath !== filter.workspacePath ||
      detail.action !== filter.action
    ) {
      return;
    }
    listener(detail);
  };
  window.addEventListener(WORKBENCH_HOST_ACTION_EVENT, handleAction);
  return () =>
    window.removeEventListener(WORKBENCH_HOST_ACTION_EVENT, handleAction);
}
