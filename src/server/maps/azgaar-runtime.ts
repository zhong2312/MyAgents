import { createHash } from "node:crypto";

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  findAzgaarBrowserPath,
  startAzgaarRuntimeHost,
  type AzgaarRuntimeHost,
} from "./azgaar-runtime-host";
import { getScriptDir } from "../utils/runtime";

/**
 * Azgaar 的官方项目是浏览器应用，而不是 Node 纯函数库。该协议把它放在
 * 独立 WebView/iframe 或本地 HTTP 运行时中，主 Sidecar 只负责上下文、命令
 * 和导出物，不接管 Azgaar 的全局 pack/grid/options 状态。
 */
export interface AzgaarRuntimeWorldContext {
  readonly sourceHash: string;
  readonly files: Readonly<Record<string, string | null>>;
  readonly summary?: string;
  readonly constraints?: {
    readonly spatialNames?: readonly string[];
    readonly placeNames?: readonly string[];
    readonly factionNames?: readonly string[];
    readonly terrainKeywords?: readonly string[];
  };
}

export interface AzgaarRuntimeGenerateRequest {
  readonly seed: string;
  readonly width: number;
  readonly height: number;
  readonly world: AzgaarRuntimeWorldContext;
  readonly options?: {
    readonly heightmapTemplate?: string;
    readonly states?: number;
    readonly cultures?: number;
    readonly religions?: number;
    readonly temperatureEquator?: number;
    readonly temperatureNorthPole?: number;
    readonly temperatureSouthPole?: number;
    readonly precipitation?: number;
  };
}

export interface AzgaarRuntimeExport {
  readonly format: "json" | "geojson" | "svg";
  readonly content: string;
  readonly fileName?: string;
  /** Optional full-fidelity preview returned alongside structured data. */
  readonly previewSvg?: string;
}

export interface AzgaarRuntime {
  readonly id: string;
  generate(request: AzgaarRuntimeGenerateRequest): Promise<AzgaarRuntimeExport>;
  dispose?(): Promise<void>;
}

export interface AzgaarRuntimeClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Start the bundled/local browser host when no external URL is configured. */
  readonly autoStartLocalHost?: boolean;
  readonly hostOptions?: {
    readonly distDir?: string;
    readonly browserPath?: string;
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function asExport(value: unknown): AzgaarRuntimeExport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Azgaar Runtime 返回了无效导出对象");
  }
  const record = value as Record<string, unknown>;
  const format = record.format;
  const content = record.content;
  if (
    (format !== "json" && format !== "geojson" && format !== "svg") ||
    typeof content !== "string" ||
    content.length === 0
  ) {
    throw new Error("Azgaar Runtime 导出必须包含 format 和非空 content");
  }
  return {
    format,
    content,
    ...(typeof record.fileName === "string" ? { fileName: record.fileName } : {}),
    ...(typeof record.previewSvg === "string" ? { previewSvg: record.previewSvg } : {}),
  };
}

function findAzgaarDistDir(explicit?: string): string | null {
  const scriptDir = getScriptDir();
  const developmentCandidates: string[] = [];
  let ancestor = scriptDir;
  for (let index = 0; index < 7; index += 1) {
    developmentCandidates.push(resolve(ancestor, "src-tauri", "resources", "azgaar"));
    ancestor = resolve(ancestor, "..");
  }
  const candidates = [
    explicit,
    process.env.MYAGENTS_AZGAAR_DIST_DIR,
    resolve(scriptDir, "azgaar"),
    ...developmentCandidates,
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const candidate of candidates) {
    const root = resolve(candidate);
    if (existsSync(join(root, "index.html"))) return root;
  }
  return null;
}

/** 创建一个不拥有浏览器状态的 HTTP Runtime 客户端。 */
export function createAzgaarRuntimeClient(
  options: AzgaarRuntimeClientOptions = {},
): AzgaarRuntime {
  const configuredBaseUrl = (options.baseUrl ?? process.env.MYAGENTS_AZGAAR_RUNTIME_URL ?? "").trim().replace(/\/$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1_000, Math.min(300_000, options.timeoutMs ?? 120_000));
  const autoStartLocalHost = options.autoStartLocalHost ?? !configuredBaseUrl;
  let localHost: AzgaarRuntimeHost | null = null;
  let localHostPromise: Promise<AzgaarRuntimeHost> | null = null;

  const getBaseUrl = async (): Promise<string> => {
    if (configuredBaseUrl) return configuredBaseUrl;
    if (!autoStartLocalHost) {
      throw new Error("未配置 Azgaar Runtime。请启动独立运行时并设置 MYAGENTS_AZGAAR_RUNTIME_URL");
    }
    if (!findAzgaarDistDir(options.hostOptions?.distDir)) {
      throw new Error(
        "未找到 Azgaar Runtime 资源。请运行 prepare-azgaar-runtime，或设置 MYAGENTS_AZGAAR_DIST_DIR / MYAGENTS_AZGAAR_RUNTIME_URL",
      );
    }
    localHostPromise ??= startAzgaarRuntimeHost({
      distDir: findAzgaarDistDir(options.hostOptions?.distDir) ?? undefined,
      browserPath: options.hostOptions?.browserPath,
    }).then((host) => {
      localHost = host;
      return host;
    });
    return (await localHostPromise).baseUrl;
  };

  if (!configuredBaseUrl && !autoStartLocalHost) {
    throw new Error("未配置 Azgaar Runtime。请启动独立运行时并设置 MYAGENTS_AZGAAR_RUNTIME_URL");
  }

  return {
    id: configuredBaseUrl ? "azgaar-http-runtime" : "azgaar-local-browser-runtime",
    async generate(request) {
      const baseUrl = await getBaseUrl();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...request,
            world: {
              ...request.world,
              contextHash: request.world.sourceHash || sha256(request.world.files),
            },
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          let parsedDetail = detail;
          try {
            const value = JSON.parse(detail) as { error?: unknown };
            if (typeof value.error === "string") parsedDetail = value.error;
          } catch {
            // Preserve the plain response body.
          }
          throw new Error(
            `Azgaar Runtime 返回 HTTP ${response.status}${parsedDetail ? `：${parsedDetail}` : ""}`,
          );
        }
        return asExport(await response.json());
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Azgaar Runtime 超时（${timeoutMs}ms）`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    async dispose() {
      if (localHost) {
        await localHost.close();
        localHost = null;
        localHostPromise = null;
      }
    },
  };
}

export function azgaarRuntimeConfigured(): boolean {
  if ((process.env.MYAGENTS_AZGAAR_RUNTIME_URL ?? "").trim()) return true;
  return Boolean(findAzgaarDistDir() && findAzgaarBrowserPath());
}
