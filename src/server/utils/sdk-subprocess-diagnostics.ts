export type SdkSubprocessFailureKind =
  | 'sdk-child-spawn-denied'
  | 'sdk-child-launch-circuit-open'
  | 'windows-git-bash-missing'
  | 'windows-subprocess-exit-1'
  | 'windows-native-bun-crash';

export interface SdkSubprocessFailureDiagnostic {
  kind: SdkSubprocessFailureKind;
  userMessage: string;
  imMessage: string;
  exitCode?: number;
  exitCodeHex?: string;
  errorCode?: 'EPERM' | 'EACCES' | 'ENOEXEC';
  automaticRetryDelayMs?: number;
}

const UINT32_MAX_PLUS_ONE = 0x1_0000_0000;

const WINDOWS_NATIVE_CRASH_CODES = new Set([
  0xc000001d, // STATUS_ILLEGAL_INSTRUCTION
  0xc0000005, // STATUS_ACCESS_VIOLATION
  0xc0000409, // STATUS_STACK_BUFFER_OVERRUN
]);
const SDK_CHILD_CIRCUIT_HANDOFF_DELAY_MS = 1_000;
type DeterministicLaunchCode = NonNullable<SdkSubprocessFailureDiagnostic['errorCode']>;

export class SdkChildLaunchCircuitOpenError extends Error {
  readonly code = 'SDK_CHILD_LAUNCH_CIRCUIT_OPEN';
  readonly errorCode: DeterministicLaunchCode;
  readonly retryAfterMs: number;
  readonly imMessage: string;
  readonly platform: NodeJS.Platform | string;

  constructor(
    errorCode: DeterministicLaunchCode,
    retryAfterMs: number,
    platform: NodeJS.Platform | string = process.platform,
  ) {
    const messages = launchDeniedMessages(errorCode, platform, '');
    super(messages.userMessage);
    this.name = 'SdkChildLaunchCircuitOpenError';
    this.errorCode = errorCode;
    this.retryAfterMs = retryAfterMs;
    this.imMessage = messages.imMessage;
    this.platform = platform;
  }
}

function parseDeterministicLaunchCode(raw: string): DeterministicLaunchCode | undefined {
  return raw.match(/\b(EPERM|EACCES|ENOEXEC)\b/i)?.[1]?.toUpperCase() as
    | DeterministicLaunchCode
    | undefined;
}

function launchDeniedMessages(
  code: DeterministicLaunchCode,
  platform: NodeJS.Platform | string,
  originalMessage: string,
): Pick<SdkSubprocessFailureDiagnostic, 'userMessage' | 'imMessage'> {
  const system = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : '操作系统';
  const suffix = originalErrorSuffix(originalMessage);
  return {
    userMessage: `Claude 运行组件被 ${system} 拒绝执行（${code}）。MyAgents 已暂停密集自动重试；请更新或重新安装应用后重试。${suffix}`,
    imMessage: `AI 引擎被 ${system} 拒绝执行（${code}）。MyAgents 已暂停密集自动重试；请在桌面端更新或重新安装应用后重试。`,
  };
}

function normalizeWindowsExitCode(code: number): number {
  return code < 0 ? code + UINT32_MAX_PLUS_ONE : code;
}

function formatHexCode(code: number): string {
  return `0x${normalizeWindowsExitCode(code).toString(16).toUpperCase().padStart(8, '0')}`;
}

function parseProcessExitCode(raw: string): number | undefined {
  const match = raw.match(/(?:process exited with code|exit code)\s+(-?\d+)/i);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? normalizeWindowsExitCode(parsed) : undefined;
}

function hasBunNativeCrashEvidence(raw: string): boolean {
  return /Bun has crashed|Illegal instruction|Failed to start HTTP Client thread|panic\([^)]*\):/i.test(raw);
}

/** Direct evidence that the failure is a missing bash (Git for Windows):
 *  cmd.exe's "not recognized" (EN + zh-CN localization), spawn ENOENT on
 *  bash, or a shebang that couldn't resolve /bin/bash. */
