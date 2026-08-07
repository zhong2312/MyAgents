const OUTBOUND_PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

export const MCP_LOCALHOST_NO_PROXY_VAL = 'localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1';

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function mergeNoProxyWithLocalhost(value: string | undefined): string {
  const entries = [
    ...MCP_LOCALHOST_NO_PROXY_VAL.split(','),
    ...(value?.split(',') ?? []),
  ]
    .map(item => item.trim())
    .filter(item => Boolean(item) && item.toLowerCase() !== '[::1]');
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of entries) {
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged.join(',');
}

export function buildMcpSubprocessEnv(
  parentEnv: NodeJS.ProcessEnv,
  serverEnv: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of OUTBOUND_PROXY_ENV_KEYS) {
    const value = parentEnv[key];
    if (value) {
      env[key] = value;
    }
  }

  const userNoProxy = nonEmpty(serverEnv?.NO_PROXY);
  const userNoProxyLower = nonEmpty(serverEnv?.no_proxy);
  const explicitNoProxy = userNoProxy ?? userNoProxyLower;

  env.NO_PROXY = mergeNoProxyWithLocalhost(explicitNoProxy);
  env.no_proxy = mergeNoProxyWithLocalhost(userNoProxyLower ?? explicitNoProxy);

  if (serverEnv && Object.keys(serverEnv).length > 0) {
    Object.assign(env, serverEnv);
  }

  if (explicitNoProxy !== undefined) {
    env.NO_PROXY = mergeNoProxyWithLocalhost(userNoProxy ?? explicitNoProxy);
    env.no_proxy = mergeNoProxyWithLocalhost(userNoProxyLower ?? explicitNoProxy);
  } else {
    env.NO_PROXY = MCP_LOCALHOST_NO_PROXY_VAL;
    env.no_proxy = MCP_LOCALHOST_NO_PROXY_VAL;
  }

  return env;
}
