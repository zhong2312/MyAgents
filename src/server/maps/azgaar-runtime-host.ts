import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from "node:path";

import { spawn, type SubprocessHandle } from "../utils/subprocess";
import type {
  AzgaarRuntimeExport,
  AzgaarRuntimeGenerateRequest,
} from "./azgaar-runtime";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_GENERATION_TIMEOUT_MS = 120_000;
const DEFAULT_CDP_TIMEOUT_MS = 15_000;

type JsonRecord = Record<string, unknown>;

export interface AzgaarRuntimeHostOptions {
  readonly distDir?: string;
  readonly browserPath?: string;
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly generationTimeoutMs?: number;
}

export interface AzgaarRuntimeHost {
  readonly baseUrl: string;
  readonly distDir: string;
  readonly browserPath: string;
  close(): Promise<void>;
}

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: JsonRecord;
  readonly result?: JsonRecord;
  readonly error?: { readonly message?: string };
}

interface PendingCdpRequest {
  readonly resolve: (value: JsonRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function contentType(path: string): string {
  switch (extname(path).toLocaleLowerCase("en-US")) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`请求体超过 ${maxBytes} 字节限制`);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求体不是有效 JSON");
  }
}

function parseGenerateRequest(value: unknown): AzgaarRuntimeGenerateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("生成请求必须是对象");
  }
  const record = value as JsonRecord;
  const world = record.world;
  if (!world || typeof world !== "object" || Array.isArray(world)) {
    throw new Error("生成请求缺少世界架构快照");
  }
  const worldRecord = world as JsonRecord;
  if (typeof record.seed !== "string" || !record.seed.trim())
    throw new Error("seed 不能为空");
  if (!Number.isFinite(record.width) || !Number.isFinite(record.height))
    throw new Error("地图尺寸无效");
  if (typeof worldRecord.sourceHash !== "string" || !worldRecord.sourceHash)
    throw new Error("world.sourceHash 不能为空");
  const files = worldRecord.files;
  if (!files || typeof files !== "object" || Array.isArray(files))
    throw new Error("world.files 必须是对象");
  return {
    seed: record.seed.trim(),
    width: Math.max(240, Math.min(100_000, Math.round(Number(record.width)))),
    height: Math.max(240, Math.min(100_000, Math.round(Number(record.height)))),
    world: {
      sourceHash: worldRecord.sourceHash,
      files: files as Record<string, string | null>,
      ...(worldRecord.generationPlan &&
      typeof worldRecord.generationPlan === "object" &&
      !Array.isArray(worldRecord.generationPlan)
        ? {
            generationPlan:
              worldRecord.generationPlan as AzgaarRuntimeGenerateRequest["world"]["generationPlan"],
          }
        : {}),
      ...(typeof worldRecord.summary === "string"
        ? { summary: worldRecord.summary }
        : {}),
      ...(worldRecord.constraints &&
      typeof worldRecord.constraints === "object" &&
      !Array.isArray(worldRecord.constraints)
        ? {
            constraints:
              worldRecord.constraints as AzgaarRuntimeGenerateRequest["world"]["constraints"],
          }
        : {}),
    },
    ...(record.options &&
    typeof record.options === "object" &&
    !Array.isArray(record.options)
      ? { options: record.options as AzgaarRuntimeGenerateRequest["options"] }
      : {}),
  };
}