function hasBashMissingEvidence(raw: string): boolean {
  return (
    /['"]?bash['"]?\s*(is not recognized|不是内部或外部命令)/i.test(raw)
    || /spawn\s+bash\s+ENOENT|ENOENT[^\n]*\bbash\b|\bbash\b[^\n]*ENOENT/i.test(raw)
    || /\/(usr\/)?bin\/bash:\s*No such file/i.test(raw)
  );
}

/** The diagnostic REPLACES userFacingError at the consumer (agent-session),
 *  so the original error must ride along or its only copy lives in the log
 *  and a misclassified user has nothing to search for. */
function originalErrorSuffix(errorMessage: string): string {
  const trimmed = errorMessage.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const summary = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  return `（原始错误：${summary}）`;
}

export function diagnoseSdkSubprocessFailure(input: {
  error?: unknown;
  errorMessage?: string;
  stderr?: readonly string[];
  platform?: NodeJS.Platform | string;
}): SdkSubprocessFailureDiagnostic | null {
  const platform = input.platform ?? process.platform;
  const errorMessage = input.errorMessage
    ?? (input.error instanceof Error ? input.error.message : String(input.error ?? ''));
  const raw = [errorMessage, ...(input.stderr ?? [])].join('\n');

  // Circuit denial is an in-process structured error. Do not encode internal
  // control-plane state in a string that leaks through sibling UI surfaces.
  const circuitError = input.error as Partial<SdkChildLaunchCircuitOpenError> | undefined;
  if (
    circuitError?.code === 'SDK_CHILD_LAUNCH_CIRCUIT_OPEN'
    && isDeterministicLaunchCode(circuitError.errorCode)
  ) {
    const retryAfterMs = typeof circuitError.retryAfterMs === 'number'
      && Number.isFinite(circuitError.retryAfterMs)
      ? Math.max(1_000, Math.round(circuitError.retryAfterMs))
      : 1_000;
    return {
      kind: 'sdk-child-launch-circuit-open',
      errorCode: circuitError.errorCode,
      automaticRetryDelayMs: retryAfterMs,
      ...launchDeniedMessages(
        circuitError.errorCode,
        typeof circuitError.platform === 'string' ? circuitError.platform : platform,
        '',
      ),
    };
  }

  const launchCode = parseDeterministicLaunchCode(raw);
  const hasSdkSpawnEvidence = /Failed to spawn Claude Code process|\bspawn(?:ing)?\b[^\n]*(?:claude|Claude Code)/i.test(raw);
  if (launchCode && hasSdkSpawnEvidence) {
    return {
      kind: 'sdk-child-spawn-denied',
      errorCode: launchCode,
      // The first observed denial opens the Rust circuit. Let the normal short
      // recovery path consult Rust once; its response is the only retry clock.
      automaticRetryDelayMs: SDK_CHILD_CIRCUIT_HANDOFF_DELAY_MS,
      ...launchDeniedMessages(launchCode, platform, errorMessage),
    };
  }

  if (platform !== 'win32') return null;

  const exitCode = parseProcessExitCode(raw);

  // Native-crash evidence is checked FIRST (cross-review 0.2.32): a Bun
  // crash that happens to exit 1 must not be classified as a Git problem.
  const isNativeCrash =
    (exitCode !== undefined && WINDOWS_NATIVE_CRASH_CODES.has(exitCode))
    || hasBunNativeCrashEvidence(raw);
  if (isNativeCrash) {
    const codeSuffix = exitCode === undefined
      ? ''
      : `（exit code ${exitCode} / ${formatHexCode(exitCode)}）`;
    return {
      kind: 'windows-native-bun-crash',
      exitCode,
      exitCodeHex: exitCode === undefined ? undefined : formatHexCode(exitCode),
      userMessage: `Claude Agent SDK 启动失败${codeSuffix}，请检查运行环境。`,
      imMessage: `Claude Agent SDK 启动失败${codeSuffix}，请检查运行环境。`,
    };
  }

  if (exitCode === 1) {
    const suffix = originalErrorSuffix(errorMessage);
    if (hasBashMissingEvidence(raw)) {
      // Confident: stderr names the missing bash.
      return {
        kind: 'windows-git-bash-missing',
        exitCode,
        exitCodeHex: formatHexCode(exitCode),
        userMessage: `子进程启动失败 (exit code 1)：未找到 bash，通常表示未安装 Git for Windows。请安装 Git：https://git-scm.com/downloads/win ${suffix}`,
        imMessage: 'AI 引擎启动失败：Windows 机器未找到 bash（通常是未安装 Git for Windows）。请在桌面端安装 Git 后重试。',
      };
    }
    // Ambiguous (cross-review 0.2.32): exit 1 also covers CLI fatals, AV
    // interference, broken config… Lead with the hint for the most common
    // cause, but hedge and keep the original error so a user who HAS Git
    // installed isn't steered into a dead end.
    return {
      kind: 'windows-subprocess-exit-1',
      exitCode,
      exitCodeHex: formatHexCode(exitCode),
      userMessage: `子进程启动失败 (exit code 1)。常见原因：未安装 Git for Windows（https://git-scm.com/downloads/win）；也可能是杀毒软件拦截或运行环境异常。${suffix}`,
      imMessage: `AI 引擎启动失败 (exit code 1)。常见原因：Windows 机器未安装 Git for Windows；也可能是杀毒软件拦截或运行环境异常。请在桌面端检查后重试。`,
    };
  }

  return null;
}

function isDeterministicLaunchCode(value: unknown): value is DeterministicLaunchCode {
  return value === 'EPERM' || value === 'EACCES' || value === 'ENOEXEC';
}

export function sdkSubprocessUserMessage(
  error: unknown,
  stderr?: readonly string[],
): string | null {
  return diagnoseSdkSubprocessFailure({ error, stderr })?.userMessage ?? null;
}
