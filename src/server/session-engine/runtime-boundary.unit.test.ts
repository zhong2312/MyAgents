import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = process.cwd();

function listSourceFiles(relativeDir: string): string[] {
  const root = join(repoRoot, relativeDir);
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(relative(repoRoot, fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

function sourceWithoutCommentLines(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('console.');
    })
    .join('\n');
}

describe('SessionEngine runtime boundary', () => {
  it('keeps Phase5 migrated route modules behind SessionEngine instead of direct builtin/external adapters', () => {
    const routeFiles = listSourceFiles('src/server/routes');
    const forbidden = [
      '../agent-session',
      'enqueueUserMessage(',
      'sendExternalMessage(',
      'waitForSessionIdle(',
      'waitForExternalSessionIdle(',
      'shouldUseExternalRuntime(',
      'didLastTurnSucceed(',
      'getAndClearLastAgentError(',
    ];
    const violations = routeFiles.flatMap((file) => {
      const relativePath = relative(repoRoot, file);
      const source = readFileSync(file, 'utf8');
      const baseViolations = forbidden
        .filter(pattern => source.includes(pattern))
        .map(pattern => `${relativePath} contains ${pattern}`);
      const externalRuntimeViolations = source.includes('../runtimes/external-session')
        ? [`${relativePath} imports external-session internals`]
        : [];
      return [...baseViolations, ...externalRuntimeViolations];
    });

    expect(violations).toEqual([]);
  });

  it('does not reintroduce route-level runtime selection in the monolithic server entrypoint', () => {
    const source = readFileSync(join(repoRoot, 'src/server/index.ts'), 'utf8');

    expect(source).not.toContain('shouldUseExternalRuntime(');
    expect(source).not.toContain('sendExternalMessage(');
    expect(source).not.toContain('enqueueUserMessage(');
    expect(source).not.toContain('waitForExternalSessionIdle(');
    expect(source).not.toContain('waitForSessionIdle(');
    expect(source).not.toContain('didLastTurnSucceed(');
    expect(source).not.toContain('getAndClearLastAgentError(');
  });

  it('keeps Phase6 builtin owner modules behind the agent-session facade', () => {
    const routeFiles = listSourceFiles('src/server/routes');
    const adapterFiles = listSourceFiles('src/server/session-engine');

    const violations = [...routeFiles, ...adapterFiles].flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes('../builtin-session/')
        || source.includes('./builtin-session/')
        || source.includes('src/server/builtin-session/')
        ? [`${relative(repoRoot, file)} imports builtin-session internals`]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps external product binding independent from builtin lifecycle operations', () => {
    const source = readFileSync(join(repoRoot, 'src/server/session-engine/external-adapter.ts'), 'utf8');
    const builtinImport = source.match(/import\s*{([\s\S]*?)}\s*from '\.\.\/agent-session';/)?.[1] ?? '';

    expect(builtinImport).not.toMatch(/\b(?:resetSession|getSessionId|materializePendingDesktopSession|materializeCurrentSessionMetadataForPublishedReset|freezeCurrentSessionMetadataForImDetach)\b/);
    expect(source).toContain("from './product-session-binding'");
  });

  it('keeps builtin owner modules independent from routes and SessionEngine', () => {
    const ownerFiles = listSourceFiles('src/server/builtin-session');

    const violations = ownerFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [
        '../agent-session',
        '../session-engine',
        './session-engine',
        '../routes',
        './routes',
      ]
        .filter(pattern => source.includes(pattern))
        .map(pattern => `${relative(repoRoot, file)} contains ${pattern}`);
    });

    expect(violations).toEqual([]);
  });

  it('keeps Phase8 external owner modules behind the external-session facade', () => {
    const routeFiles = listSourceFiles('src/server/routes');
    const adapterFiles = listSourceFiles('src/server/session-engine');

    const violations = [...routeFiles, ...adapterFiles].flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [
        '../runtimes/external-session/',
        './external-session/',
        'src/server/runtimes/external-session/',
      ]
        .filter(pattern => source.includes(pattern))
        .map(pattern => `${relative(repoRoot, file)} imports external-session owner internals via ${pattern}`);
    });

    expect(violations).toEqual([]);
  });

  it('keeps external owner modules independent from routes and SessionEngine', () => {
    const ownerFiles = listSourceFiles('src/server/runtimes/external-session');

    const violations = ownerFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [
        '../../routes',
        '../routes',
        './routes',
        '../../session-engine',
        '../session-engine',
        './session-engine',
        '../../index',
        '../index',
      ]
        .filter(pattern => source.includes(pattern))
        .map(pattern => `${relative(repoRoot, file)} contains ${pattern}`);
    });

    expect(violations).toEqual([]);
  });

  it('keeps Phase8 external owner state out of the external-session facade', () => {
    const source = sourceWithoutCommentLines(join(repoRoot, 'src/server/runtimes/external-session.ts'));
    const forbidden = [
      /\blet activeProcess\b/,
      /\blet activeRuntime\b/,
      /\blet isRunning\b/,
      /\blet startingPromise\b/,
      /\blet startingSessionId\b/,
      /\blet externalOperationQueue\b/,
      /\blet turnCompleted\b/,
      /\bconst turnFinalization\b/,
      /\blet currentTurnUsage\b/,
      /\blet currentTurnContextUsage\b/,
      /\blet currentContentBlocks\b/,
      /\blet currentAssistantText\b/,
      /\blet allSessionMessages\b/,
      /\bconst pendingExternalInteractiveRequests\b/,
      /\bconst pendingExternalAskUserQuestions\b/,
      /\bconst pendingPermissionSuggestions\b/,
      /\blet activeRequestId\b/,
      /\blet currentTurnInboxMeta\b/,
      /\bgetExternalContentBlocksRef\b/,
      /\bgetExternalPendingToolInputs\b/,
      /\bgetExternalChildToolToParent\b/,
      /\bgetExternalSubagentTraceBuffers\b/,
      /\bgetExternalSubagentAttachmentParents\b/,
      /\bgetExternalSessionMessagesRef\b/,
      /\bpushExternalContentBlock\b/,
      /\bresolveLastRealUserMessagePreview\b/,
      /\bresolveLastVisibleTurnPreview\b/,
      /\bsaveSessionMessages\(/,
      /\bdecideSessionCompleteErrorAction\b/,
      /\bexternalTurnFailureMessage\b/,
      /\bimRequestRegistry\b/,
      /\bimEventBus\b/,
      /\bfunction\s+deliverExternalWatchError\b/,
      /\bfunction\s+clearInboxMetaOnRejection\b/,
      /\bfunction\s+fireImCallback\b/,
    ];

    const violations = forbidden
      .filter(pattern => pattern.test(source))
      .map(pattern => String(pattern));

    expect(violations).toEqual([]);
    expect(source).toContain('appendAndPersistExternalAssistantTurn');
    expect(source).toContain('persistExternalUserMessageAppend');
    expect(source).toContain('truncateExternalTranscriptForRetry');
    expect(source).toContain('markExternalTurnComplete');
    expect(source).toContain('markExternalSessionComplete');
    expect(source).toContain('fireExternalImCallback');
    expect(source).toContain('finalizeExternalActiveRequest');
  });

  it('keeps builtin owner writes behind owner APIs instead of mutable state bags', () => {
    const source = sourceWithoutCommentLines(join(repoRoot, 'src/server/agent-session.ts'));
    const forbidden = [
      /lifecycleState\.(?:messageResolver|query|processing|preWarming|preWarmFailCount|preWarmTimer|systemInitInfo|sdkControlReady|termination)\s*(?<!=)=(?!=)/,
      /queueState\.(?:messageQueue|pendingMidTurnQueue|turnBoundaryQueue|turnAdmissionTicket|inFlightToCliId|inFlightMetadata|forceSurfaceInFlightId|forceTurnBoundaryQueueId|promotedItemInFlight|awaitingAssistantStartAckQueueId|committingTurnAdmissionQueueId|interruptingInFlightQueueId)\s*(?<!=)=(?!=)/,
      /queueState\.(?:messageQueue|pendingMidTurnQueue|turnBoundaryQueue)\.(?:push|unshift|shift|splice)\(/,
      /queueState\.(?:messageQueue|pendingMidTurnQueue|turnBoundaryQueue)\.map\(/,
      /turnState\.(?:injectedTurnOutcomes|discardedInjectedTurnIds)\.(?:set|delete|clear|add)\(/,
      /turnState\.(?:currentTurnInjectedTurnId|currentTurnImTerminalEmitted|currentPlanFileMinMtimeMs|currentTurnStartTime|currentTurnToolCount|sessionBrowserToolUsed|sessionStorageStateSaved|turnHadSubstantiveActivity|currentTurnCompactResult|currentTurnSawCompactBoundary|currentTurnHadAssistantMessageError|currentTurnLastAssistantMessageError|currentTurnHasOutput|latestMainAssistantUsage|currentTurnAnalyticsSource|currentTurnProviderAnalytics|currentTurnAssistantMessagePresent)\s*(?:(?<!=)=(?!=)|\+\+|--)/,
      /turnState\.currentTurnUsage\.[A-Za-z0-9_]+\s*(?<!=)=(?!=)/,
      /turnState\.pendingOutputOwners\.(?:push|shift|splice)\(/,
      /turnState\.pendingOutputOwners\.length\s*(?<!=)=(?!=)/,
      /turnState\.currentTurnTextBlocks\.(?:push|splice)\(/,
      /turnState\.currentTurnTextBlocks\.length\s*(?<!=)=(?!=)/,
      /turnState\.currentTurnInboxMeta\s*(?<!=)=(?!=)/,
      /configState\.(?:currentMcpServers|currentEnabledPluginIds|currentAgentDefinitions|currentPermissionMode|prePlanPermissionMode|currentBackgroundAgentPermissionMode|currentModel|currentReasoningEffort|currentProviderEnv|pendingProviderHistoryBoundaryReset|frozenSdkMcpFingerprint)\s*(?<!=)=(?!=)/,
      /transcriptState\.(?:messages|messageSequence|transcriptCursor|persistChainBySession|currentSessionUuids|liveSessionUuids|pendingReloadAnchor)\s*(?:(?<!=)=(?!=)|\+\+|--)/,
      /transcriptState\.messages\[[^\n]+\]\.sdkUuid\s*(?<!=)=(?!=)/,
      /\bcurrentAssistant\.sdkUuid\s*(?<!=)=(?!=)/,
      /transcriptState\.messages\.length\s*(?<!=)=(?!=)/,
      /transcriptState\.(?:messages|persistChainBySession|currentSessionUuids|liveSessionUuids)\.(?:push|splice|add|delete|clear)\(/,
    ];
    const violations = forbidden
      .filter(pattern => pattern.test(source))
      .map(pattern => String(pattern));

    expect(violations).toEqual([]);
  });

  it('keeps Phase7 turn terminal and transcript persistence behavior out of the facade', () => {
    const facade = sourceWithoutCommentLines(join(repoRoot, 'src/server/agent-session.ts'));
    const turnLifecycle = sourceWithoutCommentLines(join(repoRoot, 'src/server/builtin-session/turn-lifecycle.ts'));
    const transcriptPersistence = sourceWithoutCommentLines(join(repoRoot, 'src/server/builtin-session/transcript-persistence.ts'));
    const forbiddenFacadePatterns = [
      /\bextractTurnUsageFromSdkResult\b/,
      /\bisEmptySuccessfulSdkResult\b/,
      /\bisSuccessfulCompactControlTurn\b/,
      /\bisRecoveredAssistantMessageError\b/,
      /\bfindTurnUsageStampIndex\b/,
      /\bresolveLastRealUserMessagePreview\b/,
      /\bresolveLastVisibleTurnPreview\b/,
      /\bseedBridgeThoughtSignatures\b/,
      /\blastTurnEndPersist\b/,
      /\bsaveSessionMessages\b/,
      /\b(?:function|const|let|var)\s+(?:schedulePersist|doPersistMessagesToStorage|loadMessagesFromStorage)\b/,
    ];

    expect(facade).toContain('builtinTurnLifecycle.handleSdkResult');
    expect(forbiddenFacadePatterns.filter(pattern => pattern.test(facade)).map(String)).toEqual([]);
    expect(facade).toContain('saveForkTranscript');

    expect(turnLifecycle).toContain('extractTurnUsageFromSdkResult');
    expect(turnLifecycle).toContain('isEmptySuccessfulSdkResult');
    expect(turnLifecycle).toContain('lastTurnEndPersist');
    expect(turnLifecycle).toContain('stampTurnUsageOnPendingAssistant');
    expect(transcriptPersistence).toContain('appendSessionMessages');
    expect(transcriptPersistence).toContain('mutateSessionTranscript');
    expect(transcriptPersistence).toContain('saveForkTranscript');
    expect(transcriptPersistence).toContain('scheduleTranscriptPersist');
    expect(transcriptPersistence).toContain('loadTranscriptFromSessionMessages');
  });

  it('separates ordinary transcript append from explicit destructive mutation', () => {
    const store = sourceWithoutCommentLines(join(repoRoot, 'src/server/SessionStore.ts'));
    expect(store).not.toMatch(/\b(?:saveSessionMessages|appendSessionMessage)\b/);
    expect(store).not.toMatch(/\b(?:allowShrink|forceRewrite)\b/);
    expect(store).toContain('TranscriptWriteCursor');
    expect(store).toContain('appendSessionMessages');
    expect(store).toContain('mutateSessionTranscript');
    expect(store).toContain("kind: 'builtin-rewind'");
    expect(store).toContain("kind: 'external-retry'");
  });

  it('keeps session-core pure and side-effect free', () => {
    const coreFiles = listSourceFiles('src/server/session-core');
    const forbidden = [
      '../agent-session',
      '../builtin-session',
      '../sse',
      '../SessionStore',
      'broadcast(',
      '@anthropic-ai/claude-agent-sdk',
      'readFileSync',
      'writeFileSync',
      'appendFileSync',
    ];

    const violations = coreFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbidden
        .filter(pattern => source.includes(pattern))
        .map(pattern => `${relative(repoRoot, file)} contains ${pattern}`);
    });

    expect(violations).toEqual([]);
  });
});
