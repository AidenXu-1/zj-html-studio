const DEFAULT_MAX_SCAN_CHARACTERS = 5 * 1024 * 1024;
const DEFAULT_MAX_REFERENCES = 2_000;

export interface TextReferenceScanOptions {
  maxCharacters?: number;
  maxReferences?: number;
  signal?: AbortSignal;
}

export interface TextReferenceScanResult {
  complete: boolean;
  reason: "complete" | "budget-exhausted";
  references: string[];
  scannedCharacters: number;
  workUnits: number;
}

interface ScanContext {
  content: string;
  limit: number;
  signal?: AbortSignal;
  workUnits: number;
}

interface ParsedString {
  closed: boolean;
  end: number;
  value: string;
}

interface JavaScriptToken {
  kind: "identifier" | "punctuation" | "string";
  value: string;
}

export function scanCssReferences(
  content: string,
  options: TextReferenceScanOptions = {}
): TextReferenceScanResult {
  const context = createContext(content, options.maxCharacters, options.signal);
  throwIfAborted(context);
  const maxReferences = normalizeLimit(options.maxReferences, DEFAULT_MAX_REFERENCES);
  const references = new Set<string>();
  let position = 0;

  while (position < context.limit) {
    const character = readCharacter(context, position);
    if (character === "/" && readCharacter(context, position + 1) === "*") {
      position = skipBlockComment(context, position + 2);
      continue;
    }
    if (character === '"' || character === "'") {
      position = parseQuotedString(context, position).end;
      continue;
    }
    if (character === "@" && matchesIdentifier(context, position + 1, "import")) {
      position = skipCssWhitespaceAndComments(context, position + "@import".length);
      const importQuote = readCharacter(context, position);
      if (importQuote === '"' || importQuote === "'") {
        const parsed = parseQuotedString(context, position);
        position = parsed.end;
        if (parsed.closed) addReference(references, parsed.value, maxReferences);
        continue;
      }
      if (matchesIdentifier(context, position, "url")) {
        const openingParenthesis = skipCssWhitespaceAndComments(context, position + 3);
        if (readCharacter(context, openingParenthesis) === "(") {
          const parsed = parseCssUrl(context, openingParenthesis + 1);
          position = parsed.end;
          if (parsed.closed) addReference(references, parsed.value, maxReferences);
          continue;
        }
      }
    }
    if (matchesIdentifier(context, position, "url")) {
      const openingParenthesis = skipCssWhitespaceAndComments(context, position + 3);
      if (readCharacter(context, openingParenthesis) === "(") {
        const parsed = parseCssUrl(context, openingParenthesis + 1);
        position = parsed.end;
        if (parsed.closed) addReference(references, parsed.value, maxReferences);
        continue;
      }
    }
    position += 1;
  }

  return buildResult(context, position, references);
}

