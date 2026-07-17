import { scanCssReferences, scanJavaScriptReferences } from "./bounded-reference-scanner";

const DEFAULT_MAX_HTML_SCAN_CHARACTERS = 5 * 1024 * 1024;
const DEFAULT_MAX_REFERENCES = 2_000;
const DEFAULT_MAX_PAGE_SCRIPTS = 10_000;
const LINK_RESOURCE_RELATIONS = new Set([
  "icon",
  "manifest",
  "modulepreload",
  "prefetch",
  "preload",
  "stylesheet"
]);

const RAW_TEXT_TAGS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "script",
  "style",
  "title",
  "textarea",
  "xmp"
]);

const NAMED_ASCII_CHARACTER_REFERENCES = new Map<string, string>([
  ["AMP", "&"], ["amp", "&"], ["apos", "'"], ["ast", "*"], ["bsol", "\\"], ["colon", ":"],
  ["comma", ","], ["commat", "@"], ["DiacriticalGrave", "`"], ["dollar", "$"], ["equals", "="],
  ["excl", "!"], ["fjlig", "fj"], ["grave", "`"], ["GT", ">"], ["gt", ">"], ["Hat", "^"],
  ["lbrace", "{"], ["lbrack", "["], ["lcub", "{"], ["lowbar", "_"], ["lpar", "("], ["lsqb", "["],
  ["LT", "<"], ["lt", "<"], ["midast", "*"], ["NewLine", "\n"], ["nbsp", "\u00a0"], ["num", "#"],
  ["percnt", "%"], ["period", "."], ["plus", "+"], ["quest", "?"], ["QUOT", "\""], ["quot", "\""],
  ["rbrace", "}"], ["rbrack", "]"], ["rcub", "}"], ["rpar", ")"], ["rsqb", "]"], ["semi", ";"],
  ["sol", "/"], ["Tab", "\t"], ["UnderBar", "_"], ["verbar", "|"], ["vert", "|"],
  ["VerticalLine", "|"]
]);
const LEGACY_NAME_WITHOUT_SEMICOLON = new Set(["AMP", "amp", "GT", "gt", "LT", "lt", "nbsp", "QUOT", "quot"]);
const MAX_NAMED_CHARACTER_REFERENCE_LENGTH = 17;

const NUMERIC_CHARACTER_REFERENCE_REPLACEMENTS = new Map<number, number>([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178]
]);

export interface HtmlScanOptions {
  maxCharacters?: number;
  maxPageScripts?: number;
  maxReferences?: number;
  signal?: AbortSignal;
}

export interface HtmlScanResult {
  baseHref?: string;
  complete: boolean;
  hasDeclarativeClosedShadowRoot: boolean;
  pageScriptCount: number;
  reason: "complete" | "budget-exhausted";
  resourceReferences: string[];
  scannedCharacters: number;
  scriptCountComplete: boolean;
  workUnits: number;
}

interface ScanContext {
  content: string;
  limit: number;
  signal?: AbortSignal;
  workUnits: number;
}

interface ParsedTag {
  baseHref?: string;
  closed: boolean;
  closing: boolean;
  declarativeShadowRootMode: "closed" | "open" | null;
  end: number;
  name: string;
  resourceReferences: string[];
  relAttribute?: string;
  scriptEntryCount: number;
  scriptEntryCountTruncated: boolean;
  typeAttribute?: string;
}

interface ParsedAttributeValue {
  end: number;
  value?: string;
}

interface ResourceAttribute {
  name: string;
  value: string;
}

