import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const WorkbenchHeaderActionsTargetContext = createContext<
  HTMLElement | null | undefined
>(undefined);

export function WorkbenchHeaderActionsProvider({
  target,
  children,
}: {
  readonly target: HTMLElement | null;
  readonly children: ReactNode;
}) {
  return (
    <WorkbenchHeaderActionsTargetContext.Provider value={target}>
      {children}
    </WorkbenchHeaderActionsTargetContext.Provider>
  );
}

export default function WorkbenchHeaderActions({
  children,
}: {
  readonly children: ReactNode;
}) {
  const target = useContext(WorkbenchHeaderActionsTargetContext);
  if (target === undefined) return children;
  return target ? createPortal(children, target) : null;
}