function browserCandidates(explicit?: string): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.PROGRAMFILES || "";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "";
  if (process.platform === "win32") {
    return [
      explicit,
      process.env.MYAGENTS_AZGAAR_BROWSER_PATH,
      join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter((value): value is string => Boolean(value));
  }
  if (process.platform === "darwin") {
    return [
      explicit,
      process.env.MYAGENTS_AZGAAR_BROWSER_PATH,
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      join(
        home,
        "Applications",
        "Google Chrome.app",
        "Contents",
        "MacOS",
        "Google Chrome",
      ),
    ].filter((value): value is string => Boolean(value));
  }
  return [
    explicit,
    process.env.MYAGENTS_AZGAAR_BROWSER_PATH,
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((value): value is string => Boolean(value));
}

export function findAzgaarBrowserPath(explicit?: string): string | null {
  return (
    browserCandidates(explicit).find(
      (candidate) => isAbsolute(candidate) && existsSync(candidate),
    ) ?? null
  );
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCdpRequest>();
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly defaultTimeoutMs = DEFAULT_CDP_TIMEOUT_MS,
  ) {
    socket.addEventListener("message", (event) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(String(event.data)) as CdpMessage;
      } catch {
        return;
      }
      if (!message.id) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error)
        request.reject(new Error(message.error.message || "CDP 命令失败"));
      else request.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () =>
      this.rejectAll(new Error("Azgaar 浏览器会话已关闭")),
    );
    socket.addEventListener("error", () =>
      this.rejectAll(new Error("Azgaar 浏览器会话连接失败")),
    );
  }

  static async connect(
    url: string,
    timeoutMs = DEFAULT_CDP_TIMEOUT_MS,
  ): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error("连接 Azgaar 浏览器会话超时")),
        timeoutMs,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolvePromise();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          rejectPromise(new Error("无法连接 Azgaar 浏览器会话"));
        },
        { once: true },
      );
    });
    return new CdpClient(socket, timeoutMs);
  }

  async send(
    method: string,
    params: JsonRecord = {},
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<JsonRecord> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      throw new Error("Azgaar 浏览器会话不可用");
    const id = this.nextId++;
    return new Promise<JsonRecord>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`CDP 命令 ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string, timeoutMs?: number): Promise<unknown> {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
    );
    const exception = result.exceptionDetails as JsonRecord | undefined;
    if (exception) {
      const description = (exception.exception as JsonRecord | undefined)
        ?.description;
      throw new Error(
        typeof description === "string"
          ? description
          : "Azgaar 页面脚本执行失败",
      );
    }
    return (result.result as JsonRecord | undefined)?.value;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("Azgaar 浏览器会话已释放"));
    this.socket.close();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function waitForDevToolsActivePort(
  profileDir: string,
  timeoutMs: number,
): Promise<{ port: number; browserWebSocketUrl: string }> {
  const filePath = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const [portLine, socketPath] = (await readFile(filePath, "utf8"))
        .trim()
        .split(/\r?\n/u);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && socketPath?.startsWith("/")) {
        return {
          port,
          browserWebSocketUrl: `ws://127.0.0.1:${port}${socketPath}`,
        };
      }
      lastError = new Error("DevToolsActivePort 内容无效");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`等待浏览器调试端口超时：${errorMessage(lastError)}`);
}

