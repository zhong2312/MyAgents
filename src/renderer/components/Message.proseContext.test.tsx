/**
 * 回归不变量：聊天 assistant 正文容器 MUST 携带 `ai-message-content`。
 *
 * 背景（PRD 0.2.34 Part 2）：该 CSS 类曾长期是死代码，导致规范和实际渲染
 * 分叉。本测试继续固定 host prose 接线；具体字号、行高、列表与 compact 节奏
 * 现由内层 `.markdown-content` 单一拥有并由 Markdown.typography.test 覆盖。
 *
 * 本测试把接线本身固化为不变量：下次重构 Message.tsx 时该类再静默脱落，
 * 这里会先红。覆盖 string 与 ContentBlock[] 两个 assistant 分支（第三个
 * widget-segment 分支共享同一容器 class 字符串，但 mount WidgetRenderer
 * 需要 iframe/postMessage 桩，不值得为同一断言引入；见 Message.tsx
 * renderWidgetSegments 的文本段容器）。
 */
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/context/ImagePreviewContext', () => ({
    useImagePreview: () => ({ openPreview: vi.fn() }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
    useWorkspaceFileService: () => ({
        isAvailable: false,
        checkPaths: vi.fn(),
        checkLocalPaths: vi.fn(),
        openWithDefault: vi.fn(),
        openPathWithDefault: vi.fn(),
        openPathExternal: vi.fn(),
        openInFinder: vi.fn(),
        readPreview: vi.fn(),
        readLocalPreview: vi.fn(),
        readFileAsBlobUrl: vi.fn(),
        readLocalFileAsBlobUrl: vi.fn(),
    }),
}));

vi.mock('@/analytics', () => ({ track: vi.fn() }));

import Message from '@/components/Message';
import { renderWithTheme } from '@/test/renderWithTheme';
import type { Message as MessageType } from '@/types/chat';
import {
    SPACE_ISSUE_CONTEXT_TAG,
    buildGoalContextReminder,
    buildGoalContinuationReminder,
} from '../../shared/systemReminder';

function assistantMessage(content: MessageType['content']): MessageType {
    return {
        id: 'm-prose-test',
        role: 'assistant',
        content,
        timestamp: new Date('2026-06-12T00:00:00Z'),
    };
}

function userMessage(content: string): MessageType {
    return {
        id: 'm-space-issue-test',
        role: 'user',
        content,
        timestamp: new Date('2026-07-06T00:00:00Z'),
    };
}

describe('assistant 正文 prose 上下文接线（ai-message-content）', () => {
    it('string 分支容器携带 ai-message-content', () => {
        const { container } = render(
            <Message message={assistantMessage('你好，这是一段 AI 回复。')} />
        );
        const prose = container.querySelector('.ai-message-content');
        expect(prose).not.toBeNull();
        expect(prose!.textContent).toContain('这是一段 AI 回复');
    });

    it('ContentBlock[] 分支的文本块容器携带 ai-message-content', () => {
        const { container } = render(
            <Message
                message={assistantMessage([
                    { type: 'text', text: '块模式下的 AI 回复文本。' },
                ] as MessageType['content'])}
            />
        );
        const prose = container.querySelector('.ai-message-content');
        expect(prose).not.toBeNull();
        expect(prose!.textContent).toContain('块模式下的 AI 回复文本');
    });
});

describe('chat Markdown fenced code horizontal scroll ownership', () => {
    const longCode = [
        '```text',
        'a long unwrapped code line that must stay inside its own horizontal scroll surface',
        '```',
    ].join('\n');

    it('keeps user/query code blocks horizontally scrollable', () => {
        const { container } = renderWithTheme(<Message message={userMessage(longCode)} />);

        expect(container.querySelector('.user-message-content pre')).toHaveClass('overflow-x-auto');
    });

    it('keeps assistant code blocks horizontally scrollable', () => {
        const { container } = renderWithTheme(<Message message={assistantMessage(longCode)} />);

        expect(container.querySelector('.ai-message-content pre')).toHaveClass('overflow-x-auto');
    });
});

