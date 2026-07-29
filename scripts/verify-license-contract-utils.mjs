export function normalizeTextLineEndings(content) {
  return content.replace(/\r\n?/g, '\n');
}
