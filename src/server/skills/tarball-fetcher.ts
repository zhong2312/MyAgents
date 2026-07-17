/**
 * tarball-fetcher.ts — Download a GitHub/raw zip and extract it into memory.
 *
 * Responsibilities:
 *   - Fetch trusted GitHub tarballs through the MyAgents general proxy overlay
 *   - Keep arbitrary raw ZIP URLs on the DNS-pinned direct SSRF-safe path
 *   - Default-branch fallback (try main → master on 404)
 *   - Enforce size / file-count / per-file limits (zip-bomb defense)
 *   - Strip the GitHub-style wrapper root (`<repo>-<ref>/...`) automatically
 *   - Return an in-memory tree {relativePath: Buffer} for downstream extraction
 *
 * Does NOT write to disk — callers are responsible for choosing a target
 * directory and using the existing zip-slip-protected write path in
 * `/api/skill/upload`.
 */

import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

import AdmZip from 'adm-zip';
import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import { buildGithubZipCandidates, SkillUrlError, type ResolvedSkillSource } from './url-resolver';
import { getGeneralRequestDispatcher } from '../proxy-state';

// ---------------------------------------------------------------------------
// Limits (tuned for "pit of success" — refuse anything suspicious by default)
// ---------------------------------------------------------------------------

const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // 50 MB total download
const MAX_FILES_PER_REPO = 2000;             // plenty for 99% of skill repos
const MAX_FILE_BYTES = 5 * 1024 * 1024;      // 5 MB per file (skill assets rarely exceed this)
// 5 min — covers slow CN proxies + ~40-file subdirectory repos which can take
// 30s+ even with `git clone`. Previous value (60s) was the hard cap users hit
// repeatedly (#193). Caller-side budgets (sidecarSelf, Rust proxy) must be ≥ this.
const FETCH_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * In-memory file tree after extraction.
 * Keys are POSIX-style relative paths (no leading slash, no `..`).
 * GitHub's wrapper root (`<repo>-<sha>/`) has been stripped.
 */
export interface ExtractedTree {
  files: Map<string, Buffer>;
  /** Original download URL that actually succeeded (for logging / provenance) */
  sourceUrl: string;
  /** Effective ref used (populated when default-branch fallback was taken) */
  effectiveRef?: string;
}

export class TarballFetchError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'TarballFetchError';
    this.statusCode = statusCode;
  }
}

/**
 * Fetch the zip for a resolved skill source and return the extracted tree.
 * Throws TarballFetchError on any HTTP/size/format failure.
 */
export async function fetchSkillZip(src: ResolvedSkillSource): Promise<ExtractedTree> {
  const candidates = src.kind === 'github'
    ? buildGithubZipCandidates(src)
    : [src.rawZipUrl!];

  let lastError: TarballFetchError | null = null;

  for (const url of candidates) {
    try {
      const { buffer, effectiveRef } = await downloadZip(url, src);
      const files = extractZipInMemory(buffer);
      return { files, sourceUrl: url, effectiveRef };
    } catch (err) {
      if (err instanceof TarballFetchError && err.statusCode === 404 && candidates.length > 1) {
        // Default-branch fallback: try next candidate
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new TarballFetchError('No candidate URLs to try', 500);
}

// ---------------------------------------------------------------------------
// SSRF guard — reject any URL host that points at localhost or a private IP
// ---------------------------------------------------------------------------

/**
 * Reject URLs whose host is loopback / RFC1918 / link-local, either as a
 * literal or via DNS resolution.
 *
 * The GitHub path goes through codeload.github.com which is public-only, but
 * the raw-zip passthrough accepts arbitrary user URLs, and redirects during
 * fetch can land anywhere. We validate both the initial URL and every redirect
 * hop.
 */
export function isBlockedSkillPackageHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '::0' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:0' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized === 'ip6-loopback' ||
    normalized === 'ip6-localhost'
  ) {
    return true;
  }

  const ipv4Match = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return true;
    const [a, b] = octets;
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      a === 0
    );
  }

  if (isIP(normalized) === 6) {
    return (
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('::ffff:')
    );
  }

  return false;
}

