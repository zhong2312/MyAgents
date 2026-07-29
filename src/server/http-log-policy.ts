const SILENT_HTTP_GET_LOG_PATHS = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/health/functional',
  '/api/unified-log',
  '/api/session-state',
  '/agent/dir',
  '/sessions',
  '/api/commands',
  '/api/agents/enabled',
  '/api/git/branch',
]);

/** Successful poll/config reads have no per-request diagnostic value. */
export function shouldLogHttpRequest(method: string, pathname: string): boolean {
  return method !== 'GET' || !SILENT_HTTP_GET_LOG_PATHS.has(pathname);
}
