import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { cancellableFetch } from "./utils/cancellation";

const HEALTH_TIMEOUT_MS = 1_000;
const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_POLL_MS = 250;

let companionProcess: ChildProcess | null = null;
let startupPromise: Promise<boolean> | null = null;

function isAutostartEnabled(): boolean {
  return !["0", "false", "no"].includes(
    (process.env.MIROFISH_COMPANION_AUTOSTART ?? "1").toLowerCase(),
  );
}

async function isHealthy(baseUrl: URL): Promise<boolean> {
  try {
    const apiSecretKey = process.env.MIROFISH_API_SECRET_KEY?.trim();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiSecretKey) headers["X-API-Key"] = apiSecretKey;
    const response = await cancellableFetch(
      new URL("/health", baseUrl).toString(),
      { method: "GET", headers },
      { timeoutMs: HEALTH_TIMEOUT_MS },
    );
    if (!response.ok) return false;
    const payload = (await response.json().catch(() => null)) as
      | { service?: unknown }
      | null;
    return payload?.service === "mirofish-novel-companion";
  } catch {
    return false;
  }
}

function sourceCompanionCommand(): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
} | null {
  const sourceRoot = process.env.MIROFISH_SOURCE_ROOT?.trim();
  if (!sourceRoot) return null;
  const backendRoot = resolve(sourceRoot, "backend");
  const runner = resolve(backendRoot, "novel_companion.py");
  const requirements = resolve(backendRoot, "companion-requirements.txt");
  if (!existsSync(runner) || !existsSync(requirements)) return null;
  return {
    executable: process.platform === "win32" ? "uv.exe" : "uv",
    args: [
      "run",
      "--no-project",
      "--with-requirements",
      requirements,
      "python",
      runner,
    ],
    cwd: backendRoot,
  };
}

function packagedCompanionCommand(): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
} | null {
  const executable = process.env.MYAGENTS_MIROFISH_COMPANION_PATH?.trim();
  if (!executable || !existsSync(executable)) return null;
  return {
    executable,
    args: [],
    cwd: dirname(executable),
  };
}

function spawnCompanion(baseUrl: URL): boolean {
  const command = packagedCompanionCommand() ?? sourceCompanionCommand();
  if (!command) return false;

  const child = spawn(command.executable, [...command.args], {
    cwd: command.cwd,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      MIROFISH_HOST: baseUrl.hostname,
      MIROFISH_PORT: baseUrl.port || "80",
      MIROFISH_COMPANION_MODE: "1",
      MIROFISH_PARENT_PID: String(process.pid),
      API_SECRET_KEY: process.env.MIROFISH_API_SECRET_KEY ?? "",
      NOVEL_SIMULATION_DATA_DIR:
        process.env.NOVEL_SIMULATION_DATA_DIR ??
        resolve(
          process.env.MYAGENTS_DATA_DIR ?? process.cwd(),
          "mirofish-novel-simulations",
        ),
    },
  });
  companionProcess = child;
  child.once("error", () => {
    if (companionProcess === child) companionProcess = null;
  });
  child.once("exit", () => {
    if (companionProcess === child) companionProcess = null;
  });
  child.unref();
  return true;
}

async function waitForHealthy(baseUrl: URL): Promise<boolean> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy(baseUrl)) return true;
    if (!companionProcess) return false;
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, STARTUP_POLL_MS),
    );
  }
  return false;
}

/** Ensure the optional local companion is ready before forwarding a request. */
export async function ensureMiroFishCompanion(baseUrl: URL): Promise<boolean> {
  if (await isHealthy(baseUrl)) return true;
  if (!isAutostartEnabled()) return false;
  if (startupPromise) return startupPromise;

  startupPromise = (async () => {
    if (!companionProcess && !spawnCompanion(baseUrl)) return false;
    const healthy = await waitForHealthy(baseUrl);
    if (!healthy && companionProcess) {
      companionProcess.kill();
      companionProcess = null;
    }
    return healthy;
  })().finally(() => {
    startupPromise = null;
  });
  return startupPromise;
}
