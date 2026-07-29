/** A declaration block from the restricted Theme stylesheet grammar. */
export interface ThemeCssBlock {
  prelude: string;
  body: string;
}

export interface ParsedThemeStylesheet {
  cssText: string;
  topLevelBlocks: readonly ThemeCssBlock[];
  blocks: readonly ThemeCssBlock[];
}

/** CSS Syntax input preprocessing normalizes CRLF, lone CR and form-feed to LF. */
function normalizeCssInput(cssText: string): string {
  return cssText.replace(/\r\n?|\f/g, '\n');
}

function stripCssComments(cssText: string): string {
  let result = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < cssText.length; index += 1) {
    const character = cssText[index];
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      result += character;
      escaped = true;
      continue;
    }
    if (quote) {
      result += character;
      if (character === '\n') quote = null;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      continue;
    }
    if (character === '/' && cssText[index + 1] === '*') {
      const close = cssText.indexOf('*/', index + 2);
      if (close < 0) throw new Error('[theme] stylesheet contains an unclosed CSS comment');
      index = close + 1;
      continue;
    }
    result += character;
  }
  return result;
}

/** Parse top-level blocks while respecting quoted strings and nested at-rules. */
export function collectTopLevelCssBlocks(
  cssText: string,
  requireComplete = false,
): ThemeCssBlock[] {
  const blocks: ThemeCssBlock[] = [];
  let cursor = 0;
  while (cursor < cssText.length) {
    let open = -1;
    let quote: '"' | "'" | null = null;
    let escaped = false;
    for (let index = cursor; index < cssText.length; index += 1) {
      const character = cssText[index];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (quote) {
        if (character === '\n') quote = null;
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === '{') { open = index; break; }
    }
    if (open < 0) {
      if (requireComplete && cssText.slice(cursor).trim()) {
        throw new Error('[theme] stylesheet contains unsupported trailing content');
      }
      break;
    }

    let depth = 1;
    quote = null;
    escaped = false;
    let close = -1;
    for (let index = open + 1; index < cssText.length; index += 1) {
      const character = cssText[index];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (quote) {
        if (character === '\n') quote = null;
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === '{') depth += 1;
      if (character === '}') depth -= 1;
      if (depth === 0) { close = index; break; }
    }
    if (close < 0) throw new Error('[theme] stylesheet contains an unclosed CSS block');
    blocks.push({
      prelude: cssText.slice(cursor, open).trim(),
      body: cssText.slice(open + 1, close),
    });
    cursor = close + 1;
  }
  return blocks;
}

