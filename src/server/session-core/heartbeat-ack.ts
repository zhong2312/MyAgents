export type HeartbeatAcknowledgement = Readonly<{
  hadAcknowledgement: boolean;
  remainder: string;
}>;

const HEARTBEAT_ACK = /HEARTBEAT_OK/gi;
const BRACKETED_HEARTBEAT_ACK = /<\s*HEARTBEAT_OK\s*>/gi;
const EMPTY_HTML_PAIR = /<([A-Za-z][A-Za-z0-9-]*)\b[^>]*>\s*<\/\1\s*>/g;

export function stripHeartbeatAcknowledgement(text: string): HeartbeatAcknowledgement {
  const hadAcknowledgement = /HEARTBEAT_OK/i.test(text);
  if (!hadAcknowledgement) return { hadAcknowledgement: false, remainder: text };

  let remainder = text
    .replace(BRACKETED_HEARTBEAT_ACK, '')
    .replace(HEARTBEAT_ACK, '');
  let previous = '';
  while (previous !== remainder) {
    previous = remainder;
    remainder = remainder.replace(EMPTY_HTML_PAIR, '');
  }
  return { hadAcknowledgement: true, remainder: remainder.trim() };
}

export function heartbeatAcknowledgementHasSubstantiveRemainder(text: string): boolean {
  const { remainder } = stripHeartbeatAcknowledgement(text);
  return remainder
    .replace(/!?(?:\[\s*\])\([^)]*\)/g, '')
    .replace(/&(?:nbsp|ensp|emsp|thinsp|zwnj|zwj|ZeroWidthSpace);/gi, '')
    .replace(/&#(?:160|819[2-9]|820[0-5]|8287|12288|65279);/gi, '')
    .replace(/&#x(?:A0|200[0-9A-D]|202F|205F|3000|FEFF);/gi, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[*_`~>#\s]/g, '')
    .length > 0;
}
