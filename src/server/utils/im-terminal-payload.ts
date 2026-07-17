export type ImReplyPayload = Record<string, unknown> & {
  text?: string;
  isError?: boolean;
};

export type ImTerminalPayload = {
  finalPayloads: ImReplyPayload[];
};

export function buildImCompletePayload(text: string): ImTerminalPayload {
  return {
    finalPayloads: text.trim() ? [{ text }] : [],
  };
}

export function buildImErrorPayload(text: string): ImTerminalPayload {
  return {
    finalPayloads: text.trim() ? [{ text, isError: true }] : [],
  };
}

export function buildImCancelledPayload(text = '🛑 已取消'): ImTerminalPayload {
  return {
    finalPayloads: text.trim() ? [{ text }] : [],
  };
}