export function scanHtmlDocument(content: string, options: HtmlScanOptions = {}): HtmlScanResult {
  const maxCharacters = normalizeLimit(options.maxCharacters, DEFAULT_MAX_HTML_SCAN_CHARACTERS);
  const maxPageScripts = normalizeLimit(options.maxPageScripts, DEFAULT_MAX_PAGE_SCRIPTS);
  const maxReferences = normalizeLimit(options.maxReferences, DEFAULT_MAX_REFERENCES);
  const limit = Math.min(content.length, maxCharacters);
  const context: ScanContext = { content, limit, ...(options.signal ? { signal: options.signal } : {}), workUnits: 0 };
  throwIfAborted(context);
  const resourceReferences = new Set<string>();
  let baseHref: string | undefined;
  let pageScriptCount = 0;
  let hasDeclarativeClosedShadowRoot = false;
  let scriptCountComplete = true;
  let position = 0;
  let rawTextTag: string | null = null;
  let rawTextReferenceKind: "css" | "javascript" | null = null;
  let rawTextStart = 0;
  const inertTemplateStack: boolean[] = [];
  let inertTemplateDepth = 0;

  while (position < limit) {
    if (rawTextTag) {
      if (rawTextTag === "plaintext") {
        context.workUnits += limit - position;
        position = limit;
        break;
      }

      const character = readCharacter(context, position);
      if (character !== "<" || !matchesClosingTag(context, position, rawTextTag)) {
        position += 1;
        continue;
      }

      const closingTag = parseTag(context, position, false, false, 0, 0);
      if (closingTag?.closed && closingTag.closing && closingTag.name === rawTextTag) {
        collectEmbeddedReferences(
          context,
          rawTextReferenceKind,
          rawTextStart,
          position,
          resourceReferences,
          maxReferences
        );
        position = closingTag.end;
        rawTextTag = null;
        rawTextReferenceKind = null;
      } else {
        position += 1;
      }
      continue;
    }

    if (readCharacter(context, position) !== "<") {
      position += 1;
      continue;
    }

    if (matchesSequence(context, position, "<!--", false)) {
      position = skipComment(context, position + 4);
      continue;
    }

    const marker = readCharacter(context, position + 1);
    if (marker === "!" || marker === "?") {
      position = skipMarkupDeclaration(context, position + 2);
      continue;
    }

    const collectDocumentSemantics = inertTemplateDepth === 0;
    const tag = parseTag(
      context,
      position,
      true,
      collectDocumentSemantics,
      maxReferences,
      Math.max(0, maxPageScripts - pageScriptCount)
    );
    if (!tag) {
      position += 1;
      continue;
    }
    position = tag.end;
    if (!tag.closed) continue;

    if (tag.closing) {
      if (tag.name === "template") {
        const inert = inertTemplateStack.pop();
        if (inert) inertTemplateDepth -= 1;
      }
      continue;
    }

    for (const reference of tag.resourceReferences) {
      if (resourceReferences.size >= maxReferences) break;
      resourceReferences.add(reference);
    }
    if (collectDocumentSemantics) {
      if (tag.declarativeShadowRootMode === "closed") hasDeclarativeClosedShadowRoot = true;
      if (baseHref === undefined && tag.name === "base" && tag.baseHref !== undefined) {
        baseHref = tag.baseHref;
      }
      const scriptElementCount = isActiveScriptElement(tag) ? 1 : 0;
      const detectedEntries = scriptElementCount + tag.scriptEntryCount;
      if (tag.scriptEntryCountTruncated || pageScriptCount + detectedEntries > maxPageScripts) {
        scriptCountComplete = false;
      }
      pageScriptCount = Math.min(maxPageScripts, pageScriptCount + detectedEntries);
    }

    if (tag.name === "template") {
      const inert = !collectDocumentSemantics || tag.declarativeShadowRootMode === null;
      inertTemplateStack.push(inert);
      if (inert) inertTemplateDepth += 1;
    } else if (tag.name === "plaintext") {
      rawTextTag = "plaintext";
    } else if (RAW_TEXT_TAGS.has(tag.name)) {
      rawTextTag = tag.name;
      rawTextStart = tag.end;
      rawTextReferenceKind = getRawTextReferenceKind(tag);
    }
  }

  if (rawTextTag) {
    collectEmbeddedReferences(
      context,
      rawTextReferenceKind,
      rawTextStart,
      limit,
      resourceReferences,
      maxReferences
    );
  }

  const complete = content.length <= limit;
  return {
    ...(baseHref === undefined ? {} : { baseHref }),
    complete,
    hasDeclarativeClosedShadowRoot,
    pageScriptCount,
    reason: complete ? "complete" : "budget-exhausted",
    resourceReferences: [...resourceReferences],
    scannedCharacters: position,
    scriptCountComplete,
    workUnits: context.workUnits
  };
}

