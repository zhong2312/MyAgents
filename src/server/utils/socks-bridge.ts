/**
 * HTTP-to-SOCKS5 Bridge
 *
 * Creates a local HTTP CONNECT proxy that tunnels traffic through a SOCKS5 proxy.
 * This bridges the gap between Bun/Node.js (which only understand HTTP proxies via
 * HTTP_PROXY/HTTPS_PROXY env vars) and SOCKS5 proxies.
 *
 * Flow:
 *   SDK subprocess → HTTP_PROXY=http://127.0.0.1:<bridge-port>
 *     → Bridge receives HTTP CONNECT request
 *     → Bridge creates SOCKS5 connection to target
 *     → Data flows bidirectionally through the tunnel
 *
 * Used by: agent-session.ts setProxyConfig() / initSocksBridge()
 */

import http from 'http';
import net from 'net';
import { SocksClient, type SocksProxy } from 'socks';

let bridgeServer: http.Server | null = null;
let bridgePort = 0;
let activeSocksProxy: SocksProxy | null = null;
/** The original SOCKS5 proxy URL (for display/logging) */
let originalSocksUrl = '';

/**
 * Start the HTTP-to-SOCKS5 bridge on a random local port.
 * If a bridge is already running, keeps the listener/port stable and routes
 * new CONNECT requests to the current SOCKS endpoint. This is important for a
 * general-only scope edit: provider subprocesses keep the same bridge URL and
 * therefore do not need an unrelated restart.
 *
 * @returns The local port the bridge is listening on
 */
export async function startSocksBridge(socksHost: string, socksPort: number): Promise<number> {
  originalSocksUrl = `socks5://${socksHost}:${socksPort}`;
  activeSocksProxy = {
    host: socksHost,
    port: socksPort,
    type: 5,
  };
  if (bridgeServer && bridgePort > 0) {
    console.log(`[socks-bridge] Reusing 127.0.0.1:${bridgePort} → ${originalSocksUrl}`);
    return bridgePort;
  }

  const server = http.createServer((_req, res) => {
    // Non-CONNECT requests are not supported — all real proxy traffic uses CONNECT
    // (HTTPS to Anthropic API, MCP servers, etc.). Returning 405 is correct.
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('SOCKS5 bridge only supports CONNECT tunneling (HTTPS)');
  });

  // Handle CONNECT method for HTTPS tunneling (the primary use case)
  server.on('connect', async (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    const [host, portStr] = (req.url ?? '').split(':');
    const port = parseInt(portStr) || 443;
    const proxy = activeSocksProxy;
    try {
      if (!proxy) throw new Error('SOCKS5 bridge is stopping');
      const { socket: socksSocket } = await SocksClient.createConnection({
        proxy,
        command: 'connect',
        destination: { host, port },
      });

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      if (head.length > 0) {
        socksSocket.write(head);
      }

      // Bidirectional pipe
      socksSocket.pipe(clientSocket);
      clientSocket.pipe(socksSocket);

      // Clean up on close/error
      clientSocket.on('end', () => socksSocket.end());
      socksSocket.on('end', () => clientSocket.end());
      clientSocket.on('error', () => socksSocket.destroy());
      socksSocket.on('error', () => clientSocket.destroy());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[socks-bridge] CONNECT to ${host}:${port} failed: ${msg}`);
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      } catch { /* socket already closed */ }
    }
  });

  // Don't let bridge errors crash the sidecar
  server.on('error', (err) => {
    console.error('[socks-bridge] Server error:', err.message);
  });
  bridgeServer = server;
  return new Promise<number>((resolve, reject) => {
    const onStartupError = (e: Error) => {
      if (bridgeServer === server) {
        bridgeServer = null;
        bridgePort = 0;
        activeSocksProxy = null;
        originalSocksUrl = '';
      }
      reject(new Error(`[socks-bridge] Failed to start: ${e.message}`));
    };
    server.once('error', onStartupError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onStartupError);
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        bridgePort = addr.port;
        console.log(`[socks-bridge] HTTP-to-SOCKS5 bridge started on 127.0.0.1:${bridgePort} → ${originalSocksUrl}`);
        resolve(bridgePort);
      } else {
        reject(new Error('[socks-bridge] Failed to get bridge address'));
      }
    });
  });
}

/**
 * Stop the SOCKS5 bridge if running.
 */
export async function stopSocksBridge(): Promise<void> {
  if (!bridgeServer) return;
  const retiringServer = bridgeServer;
  const retiringPort = bridgePort;
  bridgeServer = null;
  bridgePort = 0;
  activeSocksProxy = null;
  originalSocksUrl = '';
  try {
    retiringServer.close(() => {
      console.log(`[socks-bridge] Bridge stopped accepting connections (was on port ${retiringPort})`);
    });
    retiringServer.closeIdleConnections?.();
  } catch {
    // Already stopped or failed before listen completed.
  }
}

/**
 * Get the current bridge port (0 if not running).
 */
export function getSocksBridgePort(): number {
  return bridgePort;
}

/**
 * Check if the SOCKS5 bridge is running.
 */
export function isSocksBridgeRunning(): boolean {
  return bridgeServer !== null && bridgePort > 0;
}

/**
 * Get the HTTP proxy URL that points to the bridge.
 * Returns null if bridge is not running.
 */
export function getSocksBridgeHttpUrl(): string | null {
  if (!isSocksBridgeRunning()) return null;
  return `http://127.0.0.1:${bridgePort}`;
}