export function scanJavaScriptReferences(
  content: string,
  options: TextReferenceScanOptions = {}
): TextReferenceScanResult {
  const context = createContext(content, options.maxCharacters, options.signal);
  throwIfAborted(context);
  const maxReferences = normalizeLimit(options.maxReferences, DEFAULT_MAX_REFERENCES);
  const referenceGroups = Array.from({ length: 5 }, () => new Set<string>());
  const recentTokens: JavaScriptToken[] = [];
  let moduleClauseActive = false;
  let expectModuleString = false;
  let position = 0;

  while (position < context.limit) {
    const character = readCharacter(context, position);
    if (isWhitespace(character)) {
      position += 1;
      continue;
    }
    if (character === "/" && readCharacter(context, position + 1) === "/") {
      position = skipLineComment(context, position + 2);
      continue;
    }
    if (character === "/" && readCharacter(context, position + 1) === "*") {
      position = skipBlockComment(context, position + 2);
      continue;
    }
    if (character === "`") {
      position = skipTemplateLiteral(context, position + 1);
      continue;
    }

    let token: JavaScriptToken;
    if (character === '"' || character === "'") {
      const parsed = parseQuotedString(context, position);
      position = parsed.end;
      if (!parsed.closed) continue;
      token = { kind: "string", value: parsed.value };
    } else if (character && isIdentifierStart(character)) {
      const start = position;
      position += 1;
      while (position < context.limit) {
        const next = readCharacter(context, position);
        if (!next || !isIdentifierPart(next)) break;
        position += 1;
      }
      token = { kind: "identifier", value: content.slice(start, position) };
    } else {
      position += 1;
      token = { kind: "punctuation", value: character ?? "" };
    }

    recentTokens.push(token);
    if (recentTokens.length > 12) recentTokens.shift();

    if (token.kind === "identifier" && (token.value === "import" || token.value === "export")) {
      moduleClauseActive = true;
      expectModuleString = false;
    } else if (moduleClauseActive && token.kind === "identifier" && token.value === "from") {
      expectModuleString = true;
    }

    let matchedReference: string | undefined;
    let referenceGroup = 0;
    if (token.kind === "string") {
      if (expectModuleString) {
        matchedReference = token.value;
        moduleClauseActive = false;
        expectModuleString = false;
      } else if (matchesTokenSuffix(recentTokens, ["id:import", "str"])) {
        matchedReference = token.value;
        moduleClauseActive = false;
      } else if (matchesTokenSuffix(recentTokens, ["id:import", "pun:(", "str"])) {
        matchedReference = token.value;
        referenceGroup = 1;
        moduleClauseActive = false;
      } else if (matchesTokenSuffix(recentTokens, ["id:fetch", "pun:(", "str"])) {
        matchedReference = token.value;
        referenceGroup = 3;
      } else if (
        matchesTokenSuffix(recentTokens, ["id:new", "id:Worker", "pun:(", "str"])
        || matchesTokenSuffix(recentTokens, ["id:new", "id:SharedWorker", "pun:(", "str"])
      ) {
        matchedReference = token.value;
        referenceGroup = 4;
      }
    } else if (
      token.kind === "punctuation"
      && token.value === ")"
      && matchesTokenSuffix(recentTokens, [
        "id:new",
        "id:URL",
        "pun:(",
        "str",
        "pun:,",
        "id:import",
        "pun:.",
        "id:meta",
        "pun:.",
        "id:url",
        "pun:)"
      ])
    ) {
      matchedReference = recentTokens[recentTokens.length - 8]?.value;
      referenceGroup = 2;
    }
    if (matchedReference !== undefined) {
      const group = referenceGroups[referenceGroup];
      if (group) addReference(group, matchedReference, maxReferences);
    }

    if (token.kind === "punctuation" && token.value === ";") {
      moduleClauseActive = false;
      expectModuleString = false;
    }
  }

  const references = new Set<string>();
  for (const group of referenceGroups) {
    for (const reference of group) addReference(references, reference, maxReferences);
  }
  return buildResult(context, position, references);
}

function parseCssUrl(context: ScanContext, start: number): ParsedString {
  let position = skipCssWhitespaceAndComments(context, start);
  const quote = readCharacter(context, position);
  if (quote === '"' || quote === "'") {
    const parsed = parseQuotedString(context, position);
    if (!parsed.closed) return parsed;
    position = skipCssWhitespaceAndComments(context, parsed.end);
    if (readCharacter(context, position) !== ")") {
      return { closed: false, end: consumeToLimit(context, position), value: parsed.value };
    }
    return { closed: true, end: position + 1, value: parsed.value };
  }

  const valueStart = position;
  while (position < context.limit) {
    const character = readCharacter(context, position);
    if (character === "\\" && position + 1 < context.limit) {
      readCharacter(context, position + 1);
      position += 2;
      continue;
    }
    if (character === ")") {
      return {
        closed: true,
        end: position + 1,
        value: context.content.slice(valueStart, position).trim()
      };
    }
    position += 1;
  }
  return { closed: false, end: position, value: "" };
}

function parseQuotedString(context: ScanContext, start: number): ParsedString {
  const quote = readCharacter(context, start);
  let position = start + 1;
  while (position < context.limit) {
    const character = readCharacter(context, position);
    if (character === "\\" && position + 1 < context.limit) {
      readCharacter(context, position + 1);
      position += 2;
      continue;
    }
    if (character === quote) {
      return {
        closed: true,
        end: position + 1,
        value: context.content.slice(start + 1, position)
      };
    }
    position += 1;
  }
  return { closed: false, end: position, value: "" };
}