function parseTag(
  context: ScanContext,
  start: number,
  collectReferences: boolean,
  collectScriptSemantics: boolean,
  maxReferences: number,
  maxScriptEntries: number
): ParsedTag | null {
  let position = start + 1;
  let character = readCharacter(context, position);
  let closing = false;
  if (character === "/") {
    closing = true;
    position += 1;
    character = readCharacter(context, position);
  }
  if (!character || !isAsciiLetter(character)) return null;

  const nameStart = position;
  while (position < context.limit) {
    character = readCharacter(context, position);
    if (!character || !isTagNameCharacter(character)) break;
    position += 1;
  }
  const name = context.content.slice(nameStart, position).toLowerCase();
  const resourceReferences = new Set<string>();
  const resourceAttributes: ResourceAttribute[] = [];
  let baseHref: string | undefined;
  let scriptEntryCount = 0;
  let scriptEntryCountTruncated = false;
  let relAttribute: string | undefined;
  let typeAttribute: string | undefined;
  let closed = false;
  let declarativeShadowRootMode: "closed" | "open" | null = null;

  while (position < context.limit) {
    position = skipWhitespace(context, position);
    character = readCharacter(context, position);
    if (!character) break;
    if (character === ">") {
      position += 1;
      closed = true;
      break;
    }
    if (character === "/" && readCharacter(context, position + 1) === ">") {
      position += 2;
      closed = true;
      break;
    }

    const attributeNameStart = position;
    while (position < context.limit) {
      character = readCharacter(context, position);
      if (!character || isAttributeNameTerminator(character)) break;
      position += 1;
    }
    if (position === attributeNameStart) {
      position += 1;
      continue;
    }

    const attributeName = context.content.slice(attributeNameStart, position).toLowerCase();
    position = skipWhitespace(context, position);
    let attributeValue: string | undefined;
    if (readCharacter(context, position) === "=") {
      position = skipWhitespace(context, position + 1);
      const parsedValue = parseAttributeValue(context, position);
      position = parsedValue.end;
      attributeValue = parsedValue.value;
    }

    if (!closing) {
      if (
        name === "template"
        && attributeName === "shadowrootmode"
        && (attributeValue?.toLocaleLowerCase() === "closed"
          || attributeValue?.toLocaleLowerCase() === "open")
      ) {
        declarativeShadowRootMode = attributeValue.toLocaleLowerCase() as "closed" | "open";
      }
      if (
        collectScriptSemantics
        && attributeValue !== undefined
        && hasExecutableEventHandler(attributeValue)
        && attributeName.length > 2
        && attributeName.startsWith("on")
      ) {
        if (scriptEntryCount < maxScriptEntries) scriptEntryCount += 1;
        else scriptEntryCountTruncated = true;
      }
      if (
        collectScriptSemantics
        && attributeValue !== undefined
        && isExecutableJavascriptUrl(name, attributeName, attributeValue, context)
      ) {
        if (scriptEntryCount < maxScriptEntries) scriptEntryCount += 1;
        else scriptEntryCountTruncated = true;
      }
      if (collectReferences && attributeValue !== undefined) {
        if (isPotentialResourceAttribute(attributeName) && resourceAttributes.length < maxReferences) {
          resourceAttributes.push({ name: attributeName, value: attributeValue });
        }
        if (
          collectScriptSemantics
          && name === "base"
          && attributeName === "href"
          && baseHref === undefined
        ) {
          baseHref = attributeValue;
        }
      }
      if (attributeName === "rel" && relAttribute === undefined) relAttribute = attributeValue;
      if (attributeName === "type" && typeAttribute === undefined) typeAttribute = attributeValue;
    }
  }

  for (const attribute of resourceAttributes) {
    collectResourceAttribute(
      name,
      relAttribute,
      typeAttribute,
      attribute.name,
      attribute.value,
      resourceReferences,
      maxReferences,
      context
    );
  }

  return {
    ...(baseHref === undefined ? {} : { baseHref }),
    closed,
    closing,
    declarativeShadowRootMode,
    end: position,
    name,
    resourceReferences: [...resourceReferences],
    ...(relAttribute === undefined ? {} : { relAttribute }),
    scriptEntryCount,
    scriptEntryCountTruncated,
    ...(typeAttribute === undefined ? {} : { typeAttribute })
  };
}

function collectEmbeddedReferences(
  context: ScanContext,
  kind: "css" | "javascript" | null,
  start: number,
  end: number,
  target: Set<string>,
  maxReferences: number
): void {
  if (!kind || end <= start) return;
  const content = context.content.slice(start, end);
  const scan = kind === "css"
    ? scanCssReferences(content, { maxCharacters: content.length, maxReferences, signal: context.signal })
    : scanJavaScriptReferences(content, { maxCharacters: content.length, maxReferences, signal: context.signal });
  context.workUnits += scan.workUnits;
  for (const reference of scan.references) {
    if (target.size >= maxReferences) break;
    target.add(reference);
  }
}