async function closeProcess(process: SubprocessHandle): Promise<void> {
  try {
    process.kill("SIGTERM");
  } catch {
    return;
  }
  await Promise.race([
    process.exited,
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
  try {
    process.kill("SIGKILL");
  } catch {
    // The browser already exited.
  }
}

function bootstrapScript(request: AzgaarRuntimeGenerateRequest): string {
  const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString(
    "base64",
  );
  return `(() => {
    const requestBytes = Uint8Array.from(atob("${encodedRequest}"), character => character.charCodeAt(0));
    const request = JSON.parse(new TextDecoder().decode(requestBytes));
    window.__MYAGENTS_WORLD_CONTEXT__ = request.world;
    window.__MYAGENTS_AZGAAR_DIAGNOSTICS__ = [];
    const describe = value => {
      if (value instanceof Error) return value.stack || value.message;
      if (typeof value === "string") return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    };
    const recordError = (...values) => {
      window.__MYAGENTS_AZGAAR_DIAGNOSTICS__.push(values.map(describe).join(" ").slice(0, 4000));
    };
    const originalConsoleError = console.error.bind(console);
    console.error = (...values) => {
      recordError(...values);
      originalConsoleError(...values);
    };
    window.addEventListener("error", event => recordError(event.error || event.message));
    window.addEventListener("unhandledrejection", event => recordError(event.reason));

    const options = request.options || {};
    const generationPlan = request.world.generationPlan || null;
    const storedOptions = {
      template: options.heightmapTemplate,
      statesNumber: options.states,
      cultures: options.cultures,
      religionsNumber: options.religions,
      temperatureEquator: options.temperatureEquator,
      temperatureNorthPole: options.temperatureNorthPole,
      temperatureSouthPole: options.temperatureSouthPole,
      prec: options.precipitation
    };
    for (const [key, value] of Object.entries(storedOptions)) {
      if (value !== undefined && value !== null) localStorage.setItem(key, String(value));
    }
    document.addEventListener("DOMContentLoaded", () => {
      const mapName = document.getElementById("mapName");
      if (mapName && request.world.summary) mapName.value = request.world.summary;
    }, { once: true });
    window.addEventListener("map:generated", event => {
      const constraints = request.world.constraints || {};
      const places = [...new Set(constraints.placeNames || [])].filter(Boolean);
      const regions = [...new Set([...(constraints.factionNames || []), ...(constraints.spatialNames || [])])].filter(Boolean);
      if (window.pack?.burgs) {
        window.pack.burgs.slice(1).forEach((burg, index) => {
          if (places[index]) burg.name = places[index];
        });
      }
      if (window.pack?.states) {
        window.pack.states.slice(1).forEach((state, index) => {
          if (regions[index]) state.name = regions[index];
        });
      }
      if (generationPlan?.entities) {
        window.__MYAGENTS_AZGAAR_GENERATION_PLAN__ = generationPlan;
      }
      window.__MYAGENTS_AZGAAR_GENERATED__ = {
        mapId: event.detail?.mapId || window.mapId || null,
        seed: event.detail?.seed || null
      };
    });
  })()`;
}

function exportScript(request: AzgaarRuntimeGenerateRequest): string {
  const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString(
    "base64",
  );
  return `(async () => {
    const requestBytes = Uint8Array.from(atob("${encodedRequest}"), character => character.charCodeAt(0));
    const request = JSON.parse(new TextDecoder().decode(requestBytes));
    const mapName = document.getElementById("mapName");
    if (mapName && request.world.summary) mapName.value = request.world.summary;
    // The completion event normally applies these names. Repeat the small
    // mapping here so an event missed during navigation cannot drop world
    // architecture names from the exported candidate.
    const constraints = request.world.constraints || {};
    const generationPlan = request.world.generationPlan || null;
    const places = [...new Set(constraints.placeNames || [])].filter(Boolean);
    const regions = [...new Set([...(constraints.factionNames || []), ...(constraints.spatialNames || [])])].filter(Boolean);
    if (window.pack?.burgs) {
      window.pack.burgs.slice(1).forEach((burg, index) => {
        if (places[index]) burg.name = places[index];
      });
    }
    if (window.pack?.states) {
      window.pack.states.slice(1).forEach((state, index) => {
        if (regions[index]) state.name = regions[index];
      });
    }
    if (generationPlan?.entities) {
      window.__MYAGENTS_AZGAAR_GENERATION_PLAN__ = generationPlan;
    }
    // The official exporter embeds active web fonts by fetching their URLs.
    // Use an offline-safe font for labels so the isolated runtime never needs
    // fonts.gstatic.com and the exported SVG remains self-contained.
    document.querySelectorAll("#labels g, #provs, #legend").forEach(element => {
      element.setAttribute("font-family", "Georgia");
    });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const url = await window.Services.ExportMap.getMapURL("svg", { fullMap: true });
    const svg = await (await fetch(url)).text();
    URL.revokeObjectURL(url);
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    let exportedJsonBlob = null;
    let exportedJsonUrl = null;
    URL.createObjectURL = blob => {
      const blobUrl = originalCreateObjectURL(blob);
      if (blob instanceof Blob && blob.type === "application/json") {
        exportedJsonBlob = blob;
        exportedJsonUrl = blobUrl;
      }
      return blobUrl;
    };
    URL.revokeObjectURL = () => {};
    try {
      // Minimal JSON omits pack.cells and pack.vertices. The adapter needs
      // those official topology collections to rebuild editable state,
      // province, biome and lake boundaries in MapDocument.
      await window.Services.ExportJson.exportToJson("Full");
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
    if (!exportedJsonBlob) throw new Error("Azgaar Full JSON export did not produce a Blob");
    const fullJson = await exportedJsonBlob.text();
    if (exportedJsonUrl) originalRevokeObjectURL(exportedJsonUrl);
    const fullData = JSON.parse(fullJson);
    fullData.worldSourceHash = request.world.sourceHash;
    return {
      format: "json",
      content: JSON.stringify(fullData),
      previewSvg: svg,
      fileName: "azgaar-" + request.world.sourceHash.slice(0, 12) + ".json"
    };
  })()`;
}

async function runGeneration(
  browserPath: string,
  pageUrl: string,
  request: AzgaarRuntimeGenerateRequest,
  timeoutMs: number,
): Promise<AzgaarRuntimeExport> {
  const profileDir = await mkdtemp(join(tmpdir(), "myagents-azgaar-"));
  const browser = spawn(
    [
      browserPath,
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true },
  );
  let cdp: CdpClient | null = null;
  let browserCdp: CdpClient | null = null;
  try {
    const devTools = await waitForDevToolsActivePort(
      profileDir,
      DEFAULT_CDP_TIMEOUT_MS,
    );
    browserCdp = await CdpClient.connect(devTools.browserWebSocketUrl);
    try {
      const created = await browserCdp.send("Target.createTarget", {
        url: "about:blank",
      });
      const targetId = created.targetId;
      if (typeof targetId !== "string")
        throw new Error("创建 Azgaar 浏览器页面失败");
      const deadline = Date.now() + DEFAULT_CDP_TIMEOUT_MS;
      let targetSocket: string | null = null;
      while (Date.now() < deadline && !targetSocket) {
        const targets = (await fetch(
          `http://127.0.0.1:${devTools.port}/json/list`,
        ).then((response) => response.json())) as Array<JsonRecord>;
        const target = targets.find((entry) => entry.id === targetId);
        targetSocket =
          typeof target?.webSocketDebuggerUrl === "string"
            ? target.webSocketDebuggerUrl
            : null;
        if (!targetSocket)
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      if (!targetSocket) throw new Error("Azgaar 页面没有可用的 DevTools 会话");
      cdp = await CdpClient.connect(targetSocket);
      await cdp.send("Runtime.enable");
      await cdp.send("Page.enable");
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: bootstrapScript(request),
      });
      await cdp.send("Page.bringToFront").catch(() => {});
      await cdp.send("Page.navigate", { url: pageUrl });
      const generationDeadline = Date.now() + timeoutMs;
      let status: unknown = null;
      while (Date.now() < generationDeadline) {
        try {
          status = await cdp.evaluate(
            `({
            readyState: document.readyState,
            mapId: window.mapId || null,
            generated: window.__MYAGENTS_AZGAAR_GENERATED__ || null,
            exportMap: Boolean(window.Services?.ExportMap?.getMapURL),
            exportJson: Boolean(window.Services?.ExportJson?.exportToJson),
            diagnostics: window.__MYAGENTS_AZGAAR_DIAGNOSTICS__ || []
          })`,
            2_000,
          );
          const current = status as JsonRecord | null;
          // `mapId` is Azgaar's own completion marker. The custom event is
          // only used for applying world names and may be missed during a
          // document replacement, so it must not turn a ready map into a
          // false generation timeout.
          if (current?.mapId && current.exportMap && current.exportJson) break;
        } catch {
          // Navigation can replace the execution context between polls.
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      const generatedStatus = status as JsonRecord | null;
      if (
        !generatedStatus?.mapId ||
        !generatedStatus.exportMap ||
        !generatedStatus.exportJson
      ) {
        throw new Error(
          `Azgaar 首图生成超时：${JSON.stringify(generatedStatus)}`,
        );
      }
      let exported: unknown;
      try {
        exported = await cdp.evaluate(exportScript(request), timeoutMs);
      } catch (error) {
        throw new Error(`Azgaar 生成阶段失败：${errorMessage(error)}`);
      }
      if (!exported || typeof exported !== "object" || Array.isArray(exported))
        throw new Error("Azgaar 页面没有返回导出物");
      const value = exported as JsonRecord;
      if (
        value.format !== "json" ||
        typeof value.content !== "string" ||
        typeof value.previewSvg !== "string"
      ) {
        throw new Error("Azgaar 页面返回的导出格式无效");
      }
      return {
        format: "json",
        content: value.content,
        previewSvg: value.previewSvg,
        ...(typeof value.fileName === "string"
          ? { fileName: value.fileName }
          : {}),
      };
    } finally {
      await browserCdp.send("Browser.close").catch(() => {});
      browserCdp.close();
      browserCdp = null;
    }
  } finally {
    cdp?.close();
    browserCdp?.close();
    await closeProcess(browser);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function serveAsset(
  distDir: string,
  requestPath: string,
  response: ServerResponse,
): Promise<void> {
  const decoded = decodeURIComponent(requestPath.split("?", 1)[0] || "/");
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const normalized = normalize(relative);
  const filePath = resolve(distDir, normalized);
  const rootPrefix = distDir.endsWith(sep) ? distDir : `${distDir}${sep}`;
  if (filePath !== distDir && !filePath.startsWith(rootPrefix)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentType(filePath),
      "content-length": body.length,
      "cache-control": "no-cache",
      // Azgaar compiles trusted bundled heightmap templates with Function().
      // This host is loopback-only, blocks external DNS, and serves a pinned dist.
      "content-security-policy":
        "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}

export async function startAzgaarRuntimeHost(
  options: AzgaarRuntimeHostOptions = {},
): Promise<AzgaarRuntimeHost> {
  const distDir = resolve(
    options.distDir ?? process.env.MYAGENTS_AZGAAR_DIST_DIR ?? "",
  );
  if (!options.distDir && !process.env.MYAGENTS_AZGAAR_DIST_DIR) {
    throw new Error("Azgaar Runtime Host 缺少 distDir");
  }
  await access(join(distDir, "index.html"), fsConstants.R_OK).catch(() => {
    throw new Error(`Azgaar Runtime 资源无效：${distDir}`);
  });
  const browserPath = findAzgaarBrowserPath(options.browserPath);
  if (!browserPath) {
    throw new Error(
      "未找到 Microsoft Edge、Google Chrome 或 Chromium；可设置 MYAGENTS_AZGAAR_BROWSER_PATH",
    );
  }
  const host = options.host ?? "127.0.0.1";
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const generationTimeoutMs =
    options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
  let baseUrl = "";
  let activeGeneration: Promise<AzgaarRuntimeExport> | null = null;
  const server = createServer(async (request, response) => {
    try {
      const path = request.url ?? "/";
      if (request.method === "GET" && path === "/health") {
        json(response, 200, {
          ok: true,
          runtime: "azgaar-browser-runtime",
          browser: basename(browserPath),
          distDir,
        });
        return;
      }
      if (request.method === "POST" && path === "/generate") {
        if (activeGeneration) {
          json(response, 409, { error: "Azgaar Runtime 正在生成另一张地图" });
          return;
        }
        const body = await readBody(request, maxBodyBytes);
        const generationRequest = parseGenerateRequest(body);
        const pageUrl = `${baseUrl}/runtime/index.html?seed=${encodeURIComponent(generationRequest.seed)}&width=${generationRequest.width}&height=${generationRequest.height}`;
        activeGeneration = runGeneration(
          browserPath,
          pageUrl,
          generationRequest,
          generationTimeoutMs,
        );
        try {
          json(response, 200, await activeGeneration);
        } finally {
          activeGeneration = null;
        }
        return;
      }
      if (request.method === "GET" && path.startsWith("/runtime/")) {
        await serveAsset(distDir, path.slice("/runtime".length), response);
        return;
      }
      if (
        request.method === "GET" &&
        path.startsWith("/Fantasy-Map-Generator/")
      ) {
        await serveAsset(
          distDir,
          path.slice("/Fantasy-Map-Generator".length),
          response,
        );
        return;
      }
      // Azgaar's production index contains root-relative assets (`/main.js`,
      // `/index.css`, `/libs/...`). Keep API routes above this fallback and
      // serve all remaining GETs from the isolated distribution root.
      if (request.method === "GET") {
        await serveAsset(distDir, path, response);
        return;
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      json(response, 500, { error: errorMessage(error) });
    }
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Azgaar Runtime Host 未获得本地端口");
  }
  baseUrl = `http://${host}:${address.port}`;
  return {
    baseUrl,
    distDir,
    browserPath,
    async close() {
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    },
  };
}