export function containsTopLevelSemicolon(cssText: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (const character of cssText) {
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (quote) {
      if (character === '\n') quote = null;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{') { depth += 1; continue; }
    if (character === '}') { depth -= 1; continue; }
    if (character === ';' && depth === 0) return true;
  }
  return false;
}

export function containsStructuralBrace(cssText: string): boolean {
  let quote: string | null = null;
  let escaped = false;
  for (const character of cssText) {
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (quote) {
      if (character === '\n') quote = null;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{' || character === '}') return true;
  }
  return false;
}

/** Include rules nested in conditional at-rules for selector-scope checks. */
function collectStylesheetCssBlocks(cssText: string): ThemeCssBlock[] {
  return collectTopLevelCssBlocks(cssText).flatMap(block => (
    block.prelude.trim().startsWith('@')
      ? [block, ...collectStylesheetCssBlocks(block.body)]
      : [block]
  ));
}

export function decodeCssEscapes(value: string): string {
  return value
    .replace(/\\(?:\r\n|[\n\r\f])/g, '')
    .replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?/gi, (_match, hex: string) => (
      String.fromCodePoint(Number.parseInt(hex, 16))
    ))
    .replace(/\\([^\r\n\f0-9a-f])/gi, '$1');
}

function normalizeSelector(selector: string): string | null {
  // Contract selectors deliberately use a tiny grammar. Attribute quotes and
  // insignificant whitespace are serialization details, not Theme identity.
  let invalidAttributeValue = false;
  const normalizedAttributes = selector.trim().replace(
    /\[\s*(data-theme-id|data-color-scheme)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([a-z0-9-]+))\s*\]/g,
    (
      _match,
      attribute: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      bare: string | undefined,
    ) => {
      const value = decodeCssEscapes((doubleQuoted ?? singleQuoted ?? bare)!);
      // Theme IDs may begin with a digit when quoted. An unquoted CSS
      // attribute value cannot: the browser would discard that selector.
      if (!/^[a-z0-9-]+$/.test(value) || (bare !== undefined && !/^[a-z][a-z0-9-]*$/.test(bare))) {
        invalidAttributeValue = true;
      }
      return `[${attribute}='${value}']`;
    },
  );
  if (invalidAttributeValue || normalizedAttributes.includes('\\')) return null;
  const normalized = normalizedAttributes.replace(/\s+/g, ' ');
  if (
    /^html\[data-theme-id='[a-z0-9-]+'\](?:\[data-color-scheme='(?:light|dark)'\])?(?: \.(?:theme-product-wordmark|theme-launcher-hero-(?:title|slogan)))?$/.test(normalized)
    || /^html\[data-color-scheme='(?:light|dark)'\]$/.test(normalized)
    || normalized === ':root'
    || /^\.(?:theme-product-wordmark|theme-launcher-hero-(?:title|slogan))$/.test(normalized)
  ) {
    return normalized;
  }
  return null;
}

export function selectorListExactlyMatches(
  prelude: string,
  expectedSelectors: readonly string[],
): boolean {
  const actual = prelude.split(',').map(normalizeSelector);
  const expected = expectedSelectors.map(normalizeSelector);
  return !actual.includes(null)
    && !expected.includes(null)
    && actual.length === expected.length
    && actual.every((selector, index) => selector === expected[index]);
}

export function selectorListContainsExact(prelude: string, expectedSelector: string): boolean {
  const expected = normalizeSelector(expectedSelector);
  return expected !== null && prelude.split(',').some(selector => {
    const strict = normalizeSelector(selector);
    if (strict === expected) return true;
    // Decode only to ensure an equivalent-but-forbidden spelling is rejected
    // as an unexpected contract block instead of being silently ignored.
    return strict === null && normalizeSelector(decodeCssEscapes(selector)) === expected;
  });
}

export function collectContractBlocks(
  blocks: readonly ThemeCssBlock[],
  targetSelector: string,
  acceptedSelectorLists: readonly (readonly string[])[],
  path: string,
): ThemeCssBlock[] {
  const matchingBlocks = blocks.filter(block => selectorListContainsExact(block.prelude, targetSelector));
  const unexpectedBlock = matchingBlocks.find(block => (
    !acceptedSelectorLists.some(selectors => selectorListExactlyMatches(block.prelude, selectors))
  ));
  if (unexpectedBlock) {
    throw new Error(`[theme] ${path}: selector must not be combined with unexpected selectors`);
  }
  return matchingBlocks;
}

export function collectDeclaredTokens(blocks: readonly ThemeCssBlock[]): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const block of blocks) {
    if (block.body.includes('{') || block.body.includes('}')) continue;
    let declarationStart = 0;
    let quote: '"' | "'" | null = null;
    let escaped = false;
    let parenthesisDepth = 0;
    let bracketDepth = 0;
    for (let index = 0; index <= block.body.length; index += 1) {
      const character = block.body[index];
      if (index < block.body.length) {
        if (escaped) { escaped = false; continue; }
        if (character === '\\') { escaped = true; continue; }
        if (quote) {
          if (character === '\n') quote = null;
          if (character === quote) quote = null;
          continue;
        }
        if (character === '"' || character === "'") { quote = character; continue; }
        if (character === '(') { parenthesisDepth += 1; continue; }
        if (character === ')') { parenthesisDepth = Math.max(0, parenthesisDepth - 1); continue; }
        if (character === '[') { bracketDepth += 1; continue; }
        if (character === ']') { bracketDepth = Math.max(0, bracketDepth - 1); continue; }
      }
      if (
        (character === ';' || index === block.body.length)
        && parenthesisDepth === 0
        && bracketDepth === 0
      ) {
        const declaration = block.body.slice(declarationStart, index);
        const match = declaration.match(/^\s*(--[a-zA-Z0-9-]+)\s*:\s*([\s\S]*?)\s*$/);
        if (match) tokens.set(match[1], match[2]);
        declarationStart = index + 1;
      }
    }
  }
  return tokens;
}

/** Parse once so construction and validation consume identical CSS semantics. */
export function parseThemeStylesheet(stylesheetText: string): ParsedThemeStylesheet {
  const cssText = stripCssComments(normalizeCssInput(stylesheetText));
  if (containsTopLevelSemicolon(cssText)) {
    throw new Error('[theme] stylesheet contains unsupported top-level statement');
  }
  const topLevelBlocks = collectTopLevelCssBlocks(cssText, true);
  return {
    cssText,
    topLevelBlocks,
    blocks: collectStylesheetCssBlocks(cssText),
  };
}