function skipTemplateLiteral(context: ScanContext, start: number): number {
  let position = start;
  while (position < context.limit) {
    const character = readCharacter(context, position);
    if (character === "\\" && position + 1 < context.limit) {
      readCharacter(context, position + 1);
      position += 2;
      continue;
    }
    position += 1;
    if (character === "`") break;
  }
  return position;
}

function skipLineComment(context: ScanContext, start: number): number {
  let position = start;
  while (position < context.limit) {
    const character = readCharacter(context, position);
    position += 1;
    if (character === "\n" || character === "\r") break;
  }
  return position;
}

function skipBlockComment(context: ScanContext, start: number): number {
  let position = start;
  while (position < context.limit) {
    if (readCharacter(context, position) === "*" && readCharacter(context, position + 1) === "/") {
      return position + 2;
    }
    position += 1;
  }
  return position;
}

function skipCssWhitespaceAndComments(context: ScanContext, start: number): number {
  let position = start;
  while (position < context.limit) {
    const character = readCharacter(context, position);
    if (isWhitespace(character)) {
      position += 1;
      continue;
    }
    if (character === "/" && readCharacter(context, position + 1) === "*") {
      position = skipBlockComment(context, position + 2);
      continue;
    }
    break;
  }
  return position;
}

function matchesIdentifier(context: ScanContext, start: number, expected: string): boolean {
  const before = start > 0 ? readCharacter(context, start - 1) : undefined;
  if (before && isIdentifierPart(before)) return false;
  if (start + expected.length > context.limit) return false;
  for (let offset = 0; offset < expected.length; offset += 1) {
    const actual = readCharacter(context, start + offset);
    if (!actual || actual.toLowerCase() !== expected[offset]) return false;
  }
  const after = readCharacter(context, start + expected.length);
  return !after || !isIdentifierPart(after);
}

function matchesTokenSuffix(tokens: JavaScriptToken[], expected: string[]): boolean {
  if (tokens.length < expected.length) return false;
  const offset = tokens.length - expected.length;
  return expected.every((matcher, index) => tokenMatches(tokens[offset + index], matcher));
}

function tokenMatches(token: JavaScriptToken | undefined, matcher: string): boolean {
  if (!token) return false;
  if (matcher === "str") return token.kind === "string";
  if (matcher.startsWith("id:")) return token.kind === "identifier" && token.value === matcher.slice(3);
  return matcher.startsWith("pun:") && token.kind === "punctuation" && token.value === matcher.slice(4);
}

function createContext(
  content: string,
  maxCharacters: number | undefined,
  signal: AbortSignal | undefined
): ScanContext {
  const limit = Math.min(content.length, normalizeLimit(maxCharacters, DEFAULT_MAX_SCAN_CHARACTERS));
  return { content, limit, ...(signal ? { signal } : {}), workUnits: 0 };
}

function buildResult(context: ScanContext, position: number, references: Set<string>): TextReferenceScanResult {
  const complete = context.content.length <= context.limit;
  return {
    complete,
    reason: complete ? "complete" : "budget-exhausted",
    references: [...references],
    scannedCharacters: position,
    workUnits: context.workUnits
  };
}

function addReference(target: Set<string>, value: string, maxReferences: number): void {
  if (value && target.size < maxReferences) target.add(value);
}

function consumeToLimit(context: ScanContext, start: number): number {
  throwIfAborted(context);
  context.workUnits += context.limit - start;
  return context.limit;
}

function readCharacter(context: ScanContext, position: number): string | undefined {
  if (position < 0 || position >= context.limit) return undefined;
  context.workUnits += 1;
  if ((context.workUnits & 0xfff) === 0) throwIfAborted(context);
  return context.content[position];
}

function throwIfAborted(context: ScanContext): void {
  if (context.signal?.aborted) throw new DOMException("Reference scan aborted", "AbortError");
}

function isIdentifierStart(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || character === "_" || character === "$";
}

function isIdentifierPart(character: string): boolean {
  const code = character.charCodeAt(0);
  return isIdentifierStart(character) || (code >= 48 && code <= 57) || character === "-";
}

function isWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor(value));
}