function getRawTextReferenceKind(tag: ParsedTag): "css" | "javascript" | null {
  const type = normalizeType(tag.typeAttribute);
  if (tag.name === "style") return !type || type === "text/css" ? "css" : null;
  if (tag.name !== "script") return null;
  return isJavaScriptScriptType(tag.typeAttribute) ? "javascript" : null;
}

/**
 * Counts browser-processed script entries disabled by safe mode. Besides executable JavaScript,
 * import maps affect module loading and speculation rules can initiate browser loading; inert data
 * blocks such as application/json remain excluded.
 */
function isActiveScriptElement(tag: ParsedTag): boolean {
  if (tag.name !== "script") return false;
  const type = normalizeType(tag.typeAttribute);
  return isJavaScriptScriptType(tag.typeAttribute)
    || type === "importmap"
    || type === "speculationrules";
}

function isJavaScriptScriptType(typeAttribute: string | undefined): boolean {
  const type = normalizeType(typeAttribute);
  return !type || type === "module" || type.includes("javascript") || type.includes("ecmascript");
}

function normalizeType(typeAttribute: string | undefined): string {
  return typeAttribute?.trim().toLowerCase().split(";", 1)[0] ?? "";
}

function parseAttributeValue(context: ScanContext, start: number): ParsedAttributeValue {
  const quote = readCharacter(context, start);
  if (quote === '"' || quote === "'") {
    const valueStart = start + 1;
    let position = valueStart;
    while (position < context.limit && readCharacter(context, position) !== quote) position += 1;
    const value = decodeHtmlAttributeValue(context, valueStart, position);
    if (position < context.limit) position += 1;
    return { end: position, value };
  }

  const valueStart = start;
  let position = valueStart;
  while (position < context.limit) {
    const character = readCharacter(context, position);
    if (!character || isAsciiWhitespace(character) || character === ">") break;
    position += 1;
  }
  return {
    end: position,
    value: decodeHtmlAttributeValue(context, valueStart, position)
  };
}

function collectResourceAttribute(
  tagName: string,
  relAttribute: string | undefined,
  typeAttribute: string | undefined,
  attributeName: string,
  value: string,
  target: Set<string>,
  maxReferences: number,
  context: ScanContext
): void {
  if (target.size >= maxReferences) return;
  if (attributeName === "style") {
    const scan = scanCssReferences(value, {
      maxCharacters: value.length,
      maxReferences: Math.max(0, maxReferences - target.size),
      signal: context.signal
    });
    context.workUnits += scan.workUnits;
    for (const reference of scan.references) {
      if (target.size >= maxReferences) break;
      target.add(reference);
    }
    return;
  }
  if (
    attributeName === "href"
    && (tagName === "a" || tagName === "area")
    && isLocalHtmlNavigationReference(value)
  ) {
    target.add(value);
    return;
  }
  if (
    (attributeName === "href" || attributeName === "xlink:href")
    && (tagName === "image" || tagName === "use" || tagName === "feimage")
  ) {
    target.add(value);
    return;
  }
  if (!loadsBrowserResource(tagName, relAttribute, typeAttribute, attributeName)) return;
  if (attributeName === "srcset") {
    collectSrcsetReferences(value, target, maxReferences, context);
    return;
  }
  target.add(value);
}

function isPotentialResourceAttribute(attributeName: string): boolean {
  return attributeName === "src"
    || attributeName === "srcset"
    || attributeName === "poster"
    || attributeName === "data"
    || attributeName === "href"
    || attributeName === "xlink:href"
    || attributeName === "style";
}

/**
 * Static scope follows HTML attributes that trigger browser loads. Legacy frame remains supported.
 */
function loadsBrowserResource(
  tagName: string,
  relAttribute: string | undefined,
  typeAttribute: string | undefined,
  attributeName: string
): boolean {
  if (attributeName === "src") {
    if (tagName === "script") return isJavaScriptScriptType(typeAttribute);
    if (tagName === "input") return normalizeType(typeAttribute) === "image";
    return tagName === "audio"
      || tagName === "embed"
      || tagName === "frame"
      || tagName === "iframe"
      || tagName === "img"
      || tagName === "source"
      || tagName === "track"
      || tagName === "video";
  }
  if (attributeName === "srcset") return tagName === "img" || tagName === "source";
  if (attributeName === "poster") return tagName === "video";
  if (attributeName === "data") return tagName === "object";
  return attributeName === "href" && tagName === "link" && linkLoadsResource(relAttribute);
}

function isLocalHtmlNavigationReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) return false;
  const pathname = trimmed.split(/[?#]/u, 1)[0]?.toLowerCase() ?? "";
  return pathname.endsWith(".html") || pathname.endsWith(".htm");
}

function linkLoadsResource(relAttribute: string | undefined): boolean {
  if (!relAttribute) return false;
  return relAttribute
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .some(relation => LINK_RESOURCE_RELATIONS.has(relation));
}

function collectSrcsetReferences(
  value: string,
  target: Set<string>,
  maxReferences: number,
  context: ScanContext
): void {
  let position = 0;
  while (position < value.length && target.size < maxReferences) {
    while (position < value.length && (isAsciiWhitespace(value[position]!) || value[position] === ",")) {
      context.workUnits += 1;
      position += 1;
    }
    const candidateStart = position;
    while (position < value.length && !isAsciiWhitespace(value[position]!) && value[position] !== ",") {
      context.workUnits += 1;
      position += 1;
    }
    if (position > candidateStart) target.add(value.slice(candidateStart, position));
    while (position < value.length && value[position] !== ",") {
      context.workUnits += 1;
      position += 1;
    }
  }
}

function isExecutableJavascriptUrl(
  tagName: string,
  attributeName: string,
  value: string,
  context: ScanContext
): boolean {
  const executable = (attributeName === "href" || attributeName === "xlink:href")
    ? tagName === "a" || tagName === "area"
    : attributeName === "src"
      ? tagName === "frame" || tagName === "iframe"
      : attributeName === "action"
        ? tagName === "form"
        : attributeName === "formaction"
          ? tagName === "button" || tagName === "input"
          : attributeName === "data" && tagName === "object";
  if (!executable) return false;

  let normalized = "";
  let position = 0;
  let started = false;
  while (position < value.length && normalized.length < "javascript:".length && position < 256) {
    context.workUnits += 1;
    const character = value[position]!;
    position += 1;
    const code = character.charCodeAt(0);
    if (!started && code <= 0x20) continue;
    if (character === "\t" || character === "\n" || character === "\r") continue;
    started = true;
    normalized += character.toLowerCase();
  }
  return normalized === "javascript:";
}

function hasExecutableEventHandler(value: string): boolean {
  for (let position = 0; position < value.length; position += 1) {
    const character = value[position]!;
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0xa0 || code === 0xfeff) continue;
    return true;
  }
  return false;
}

function decodeHtmlAttributeValue(context: ScanContext, start: number, end: number): string {
  let position = start;
  let rawStart = start;
  let decoded: string[] | null = null;
  while (position < end) {
    const character = readCharacter(context, position);
    if (character !== "&") {
      position += 1;
      continue;
    }
    const reference = decodeCharacterReference(context, position, end);
    if (!reference) {
      position += 1;
      continue;
    }
    decoded ??= [];
    decoded.push(context.content.slice(rawStart, position), reference.character);
    position = reference.end;
    rawStart = position;
  }
  if (!decoded) return context.content.slice(start, end);
  decoded.push(context.content.slice(rawStart, end));
  return decoded.join("");
}

function decodeCharacterReference(
  context: ScanContext,
  start: number,
  end: number
): { character: string; end: number } | null {
  if (readCharacter(context, start + 1) === "#") {
    return decodeNumericCharacterReference(context, start, end);
  }
  return decodeNamedCharacterReference(context, start, end);
}

function decodeNumericCharacterReference(
  context: ScanContext,
  start: number,
  end: number
): { character: string; end: number } | null {
  let position = start + 2;
  const radixMarker = readCharacter(context, position);
  const hexadecimal = radixMarker === "x" || radixMarker === "X";
  if (hexadecimal) position += 1;
  const digitStart = position;
  const radix = hexadecimal ? 16 : 10;
  let codePoint = 0;
  let overflowed = false;

  while (position < end) {
    const character = readCharacter(context, position);
    const digit = character === undefined ? -1 : getAsciiDigitValue(character);
    if (digit < 0 || digit >= radix) break;
    if (!overflowed) {
      if (codePoint > Math.floor((0x10ffff - digit) / radix)) overflowed = true;
      else codePoint = codePoint * radix + digit;
    }
    position += 1;
  }
  if (position === digitStart) return null;
  if (readCharacter(context, position) === ";") position += 1;
  return {
    character: normalizeNumericCharacterReference(overflowed ? 0x110000 : codePoint),
    end: position
  };
}

