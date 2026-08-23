import { describe, expect, it } from 'vitest';

import {
  resolveMcpTemplateValue,
  resolveRemoteMcpTransportConfig,
} from './mcp-template-resolution';

describe('MCP template resolution', () => {
  it('resolves URL and header placeholders from the server-owned env', () => {
    expect(resolveRemoteMcpTransportConfig({
      id: 'tavily-search',
      url: 'https://mcp.tavily.com/mcp/',
      headers: { Authorization: 'Bearer {{TAVILY_API_KEY}}' },
      env: { TAVILY_API_KEY: 'test-key' },
    })).toEqual({
      url: 'https://mcp.tavily.com/mcp/',
      headers: { Authorization: 'Bearer test-key' },
    });
  });

  it('fails closed when a referenced value is absent', () => {
    expect(resolveMcpTemplateValue('Bearer {{MISSING_TOKEN}}', {})).toBeNull();
    expect(() => resolveRemoteMcpTransportConfig({
      id: 'missing-token',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer {{MISSING_TOKEN}}' },
      env: {},
    })).toThrow("header 'Authorization' references a missing env placeholder");
  });
});
