import { AsyncLocalStorage } from 'node:async_hooks';

type LarkAdmissionScope = {
  token: symbol;
  admitted: boolean;
  resolveAdmission: () => void;
};

export type LarkAdmissionExecution<T = unknown> = {
  admission: Promise<void>;
  completion: Promise<T>;
};

type LarkAdmissionGlobals = typeof globalThis & {
  __myagentsRunLarkAdmissionScopedTask?: <T>(task: () => Promise<T>) => LarkAdmissionExecution<T>;
  __myagentsCurrentLarkAdmissionToken?: () => symbol | undefined;
};

const admissionStorage = new AsyncLocalStorage<LarkAdmissionScope>();

function runLarkAdmissionScopedTask<T>(task: () => Promise<T>): LarkAdmissionExecution<T> {
  let resolveAdmissionPromise!: () => void;
  const admission = new Promise<void>((resolve) => {
    resolveAdmissionPromise = resolve;
  });
  const scope: LarkAdmissionScope = {
    token: Symbol('lark-chat-task'),
    admitted: false,
    resolveAdmission() {
      if (scope.admitted) return;
      scope.admitted = true;
      resolveAdmissionPromise();
    },
  };
  const completion = admissionStorage.run(scope, () => Promise.resolve().then(task));

  // Commands, filtered events, and setup failures may finish without reaching
  // Bridge → Rust ingress. Their completion is also their admission boundary,
  // so the next same-chat task must never remain parked behind them.
  void completion.then(scope.resolveAdmission, scope.resolveAdmission);
  return { admission, completion };
}

/** Install the two structural hooks used by the load-time Lark queue patch. */
export function installLarkAdmissionRuntimeGlobals(): void {
  const globals = globalThis as LarkAdmissionGlobals;
  globals.__myagentsRunLarkAdmissionScopedTask = runLarkAdmissionScopedTask;
  globals.__myagentsCurrentLarkAdmissionToken = () => admissionStorage.getStore()?.token;
}

/** Release only the inbound-ordering lease; the plugin task stays alive until delivery completes. */
export function markCurrentLarkInboundAccepted(): boolean {
  const scope = admissionStorage.getStore();
  if (!scope) return false;
  scope.resolveAdmission();
  return true;
}