function decodeNamedCharacterReference(
  context: ScanContext,
  start: number,
  end: number
): { character: string; end: number } | null {
  let candidateEnd = start + 1;
  while (
    candidateEnd < end
    && candidateEnd - (start + 1) < MAX_NAMED_CHARACTER_REFERENCE_LENGTH
  ) {
    const character = readCharacter(context, candidateEnd);
    if (!character || !isAsciiAlphaNumeric(character)) break;
    candidateEnd += 1;
  }

  for (let matchEnd = candidateEnd; matchEnd > start + 1; matchEnd -= 1) {
    const name = context.content.slice(start + 1, matchEnd);
    const character = NAMED_ASCII_CHARACTER_REFERENCES.get(name);
    if (character === undefined) continue;
    if (readCharacter(context, matchEnd) === ";") {
      return { character, end: matchEnd + 1 };
    }
    const following = readCharacter(context, matchEnd);
    if (
      LEGACY_NAME_WITHOUT_SEMICOLON.has(name)
      && (!following || (!isAsciiAlphaNumeric(following) && following !== "="))
    ) {
      return { character, end: matchEnd };
    }
  }
  return null;
}

function normalizeNumericCharacterReference(codePoint: number): string {
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return "\ufffd";
  }
  return String.fromCodePoint(NUMERIC_CHARACTER_REFERENCE_REPLACEMENTS.get(codePoint) ?? codePoint);
}

function getAsciiDigitValue(character: string): number {
  const code = character.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 65 + 10;
  if (code >= 97 && code <= 102) return code - 97 + 10;
  return -1;
}

function matchesClosingTag(context: ScanContext, start: number, tagName: string): boolean {
  if (readCharacter(context, start) !== "<" || readCharacter(context, start + 1) !== "/") return false;
  if (!matchesSequence(context, start + 2, tagName, true)) return false;
  const boundary = readCharacter(context, start + 2 + tagName.length);
  return boundary === undefined || boundary === ">" || boundary === "/" || isAsciiWhitespace(boundary);
}

function skipComment(context: ScanContext, start: number): number {
  if (readCharacter(context, start) === ">") return start + 1;
  if (readCharacter(context, start) === "-" && readCharacter(context, start + 1) === ">") return start + 2;
  let position = start;
  while (position < context.limit) {
    if (matchesSequence(context, position, "-->", false)) return position + 3;
    if (matchesSequence(context, position, "--!>", false)) return position + 4;
    position += 1;
  }
  return position;
}

function skipMarkupDeclaration(context: ScanContext, start: number): number {
  let position = start;
  let quote: string | null = null;
  while (position < context.limit) {
    const character = readCharacter(context, position);
    position += 1;
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      break;
    }
  }
  return position;
}

function skipWhitespace(context: ScanContext, start: number): number {
  let position = start;
  while (position < context.limit) {
    const character = readCharacter(context, position);
    if (!character || !isAsciiWhitespace(character)) break;
    position += 1;
  }
  return position;
}

function matchesSequence(context: ScanContext, start: number, expected: string, ignoreCase: boolean): boolean {
  if (start + expected.length > context.limit) return false;
  for (let offset = 0; offset < expected.length; offset += 1) {
    const actual = readCharacter(context, start + offset);
    const wanted = expected[offset];
    if (!actual || !wanted) return false;
    if (ignoreCase ? actual.toLowerCase() !== wanted.toLowerCase() : actual !== wanted) return false;
  }
  return true;
}

function readCharacter(context: ScanContext, position: number): string | undefined {
  if (position < 0 || position >= context.limit) return undefined;
  context.workUnits += 1;
  if ((context.workUnits & 0xfff) === 0) throwIfAborted(context);
  return context.content[position];
}

function throwIfAborted(context: ScanContext): void {
  if (context.signal?.aborted) throw new DOMException("HTML scan aborted", "AbortError");
}

function isAsciiLetter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlphaNumeric(character: string): boolean {
  const code = character.charCodeAt(0);
  return isAsciiLetter(character) || (code >= 48 && code <= 57);
}

function isTagNameCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return isAsciiLetter(character)
    || (code >= 48 && code <= 57)
    || character === ":"
    || character === "-";
}

function isAttributeNameTerminator(character: string): boolean {
  return isAsciiWhitespace(character) || character === "=" || character === ">" || character === "/";
}

function isAsciiWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor(value));
}
