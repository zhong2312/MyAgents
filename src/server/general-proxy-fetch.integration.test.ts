import http from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  _getInheritedProxySnapshotForTests,
  _resetProxyStateForTests,
  getCurrentProxySettings,
} from './proxy-state';
import { fetchWithGeneralProxy } from './utils/cancellation';

interface TestServer {
  server: http.Server;
  port: number;
  connectTargets: string[];
  requestCount: number;
}

async function createTunnelProxy(label: string): Promise<TestServer> {
  const connectTargets: string[] = [];
  const server = http.createServer();
  server.on('connect', (request, socket) => {
    connectTargets.push(request.url ?? '');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => {
      const body = label;
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('proxy did not bind');
  return { server, port: address.port, connectTargets, requestCount: 0 };
}

async function createOrigin(label: string): Promise<TestServer> {
  const result: TestServer = {
    server: http.createServer((_request, response) => {
      result.requestCount += 1;
      response.end(label);
    }),
    port: 0,
    connectTargets: [],
    requestCount: 0,
  };
  const server = result.server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('origin did not bind');
  result.port = address.port;
  return result;
}

async function closeTestServer(testServer: TestServer): Promise<void> {
  testServer.server.closeAllConnections?.();
  await new Promise<void>((resolve) => testServer.server.close(() => resolve()));
}

describe('general request dispatcher', () => {
  const originalSettings = getCurrentProxySettings();
  const originalInherited = _getInheritedProxySnapshotForTests();
  let inheritedProxy: TestServer;
  let appProxy: TestServer;
  let httpsProxy: TestServer;
  let origin: TestServer;

  beforeAll(async () => {
    [inheritedProxy, appProxy, httpsProxy, origin] = await Promise.all([
      createTunnelProxy('inherited'),
      createTunnelProxy('myagents'),
      createTunnelProxy('https-proxy'),
      createOrigin('direct-origin'),
    ]);
  });

  afterAll(async () => {
    _resetProxyStateForTests(originalSettings, originalInherited);
    await Promise.all([
      closeTestServer(inheritedProxy),
      closeTestServer(appProxy),
      closeTestServer(httpsProxy),
      closeTestServer(origin),
    ]);
  });

  it('always bypasses both inherited and MyAgents proxies for localhost', async () => {
    const inheritedUrl = `http://127.0.0.1:${inheritedProxy.port}`;
    _resetProxyStateForTests({
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: appProxy.port,
      scope: { mode: 'custom', generalRequests: false, providerIds: ['provider-a'] },
    }, { HTTP_PROXY: inheritedUrl, HTTPS_PROXY: inheritedUrl });

    const inheritedResponse = await fetchWithGeneralProxy(`http://127.0.0.1:${origin.port}/check`);
    expect(await inheritedResponse.text()).toBe('direct-origin');

    _resetProxyStateForTests({
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: appProxy.port,
      scope: { mode: 'custom', generalRequests: true, providerIds: [] },
    }, { HTTP_PROXY: inheritedUrl, HTTPS_PROXY: inheritedUrl });

    const appResponse = await fetchWithGeneralProxy(`http://127.0.0.1:${origin.port}/check`);
    expect(await appResponse.text()).toBe('direct-origin');
    expect(inheritedProxy.connectTargets).toHaveLength(0);
    expect(appProxy.connectTargets).toHaveLength(0);
    expect(origin.requestCount).toBe(2);
  });

  it('honors explicit loopback NO_PROXY entries', async () => {
    _resetProxyStateForTests(null, {
      HTTP_PROXY: `http://127.0.0.1:${inheritedProxy.port}`,
      HTTPS_PROXY: `http://127.0.0.1:${httpsProxy.port}`,
    });

    const inheritedConnectCount = inheritedProxy.connectTargets.length;
    _resetProxyStateForTests(null, {
      HTTP_PROXY: `http://127.0.0.1:${inheritedProxy.port}`,
      NO_PROXY: '127.0.0.1',
    });
    const directResponse = await fetchWithGeneralProxy(`http://127.0.0.1:${origin.port}/check`);
    expect(await directResponse.text()).toBe('direct-origin');
    expect(inheritedProxy.connectTargets).toHaveLength(inheritedConnectCount);
  });
});
