/** Unified logging wire types shared by Renderer and Sidecar. */
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * The historical `bun` discriminant remains part of persisted unified logs.
 * Renderer presentation maps that stable wire key to the current Node label.
 */
export type LogSource = 'bun' | 'rust' | 'react';

export interface LogEntry {
  source: LogSource;
  level: LogLevel;
  message: string;
  timestamp: string;
  meta?: Record<string, unknown>;
  sessionId?: string;
  tabId?: string;
  ownerId?: string;
  requestId?: string;
  turnId?: string;
  runtime?: string;
  runtimeSource?: string;
}
