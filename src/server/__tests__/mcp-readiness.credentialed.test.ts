/**
 * Real SDK 0.3.x MCP soft pre-warm observation.
 *
 * Run explicitly with: npm run test:credentialed -- mcp-readiness
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { MCP_PREWARM_GRACE_MS, awaitMcpPrewarm } from '../session-core/mcp-prewarm-policy';
import { PROVIDERS } from './fixtures/test-env';
import { buildTestEnv, resolveClaudeCodeCli } from './setup';

const provider = PROVIDERS.anthropic;
const fixturePath = resolve('src/server/__tests__/fixtures/delayed-mcp-server.mjs');

describe('SDK MCP soft pre-warm', () => {
  it.skipIf(!provider.available).each([500, 4_900, 8_000])(
    'holds the first tool turn until a %dms delayed stdio MCP is connected',
    async (startupDelayMs) => {
      let releasePrompt!: () => void;
      const promptReady = new Promise<void>((resolvePrompt) => {
        releasePrompt = resolvePrompt;
      });
      async function* promptGenerator() {
        await promptReady;
        yield {
          type: 'user' as const,
          message: {
            role: 'user' as const,
            content: 'Call mcp__delayed_fixture__delayed_echo exactly once, then reply with its exact result.',
          },
          parent_tool_use_id: null,
          session_id: randomUUID(),
        };
      }

      const queryStartedAt = Date.now();
      const sdkQuery = query({
        prompt: promptGenerator(),
        options: {
          cwd: process.cwd(),
          env: buildTestEnv(provider.config),
          model: provider.config.model,
          maxTurns: 3,
          settingSources: ['user'],
          pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          allowedTools: ['mcp__delayed_fixture__delayed_echo'],
          mcpServers: {
            delayed_fixture: {
              type: 'stdio',
              command: process.execPath,
              args: [fixturePath],
              env: {
                ...Object.fromEntries(
                  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
                ),
                MYAGENTS_TEST_MCP_DELAY_MS: String(startupDelayMs),
              },
            },
          },
        },
      });
      const messages: SDKMessage[] = [];
      const consume = (async () => {
        for await (const message of sdkQuery) messages.push(message);
      })();

      try {
        const statusesSeen: string[] = [];
        const owner = {
            identity: sdkQuery,
            generation: 1,
            revision: 1,
            fingerprint: 'delayed_fixture',
            requiredServerIds: ['delayed_fixture'],
            startedAt: queryStartedAt,
            deadlineAt: queryStartedAt + MCP_PREWARM_GRACE_MS,
            readStatuses: async () => {
              const statuses = await sdkQuery.mcpServerStatus();
              statusesSeen.push(...statuses
                .filter(status => status.name === 'delayed_fixture')
                .map(status => status.status));
              return statuses;
            },
          };
        const readiness = await awaitMcpPrewarm({
          owner,
          getOwner: () => owner,
        });

        expect(readiness.state).toBe('ready');
        expect(statusesSeen.at(-1)).toBe('connected');
        // A short fixture may finish while the SDK itself is still starting,
        // so the first legal status observation can already be `connected`.
        // The stable contract is temporal: pre-warm must not report ready before
        // the delayed server could have completed startup.
        expect(Date.now() - queryStartedAt).toBeGreaterThanOrEqual(
          Math.max(0, startupDelayMs - 100),
        );

        releasePrompt();
        await consume;

        const assistantBlocks = messages
          .filter(message => message.type === 'assistant')
          .flatMap(message => message.message.content);
        expect(assistantBlocks).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_use',
            name: 'mcp__delayed_fixture__delayed_echo',
          }),
        ]));
        expect(JSON.stringify(messages)).toContain('MYAGENTS_DELAYED_MCP_READY');
      } finally {
        releasePrompt();
        sdkQuery.close();
        await consume.catch(() => undefined);
      }
    },
    120_000,
  );
});
