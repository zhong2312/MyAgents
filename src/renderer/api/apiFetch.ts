/**
 * Unified API fetch utility that works in both browser and Tauri modes.
 * - Browser mode: Uses native fetch with relative URLs (Vite proxy)
 * - Tauri mode: Uses the owner-addressed Global Sidecar command through Rust
 *
 * For Tauri mode, this uses the Global Sidecar owner, which is suitable
 * for global operations like API key verification in Settings.
 */

import { globalSidecarFetch } from './tauriClient';
import { isTauriEnvironment } from "@/utils/browserMock";

export interface TransientApiRetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export function isTransientSidecarError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError")
    return false;
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return [
    "error sending request",
    "connection refused",
    "connection reset",
    "econnrefused",
    "sendrequest",
    "sidecar",
    "尚未就绪",
    "failed to fetch",
    "load failed",
  ].some((fragment) => message.includes(fragment));
}

export async function withTransientSidecarRetry<T>(
  operation: () => Promise<T>,
  options: TransientApiRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 8);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 150);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 1500);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientSidecarError(error) || attempt === attempts - 1) {
        throw error;
      }
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Fetch from API endpoint, handling both browser and Tauri modes
 * Uses the global Sidecar for API calls (suitable for Settings page)
 * Will wait for global sidecar to be ready before making requests
 * @param endpoint - API endpoint starting with / (e.g., '/agent/dir')
 * @param options - Fetch options
 */
export async function apiFetch(
  endpoint: string,
  options?: RequestInit,
): Promise<Response> {
  const execute = async () => {
    if (isTauriEnvironment()) {
      return globalSidecarFetch(endpoint, options);
    }
    // Browser mode: use relative URL (Vite proxy handles it)
    return fetch(endpoint, options);
  };

  const method = (options?.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD"
    ? withTransientSidecarRetry(execute)
    : execute();
}

/**
 * POST JSON to API endpoint
 */
export async function apiPostJson<T>(
  endpoint: string,
  data: unknown,
): Promise<T> {
  const response = await apiFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      (errorData as { error?: string }).error || `HTTP ${response.status}`,
    );
  }

  return response.json();
}

/**
 * GET JSON from API endpoint
 */
export async function apiGetJson<T>(endpoint: string): Promise<T> {
  const response = await apiFetch(endpoint);

  if (!response.ok) {
    const responseText = await response.text();
    console.error("[apiGetJson] Error response:", {
      status: response.status,
      endpoint,
      body: responseText.slice(0, 500), // First 500 chars
    });
    try {
      const errorData = JSON.parse(responseText);
      throw new Error(
        (errorData as { error?: string }).error || `HTTP ${response.status}`,
      );
    } catch {
      throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 100)}`);
    }
  }

  return response.json();
}

/**
 * POST FormData to API endpoint (for file uploads)
 *
 * WARNING: FormData uploads don't work through the Tauri JSON command.
 * This function only works in browser development mode.
 * For Tauri mode file uploads, use Tauri's native file dialog APIs.
 */
export async function apiPostFormData<T>(
  endpoint: string,
  formData: FormData,
): Promise<T> {
  if (isTauriEnvironment()) {
    // FormData doesn't serialize properly through the Tauri JSON command
    // Need to use Tauri's native file APIs for file uploads in desktop mode
    throw new Error(
      "FormData uploads are not supported in desktop mode. " +
        "Please use Tauri file dialog APIs for file operations.",
    );
  }

  // Browser mode: use native fetch
  const response = await fetch(endpoint, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      (errorData as { error?: string }).error || `HTTP ${response.status}`,
    );
  }

  return response.json();
}

/**
 * PUT JSON to API endpoint
 */
export async function apiPutJson<T>(
  endpoint: string,
  data: unknown,
): Promise<T> {
  const response = await apiFetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      (errorData as { error?: string }).error || `HTTP ${response.status}`,
    );
  }

  return response.json();
}

/**
 * DELETE request to API endpoint
 */
export async function apiDelete<T>(endpoint: string): Promise<T> {
  const response = await apiFetch(endpoint, {
    method: "DELETE",
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      (errorData as { error?: string }).error || `HTTP ${response.status}`,
    );
  }

  return response.json();
}
