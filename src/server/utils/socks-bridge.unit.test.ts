import net from 'node:net';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const socksMocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
}));

vi.mock('socks', () => ({
  SocksClient: { createConnection: socksMocks.createConnection },
}));

import {
  getSocksBridgePort,
  startSocksBridge,
  stopSocksBridge,
} from './socks-bridge';

function openConnect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write('CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com\r\n\r\n');
    });
    socket.once('data', (chunk) => {
      expect(chunk.toString()).toContain('200 Connection Established');
      resolve(socket);
    });
  });
}

describe('SOCKS bridge lifecycle', () => {
  afterEach(async () => {
    await stopSocksBridge();
    vi.clearAllMocks();
  });

  it('keeps a stable listener and lets established tunnels drain across target changes', async () => {
    const socksSockets: PassThrough[] = [];
    socksMocks.createConnection.mockImplementation(async () => {
      const socket = new PassThrough();
      socksSockets.push(socket);
      return { socket };
    });

    const firstPort = await startSocksBridge('proxy-a.example', 1080);
    const firstClient = await openConnect(firstPort);
    expect(socksMocks.createConnection).toHaveBeenLastCalledWith(expect.objectContaining({
      proxy: expect.objectContaining({ host: 'proxy-a.example', port: 1080 }),
    }));

    const secondPort = await startSocksBridge('proxy-b.example', 2080);
    expect(secondPort).toBe(firstPort);
    const secondClient = await openConnect(secondPort);
    expect(socksMocks.createConnection).toHaveBeenLastCalledWith(expect.objectContaining({
      proxy: expect.objectContaining({ host: 'proxy-b.example', port: 2080 }),
    }));

    const firstDestroy = vi.spyOn(socksSockets[0], 'destroy');
    const secondDestroy = vi.spyOn(socksSockets[1], 'destroy');
    await stopSocksBridge();

    expect(getSocksBridgePort()).toBe(0);
    expect(firstDestroy).not.toHaveBeenCalled();
    expect(secondDestroy).not.toHaveBeenCalled();

    firstClient.destroy();
    secondClient.destroy();
    for (const socket of socksSockets) socket.destroy();
  });
});
