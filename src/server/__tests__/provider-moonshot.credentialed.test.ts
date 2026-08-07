/**
 * Moonshot Provider Tests
 *
 * Tests specific to Moonshot API mode.
 * Requires valid API key in ~/.myagents/config.json.
 *
 * Run: npm run test:credentialed
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  PROVIDERS,
  TEST_TIMEOUT,
  TIMEOUT_BUFFER,
  SIMPLE_PROMPT,
} from './fixtures/test-env';
import {
  runTestQuery,
  assertQuerySuccess,
  assertResponseContains,
} from './setup';

describe('Moonshot Provider Tests', () => {
  const provider = PROVIDERS.moonshot;
  const isAvailable = provider.available;

  beforeAll(() => {
    console.log(`[moonshot] Provider available: ${isAvailable}`);
    console.log(`[moonshot] Model: ${provider.config.model}`);
    console.log(`[moonshot] Base URL: ${provider.config.baseUrl}`);
    if (!isAvailable) {
      console.warn('[moonshot] API key not found in ~/.myagents/config.json');
    }
  });

  describe('API Key Mode', () => {
    it.skipIf(!isAvailable)('should authenticate via API key', async () => {
      const result = await runTestQuery({
        provider: provider.config,
        prompt: SIMPLE_PROMPT,
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      expect(result.sessionId).toBeTruthy();
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);

    it.skipIf(!isAvailable)('should use kimi-k3 model', async () => {
      expect(provider.config.model).toBe('kimi-k3');

      const result = await runTestQuery({
        provider: provider.config,
        prompt: 'Reply with exactly "OK" and nothing else.',
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      expect(result.assistantResponse).toBeTruthy();
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });

  describe('Anthropic Compatibility', () => {
    it.skipIf(!isAvailable)('should work with Anthropic-compatible API', async () => {
      // Verify base URL is Anthropic-compatible endpoint
      expect(provider.config.baseUrl).toContain('/anthropic');

      const result = await runTestQuery({
        provider: provider.config,
        prompt: 'What is 1 + 1? Reply with just the number.',
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      assertResponseContains(result, '2');
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });

  describe('Response Quality', () => {
    it.skipIf(!isAvailable)('should follow instructions', async () => {
      const result = await runTestQuery({
        provider: provider.config,
        prompt: 'Reply with exactly the word "HELLO" in uppercase, nothing else.',
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      assertResponseContains(result, 'HELLO');
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);

    it.skipIf(!isAvailable)('should handle Chinese prompts', async () => {
      const result = await runTestQuery({
        provider: provider.config,
        prompt: '用中文回复"你好"两个字，不要其他内容。',
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      assertResponseContains(result, '你好');
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });

  describe('Error Handling', () => {
    it.skipIf(!isAvailable)('should handle invalid API key error gracefully', async () => {
      // Still a real upstream network smoke: only run when credentialed tests
      // have a configured Moonshot provider, never in no-secret environments.
      const result = await runTestQuery({
        provider: {
          ...provider.config,
          apiKey: 'invalid-api-key-12345',
        },
        prompt: SIMPLE_PROMPT,
        timeoutMs: TEST_TIMEOUT,
      });

      // The contract under test is "the SDK surfaces an error rather than
      // silently swallowing a bad key" — assert that strictly. Pre-fix we
      // also asserted the error text matched specific keywords
      // (auth/401/invalid/unauthorized), which made the test flaky against
      // upstream wording shifts (Moonshot has at various times returned
      // "API key is incorrect", "authentication_error", etc.). Keep the
      // keyword check as an informational soft-warn so future drift
      // surfaces in CI logs without failing the build.
      expect(result.hasError).toBe(true);
      expect(result.errorMessage).toBeDefined();
      expect(typeof result.errorMessage).toBe('string');
      expect((result.errorMessage ?? '').length).toBeGreaterThan(0);

      const looksAuthShaped =
        result.errorMessage?.toLowerCase().includes('auth') ||
        result.errorMessage?.toLowerCase().includes('401') ||
        result.errorMessage?.toLowerCase().includes('invalid') ||
        result.errorMessage?.toLowerCase().includes('unauthorized') ||
        result.errorMessage?.toLowerCase().includes('api key') ||
        result.errorMessage?.toLowerCase().includes('credential');
      if (!looksAuthShaped) {
        console.warn(
          `[moonshot] invalid-key error message no longer matches known auth keywords; ` +
            `upstream may have changed wording. Got: ${result.errorMessage}`,
        );
      }
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });
});
