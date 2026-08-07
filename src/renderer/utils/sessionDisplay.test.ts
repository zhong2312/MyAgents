import { describe, expect, it } from 'vitest';

import { getFullSessionDisplayText, getSessionDisplayText } from './sessionDisplay';

describe('getSessionDisplayText', () => {
  it('uses the session title for every surface when it is meaningful', () => {
    expect(getSessionDisplayText({
      title: 'MyAgents 多缺陷根因修复',
      lastMessagePreview: 'assistant preview should not win',
    })).toBe('MyAgents 多缺陷根因修复');
  });

  it('falls back to the last real user query for generic titles', () => {
    expect(getSessionDisplayText({
      title: 'New Chat',
      lastMessagePreview: '之前的问题到底是啥啊？',
    })).toBe('之前的问题到底是啥啊？');
  });

  it('normalizes system-reminder titles before display', () => {
    expect(getSessionDisplayText({
      title: '<system-reminder>\n<CRON_TASK>\n执行任务：# GitHub Issue 自动化处理\n</CRON_TASK>\n</system-reminder>',
      lastMessagePreview: '我会先确认本机时间',
    })).toBe('GitHub Issue 自动化处理');
  });

  it('uses the same 35-character truncation for titles and previews', () => {
    expect(getSessionDisplayText({
      title: 'New Chat',
      lastMessagePreview: 'a'.repeat(40),
    })).toBe(`${'a'.repeat(35)}...`);
  });

  it('keeps the normalized full title available to overflow affordances', () => {
    const fullTitle = 'A historical conversation title that is longer than the compact list projection';
    expect(getFullSessionDisplayText({
      title: fullTitle,
      lastMessagePreview: 'preview should not win',
    })).toBe(fullTitle);
  });
});