export function isSkillPackageUrlLexicallySafe(parsed: URL): { ok: true } | { ok: false; reason: string } {
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `不支持的协议：${parsed.protocol}，请使用 HTTPS 链接` };
  }
  if (isBlockedSkillPackageHost(parsed.hostname)) {
    return { ok: false, reason: `拒绝连接到私有网络地址：${parsed.hostname}` };
  }
  return { ok: true };
}

async function buildSsrfGuardedDispatcher(parsed: URL): Promise<Agent | undefined> {
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return undefined;

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new TarballFetchError(`DNS 解析失败：${host}`, 400);
  }
  if (addresses.length === 0) {
    throw new TarballFetchError(`DNS 未返回可用地址：${host}`, 400);
  }

  for (const { address } of addresses) {
    if (isBlockedSkillPackageHost(address)) {
      throw new TarballFetchError(`拒绝连接到解析为私有网络的主机：${host}`, 400);
    }
  }

  const pinned = addresses.map((a) => ({ address: a.address, family: a.family }));
  const pinnedLookup: LookupFunction = (_hostname, options, cb) => {
    if (options?.all) {
      cb(null, pinned);
      return;
    }
    const first = pinned[0];
    cb(null, first.address, first.family);
  };
  return new Agent({
    connect: {
      lookup: pinnedLookup,
    },
  });
}

async function closeDispatcher(dispatcher: Dispatcher | undefined): Promise<void> {
  if (!dispatcher) return;
  await dispatcher.close().catch(() => undefined);
}

async function assertPublicUrl(url: string): Promise<Agent | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TarballFetchError(`非法 URL：${url}`, 400);
  }
  const lexical = isSkillPackageUrlLexicallySafe(parsed);
  if (!lexical.ok) {
    throw new TarballFetchError(lexical.reason, 400);
  }
  return buildSsrfGuardedDispatcher(parsed);
}

// ---------------------------------------------------------------------------
// HTTP download with size + timeout enforcement + manual redirect following
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;

