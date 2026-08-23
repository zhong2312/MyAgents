import { describe, expect, it } from 'vitest';
import { createLogRedactor } from '../../../bundled-agents/myagents_helper/.claude/skills/support/scripts/redact-log-core.mjs';

function runRedactor(input: string): string {
  const redact = createLogRedactor();
  return input.split(/\r?\n/).map(redact).join('\n');
}

describe('support log redactor', () => {
  it('removes common credentials, authorization headers, URLs, homes and multiline secrets', () => {
    const secrets = {
      accessKey: 'AKIAEXAMPLE123456789',
      secretKey: 'exampleSecretAccessKey1234567890abcdef',
      camelAccessKey: 'AKIACAMELCASE1234567',
      camelSecretKey: 'camelSecretAccessKey1234567890abcdef',
      apiKey: 'short-api-secret-12345',
      digest: '0123456789abcdef0123456789abcdef',
      urlCode: 'oauth-code-secret-98765',
      splitToken: 'short-split-secret-456',
      encoded: `${'A'.repeat(78)}==`,
      pemTail: 'QUJDREVGR0hJSktMTQ==',
      databaseUrl: 'postgres://demo:database-secret@example.com/myagents',
      mongoUri: 'mongodb://demo:mongo-secret@example.com/myagents',
    };
    const input = [
      `AWS_ACCESS_KEY_ID=${secrets.accessKey}`,
      `AWS_SECRET_ACCESS_KEY=${secrets.secretKey}`,
      `awsAccessKeyId=${secrets.camelAccessKey}`,
      `awsSecretAccessKey=${secrets.camelSecretKey}`,
      `Authorization: ApiKey ${secrets.apiKey}`,
      `Proxy-Authorization: Digest username="demo", response="${secrets.digest}"`,
      String.raw`redirect=https:\/\/example.com\/oauth?code=${secrets.urlCode}`,
      `encoded=${secrets.encoded}`,
      `DATABASE_URL=${secrets.databaseUrl}`,
      `mongodbUri=${secrets.mongoUri}`,
      'access token:',
      secrets.splitToken,
      '-----BEGIN PRIVATE KEY-----',
      'Q'.repeat(64),
      secrets.pemTail,
      '-----END PRIVATE KEY-----',
      'after=visible',
      '/Users/alice/project/log.txt',
      String.raw`C:\Users\Alice\project\log.txt`,
    ].join('\n');

    const output = runRedactor(input);

    for (const secret of Object.values(secrets)) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('<redacted');
    expect(output).toContain('<HOME>/project/log.txt');
    expect(output).toContain('after=visible');
  });

  it('preserves useful diagnostics and does not treat ordinary prose as a split secret label', () => {
    const output = runRedactor(
      [
        'status=403 runtimeSource=managed-provider terminal_reason=provider_error',
        'sessionId=019f0000-1111-7222-8333-444455556666',
        'request failed with invalid token',
        'next diagnostic line remains visible',
      ].join('\n'),
    );

    expect(output).toContain(
      'status=403 runtimeSource=managed-provider terminal_reason=provider_error',
    );
    expect(output).toContain('sessionId=019f0000-1111-7222-8333-444455556666');
    expect(output).toContain('request failed with invalid token');
    expect(output).toContain('next diagnostic line remains visible');
  });
});
