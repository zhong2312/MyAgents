import { describe, expect, it } from 'vitest';

import { stripHeartbeatToken } from './heartbeat-response';

describe('stripHeartbeatToken', () => {
  it('keeps real heartbeat output and suppresses acknowledgements', () => {
    expect(stripHeartbeatToken('', 300)).toEqual({ status: 'silent', reason: 'empty' });
    expect(stripHeartbeatToken('**HEARTBEAT_OK**', 300)).toEqual({
      status: 'silent',
      reason: 'heartbeat_ok',
    });
    expect(stripHeartbeatToken('<em>HEARTBEAT_OK</em>', 300)).toEqual({
      status: 'silent',
      reason: 'heartbeat_ok',
    });
    expect(stripHeartbeatToken('需要处理一个异常', 300)).toEqual({
      status: 'content',
      text: '需要处理一个异常',
    });
    expect(stripHeartbeatToken(`HEARTBEAT_OK\n${'x'.repeat(301)}`, 300)).toEqual({
      status: 'content',
      text: 'x'.repeat(301),
    });
  });
});