async function downloadZip(
  url: string,
  src: ResolvedSkillSource,
): Promise<{ buffer: Buffer; effectiveRef?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let terminalDispatcher: Dispatcher | undefined;

  try {
    // Manual redirect loop: every hop is validated against the SSRF guard,
    // so a malicious `302 Location: http://127.0.0.1/…` cannot silently land
    // on an internal service. Bun's native `redirect: 'follow'` gives us no
    // hook into the intermediate URLs, so we do this by hand.
    let currentUrl = url;
    let resp: Response;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let hopDispatcher: Dispatcher | undefined;
      let ownsHopDispatcher = false;
      try {
        const pinnedDirectDispatcher = await assertPublicUrl(currentUrl);
        if (src.kind === 'github') {
          // GitHub coordinates resolve to a MyAgents-constructed codeload URL;
          // use the complete general baseline (app overlay or inherited env)
          // after the public-address check.
          // Arbitrary raw-zip URLs retain the DNS-pinned direct dispatcher so
          // proxy-side DNS cannot reintroduce a rebinding window.
          await closeDispatcher(pinnedDirectDispatcher);
          hopDispatcher = getGeneralRequestDispatcher();
        } else {
          hopDispatcher = pinnedDirectDispatcher;
          ownsHopDispatcher = true;
        }
        resp = await undiciFetch(currentUrl, {
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            'User-Agent': 'MyAgents-Skill-Installer/1.0',
            'Accept': 'application/zip, application/octet-stream',
          },
          ...(hopDispatcher ? { dispatcher: hopDispatcher } : {}),
        } as UndiciRequestInit) as unknown as Response;
      } catch (err) {
        if (ownsHopDispatcher) await closeDispatcher(hopDispatcher);
        throw err;
      }
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (ownsHopDispatcher) await closeDispatcher(hopDispatcher);
        if (!location) {
          throw new TarballFetchError(`重定向缺少 Location 头：HTTP ${resp.status}`, 502);
        }
        if (hop >= MAX_REDIRECTS) {
          throw new TarballFetchError(`重定向次数过多 (>${MAX_REDIRECTS})`, 508);
        }
        // Resolve relative Location against current URL
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }
      terminalDispatcher = ownsHopDispatcher ? hopDispatcher : undefined;
      break;
    }
    // At this point resp is the terminal response (`break` above)
    resp = resp!;

    if (!resp.ok) {
      if (resp.status === 404) {
        throw new TarballFetchError(`仓库或分支不存在 (${resp.status})`, 404);
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new TarballFetchError(`无权访问仓库 (${resp.status}) — 暂不支持私有仓库`, resp.status);
      }
      throw new TarballFetchError(`下载失败：HTTP ${resp.status}`, resp.status);
    }

    // Early abort if Content-Length is too big
    const contentLength = resp.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_TARBALL_BYTES) {
      throw new TarballFetchError(
        `仓库太大 (${Math.round(Number(contentLength) / 1024 / 1024)} MB > 50 MB)`,
        413,
      );
    }

    const arrayBuffer = await resp.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_TARBALL_BYTES) {
      throw new TarballFetchError(
        `下载体积超限 (${Math.round(arrayBuffer.byteLength / 1024 / 1024)} MB > 50 MB)`,
        413,
      );
    }

    // Determine effective ref from the *initial* URL we were asked to fetch
    // (not the terminal URL after redirects). The caller passed us a codeload
    // URL derived from src.ref via buildGithubZipCandidates.
    const refMatch = url.match(/\/zip\/(?:refs\/(?:heads|tags)\/)?([^/?#]+)$/);
    return {
      buffer: Buffer.from(arrayBuffer),
      effectiveRef: refMatch ? decodeURIComponent(refMatch[1]) : src.ref,
    };
  } catch (err) {
    if (err instanceof TarballFetchError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new TarballFetchError('下载超时 — 请检查网络或代理配置', 504);
    }
    throw new TarballFetchError(`下载失败：${(err as Error).message}`, 500);
  } finally {
    await closeDispatcher(terminalDispatcher);
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Zip → in-memory tree, stripping the GitHub wrapper root if present
// ---------------------------------------------------------------------------

function extractZipInMemory(buffer: Buffer): Map<string, Buffer> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new TarballFetchError(`无法解压 zip：${(err as Error).message}`, 422);
  }

  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new TarballFetchError('zip 是空的', 422);
  }
  if (entries.length > MAX_FILES_PER_REPO) {
    throw new TarballFetchError(
      `文件数过多 (${entries.length} > ${MAX_FILES_PER_REPO})`,
      413,
    );
  }

  // Detect single wrapper root (GitHub uses `<repo>-<ref-or-sha>/`)
  const topLevel = new Set<string>();
  for (const entry of entries) {
    const head = entry.entryName.split('/')[0];
    if (head && head !== '__MACOSX') topLevel.add(head);
  }
  const stripRoot = topLevel.size === 1 ? Array.from(topLevel)[0] : null;
  const prefixToStrip = stripRoot ? `${stripRoot}/` : '';

  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.entryName.startsWith('__MACOSX')) continue;

    let rel = entry.entryName;
    if (prefixToStrip && rel.startsWith(prefixToStrip)) {
      rel = rel.slice(prefixToStrip.length);
    }
    if (!rel) continue;

    // POSIX-normalize and reject any path traversal attempts
    if (rel.includes('..') || rel.startsWith('/')) continue;

    // Per-file size limit
    const data = entry.getData();
    if (data.length > MAX_FILE_BYTES) {
      throw new TarballFetchError(
        `文件过大：${rel} (${Math.round(data.length / 1024 / 1024)} MB > 5 MB)`,
        413,
      );
    }

    files.set(rel, data);
  }

  if (files.size === 0) {
    throw new TarballFetchError('zip 中未找到任何有效文件', 422);
  }

  return files;
}

// Exported for testing
export const _internals = {
  MAX_TARBALL_BYTES,
  MAX_FILES_PER_REPO,
  MAX_FILE_BYTES,
  FETCH_TIMEOUT_MS,
  extractZipInMemory,
};

// Re-export so consumers only need one import
export { SkillUrlError };
