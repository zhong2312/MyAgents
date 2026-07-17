import { refreshToken } from '../../mcp-oauth/token-manager';

const serverId = process.argv[2];
if (!serverId) throw new Error('missing server id');

try {
  const outcome = await refreshToken(serverId, 'proactive');
  process.stdout.write(`RESULT:${JSON.stringify({ kind: outcome.kind })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