describe('Space issue system-reminder user bubble', () => {
    it('hides the operational payload and renders the Space issue badge with visible text', () => {
        const visibleText = 'MyAgents Space 已投递一个 Issue 通知，Registered Agent 开始处理。';
        const content = [
            '<system-reminder>',
            `<${SPACE_ISSUE_CONTEXT_TAG}>`,
            '<myagents-space-event version="1" type="issue-delivery">',
            '<issue-instruction>hidden issue instructions</issue-instruction>',
            '<issue id="issue_1">hidden issue facts</issue>',
            '</myagents-space-event>',
            `</${SPACE_ISSUE_CONTEXT_TAG}>`,
            '</system-reminder>',
            visibleText,
        ].join('\n');

        const { container } = render(<Message message={userMessage(content)} />);

        expect(container).toHaveTextContent('Space issue');
        expect(container).toHaveTextContent(visibleText);
        expect(container).not.toHaveTextContent('hidden issue instructions');
        expect(container).not.toHaveTextContent('hidden issue facts');
    });

    it('does not render a bubble when visible text is missing', () => {
        const content = [
            '<system-reminder>',
            `<${SPACE_ISSUE_CONTEXT_TAG}>`,
            '<myagents-space-event version="1" type="issue-delivery">',
            '<issue-instruction>hidden issue instructions</issue-instruction>',
            '<issue id="issue_1">hidden issue facts</issue>',
            '</myagents-space-event>',
            `</${SPACE_ISSUE_CONTEXT_TAG}>`,
            '</system-reminder>',
        ].join('\n');

        const { container } = render(<Message message={userMessage(content)} />);

        expect(container.querySelector('[data-role="user"]')).toBeNull();
        expect(container).not.toHaveTextContent('hidden issue instructions');
        expect(container).not.toHaveTextContent('hidden issue facts');
    });
});

describe('Heartbeat system-reminder user bubble', () => {
    it('hides cron relay payload and renders only the visible system notice', () => {
        const content = [
            '<system-reminder>',
            '<HEARTBEAT>',
            '<instruction>hidden relay instruction</instruction>',
            '<task-meta>hidden task metadata</task-meta>',
            '<task-result>hidden task result</task-result>',
            '</HEARTBEAT>',
            '</system-reminder>',
            '[System]收到来自系统投送的信息',
        ].join('\n');

        const { container } = render(<Message message={userMessage(content)} />);

        expect(container).toHaveTextContent('[System]收到来自系统投送的信息');
        expect(container).toHaveTextContent(/Heartbeat|心跳感知/);
        expect(container).not.toHaveTextContent('hidden relay instruction');
        expect(container).not.toHaveTextContent('hidden task metadata');
        expect(container).not.toHaveTextContent('hidden task result');
    });
});

describe('Goal system-reminder user bubble', () => {
    it('renders the first Goal query with the Goal Mode badge', () => {
        const objective = '分析这个项目有什么价值';
        const content = buildGoalContextReminder({
            objective,
            goalId: 'goal_first',
            goalStatus: 'active',
            turnNumber: 1,
            visibleUserMessage: objective,
        });

        const { container } = render(<Message message={userMessage(content)} />);

        expect(container.querySelector('[data-role="user"]')).not.toBeNull();
        expect(container).toHaveTextContent(/Goal Mode|目标模式/);
        expect(container).toHaveTextContent(objective);
        expect(container).not.toHaveTextContent('Continue working toward the active MyAgents Goal');
    });

    it('does not render pure hidden Goal reminders as user bubbles', () => {
        const content = buildGoalContinuationReminder({
            objective: 'hidden updated objective',
            goalId: 'goal_123',
            goalStatus: 'active',
            turnNumber: 2,
        });

        const { container } = render(<Message message={userMessage(content)} />);

        expect(container.querySelector('[data-role="user"]')).toBeNull();
        expect(container).not.toHaveTextContent('hidden updated objective');
    });

    it('renders Goal context visible tail with the Goal Mode badge only', () => {
        const content = buildGoalContextReminder({
            objective: 'hidden objective',
            goalId: 'goal_123',
            goalStatus: 'paused',
            turnNumber: 3,
            visibleUserMessage: 'Please run tests before continuing',
        });

        const { container } = render(<Message message={userMessage(content)} />);

        expect(container).toHaveTextContent(/Goal Mode|目标模式/);
        expect(container).toHaveTextContent('Please run tests before continuing');
        expect(container).not.toHaveTextContent('hidden objective');
        expect(container).not.toHaveTextContent('Continue the active Goal');
    });
});

describe('Cross-session request system-reminder user bubble', () => {
    it('renders the request payload without leaking protocol metadata', () => {
        const content = [
            '<system-reminder>',
            '<myagents-session-event',
            '  version="1"',
            '  type="send.request"',
            '  event_id="evt-visible-request"',
            '  source_session_id="session-source"',
            '  source_label="Planning &amp; Review"',
            '  target_session_id="session-target"',
            '  source_notification="auto">',
            '<event-summary>',
            'hidden delivery instructions',
            '</event-summary>',
            '<payload>',
            'Please review the release checklist.',
            '</payload>',
            '</myagents-session-event>',
            '</system-reminder>',
        ].join('\n');

        const { container } = render(<Message message={userMessage(content)} />);

        expect(container.querySelector('[data-role="user"]')).not.toBeNull();
        expect(container).toHaveTextContent('Please review the release checklist.');
        expect(container).toHaveTextContent('Planning & Review');
        expect(container).not.toHaveTextContent('hidden delivery instructions');
        expect(container).not.toHaveTextContent('source_session_id');
    });
});
