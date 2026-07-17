import { scanHtmlDocument } from "../scope/bounded-html-parser";

export const MAX_SEARCH_BRIDGE_HTML_BYTES = 4 * 1024 * 1024;

export interface SearchBridgeMessage {
  channel: string;
  countComplete?: boolean;
  countReliable?: boolean;
  current?: number;
  found?: boolean;
  hash?: string;
  pathname?: string;
  query?: string;
  requestId?: number;
  scrollX?: number;
  scrollY?: number;
  search?: string;
  searchInvalidated?: boolean;
  searchLimited?: boolean;
  total?: number;
  truncatedReason?: "active-time" | "characters" | "dom-changed" | "matches" | "nodes" | "wall-time";
  type:
    | "html-studio-page-state"
    | "html-studio-page-state-request"
    | "html-studio-page-state-restore"
    | "html-studio-page-state-restored"
    | "html-studio-search"
    | "html-studio-search-leaving"
    | "html-studio-search-open"
    | "html-studio-search-ready"
    | "html-studio-search-result";
}

export function injectSearchBridge(
  source: string,
  nonce: string,
  channel: string,
  allowDynamicPageScripts = false
): string {
  return injectSearchBridgeBuffer(
    Buffer.from(source, "utf8"),
    nonce,
    channel,
    allowDynamicPageScripts
  ).toString("utf8");
}

export function injectSearchBridgeBuffer(
  source: Buffer,
  nonce: string,
  channel: string,
  allowDynamicPageScripts = false
): Buffer {
  const hasDeclarativeClosedShadowRoot = scanHtmlDocument(source.toString("utf8"), {
    maxCharacters: source.length,
    maxPageScripts: 0,
    maxReferences: 0
  }).hasDeclarativeClosedShadowRoot;
  const script = Buffer.from(
    `<script nonce="${nonce}">document.currentScript?.remove();if(parent===top){${buildSearchBridgeSource(channel, hasDeclarativeClosedShadowRoot, allowDynamicPageScripts)}}</script>`,
    "utf8"
  );
  const insertionOffset = findSearchBridgeInsertionOffset(source);
  return Buffer.concat(
    [source.subarray(0, insertionOffset), script, source.subarray(insertionOffset)],
    source.byteLength + script.byteLength
  );
}

function buildSearchBridgeSource(
  channel: string,
  hasDeclarativeClosedShadowRoot: boolean,
  allowDynamicPageScripts: boolean
): string {
  return `(${searchBridgeRuntime.toString()})(${JSON.stringify(channel)},${JSON.stringify(hasDeclarativeClosedShadowRoot)},${JSON.stringify(allowDynamicPageScripts)})`;
}

// The bridge deliberately snapshots unbound DOM intrinsics before user scripts run.
/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- DOM intrinsics are captured unbound, then invoked with their verified receiver through the pre-captured Reflect.apply. */
function searchBridgeRuntime(
  channel: string,
  hasDeclarativeClosedShadowRoot: boolean,
  allowDynamicPageScripts: boolean
): void {
  "use strict";
  const Channel = MessageChannel;
  const Observer = MutationObserver;
  const ElementType = Element;
  const NativePromise = Promise;
  const characterDataGetter = Object.getOwnPropertyDescriptor(CharacterData.prototype, "data")?.get;
  const inputTypeGetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "type")?.get;
  const inputValueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  const inputValueGetter = inputValueDescriptor?.get;
  const shadowRootGetter = Object.getOwnPropertyDescriptor(ElementType.prototype, "shadowRoot")?.get;
  const tagNameGetter = Object.getOwnPropertyDescriptor(ElementType.prototype, "tagName")?.get;
  const textareaValueDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  const textareaValueGetter = textareaValueDescriptor?.get;
  const nativeApply = Reflect.apply.bind(Reflect);
  const nativeAnimate = ElementType.prototype.animate;
  const nativeArraySort = Array.prototype.sort;
  const nativeCheckVisibility = ElementType.prototype.checkVisibility;
  const nativeClosest = ElementType.prototype.closest;
  const nativeCreateRange = document.createRange.bind(document);
  const nativeCreateTreeWalker = document.createTreeWalker.bind(document);
  const nativeFind = (window as unknown as { find: (...args: unknown[]) => boolean }).find.bind(window);
  const nativeGetRootNode = Node.prototype.getRootNode;
  const nativeGetComputedStyle = getComputedStyle.bind(window);
  const nativeCompareDocumentPosition = Node.prototype.compareDocumentPosition;
  const nativeIndexOf = String.prototype.indexOf;
  const nativeIsPrototypeOf = (prototype: object, value: unknown): boolean => (
    Object.prototype.isPrototypeOf.call(prototype, value as object)
  );
  const nativeNow = performance.now.bind(performance);
  const nativeScrollIntoView = ElementType.prototype.scrollIntoView;
  const nativeInputSetSelectionRange = HTMLInputElement.prototype.setSelectionRange;
  const nativeGetStyleProperty = CSSStyleDeclaration.prototype.getPropertyValue;
  const nativeTextareaSetSelectionRange = HTMLTextAreaElement.prototype.setSelectionRange;
  const nativeSetTimeout = window.setTimeout.bind(window) as (callback: () => void, delay?: number) => number;
  const nativeRequestAnimationFrame = requestAnimationFrame.bind(window);
  const NativeRegExp = RegExp;
  const nativeRegExpExec = RegExp.prototype.exec;
  const nativeRegExpTest = RegExp.prototype.test;
  const nativeScrollTo = scrollTo.bind(window);
  const nativeToLocaleUpperCase = String.prototype.toLocaleUpperCase;
  const nativeStringSlice = String.prototype.slice;
  const nativeWeakRefDeref = WeakRef.prototype.deref;
  const whitespacePattern = /\s/u;
  const toUpperCase = (value: string): string => nativeApply(nativeToLocaleUpperCase, value, []);
  const isWhitespace = (value: string): boolean => nativeApply(nativeRegExpTest, whitespacePattern, [value]);
  const readText = (node: Text): string => characterDataGetter
    ? nativeApply(characterDataGetter, node, [])
    : node.data;
  const readFieldValue = (field: HTMLInputElement | HTMLTextAreaElement): string => {
    const getter = field instanceof HTMLInputElement ? inputValueGetter : textareaValueGetter;
    return getter ? nativeApply(getter, field, []) : field.value;
  };
  const readOpenShadowRoot = (element: Element): ShadowRoot | null => shadowRootGetter
    ? nativeApply(shadowRootGetter, element, [])
    : element.shadowRoot;
  const readTagName = (element: Element): string => tagNameGetter
    ? nativeApply(tagNameGetter, element, [])
    : element.tagName;
  const readStyleProperty = (element: Element, property: string): string => nativeApply(
    nativeGetStyleProperty,
    nativeGetComputedStyle(element),
    [property]
  );
  const escapeRegExp = (value: string): string => {
    const special = "\\^$.*+?()[]{}|";
    let escaped = "";
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]!;
      if (nativeApply(nativeIndexOf, special, [character, 0]) >= 0) escaped += "\\";
      escaped += character;
    }
    return escaped;
  };
  let port: MessagePort | null = null;
  let query = "";
  let found = false;
  let latestSearchRequestId = 0;
  let manualIndex = -1;
  let manualRevision = 0;
  let manualSearchRunId = 0;
  let lastManualRevision = -1;
  let scrollTimer = 0;
  const observedRoots = new WeakSet<Node>();
  const trackedClosedShadowRoots: Array<WeakRef<ShadowRoot>> = [];
  let closedShadowOverflow = false;
  let notifyClosedShadowChange = (): void => undefined;
  const attachShadowDescriptor = Object.getOwnPropertyDescriptor(ElementType.prototype, "attachShadow");
  const nativeAttachShadow = attachShadowDescriptor?.value as ((init: ShadowRootInit) => ShadowRoot) | undefined;
  if (attachShadowDescriptor && nativeAttachShadow) {
    Object.defineProperty(ElementType.prototype, "attachShadow", {
      ...attachShadowDescriptor,
      value: function(this: Element, init: ShadowRootInit): ShadowRoot {
        const root = nativeApply(nativeAttachShadow, this, [init]);
        if (root.mode === "closed") {
          if (trackedClosedShadowRoots.length >= 25_000) closedShadowOverflow = true;
          else trackedClosedShadowRoots.push(new WeakRef(root));
        }
        notifyClosedShadowChange();
        return root;
      }
    });
  }

  const post = (message: Omit<SearchBridgeMessage, "channel">): void => {
    port?.postMessage({ channel, ...message });
  };
  const sendState = (type: SearchBridgeMessage["type"] = "html-studio-page-state"): void => {
    post({
      type,
      pathname: location.pathname.slice(0, 4_096),
      search: location.search.slice(0, 4_096),
      hash: location.hash.slice(0, 4_096),
      scrollX: Math.max(0, Math.floor(scrollX)),
      scrollY: Math.max(0, Math.floor(scrollY))
    });
  };
  const invalidateSearch = (): void => {
    if (!query) return;
    manualRevision += 1;
    manualSearchRunId += 1;
    found = false;
    getSelection()?.removeAllRanges();
    post({
      type: "html-studio-search-result",
      requestId: latestSearchRequestId,
      query,
      found: false,
      current: 0,
      total: 0,
      countComplete: false,
      countReliable: false,
      searchInvalidated: true
    });
  };
  notifyClosedShadowChange = invalidateSearch;
  const installValueMutationHook = (
    prototype: object,
    descriptor: PropertyDescriptor | undefined
  ): void => {
    if (!descriptor?.set) return;
    const nativeSetter = descriptor.set;
    Object.defineProperty(prototype, "value", {
      ...descriptor,
      set: function(this: HTMLInputElement | HTMLTextAreaElement, value: string): void {
        nativeApply(nativeSetter, this, [value]);
        notifyClosedShadowChange();
      }
    });
  };
  installValueMutationHook(HTMLInputElement.prototype, inputValueDescriptor);
  installValueMutationHook(HTMLTextAreaElement.prototype, textareaValueDescriptor);
  const observeRoot = (root: Node): void => {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    new Observer(invalidateSearch).observe(root, {
      attributeFilter: ["aria-hidden", "class", "hidden", "inert", "style", "value"],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
  };
  type SearchTextPart = { node: Text; preserveWhitespace: boolean };
  type SearchTargets = {
    fields: Array<HTMLInputElement | HTMLTextAreaElement>;
    textGroups: Array<Array<SearchTextPart | null>>;
  };
  type ManualSearchMatch =
    | { end: number; field: HTMLInputElement | HTMLTextAreaElement; kind: "field"; start: number }
    | {
      endNode: Text;
      endOffset: number;
      kind: "text";
      startNode: Text;
      startOffset: number;
    };
  type FlatTextSegment = {
    flatEnd: number;
    flatStart: number;
    node: Text;
    nodeStart: number;
  };
  const isStaticTextBoundaryElement = (element: Element): boolean => {
    switch (toUpperCase(readTagName(element))) {
      case "ADDRESS":
      case "ARTICLE":
      case "ASIDE":
      case "BLOCKQUOTE":
      case "BR":
      case "DD":
      case "DIV":
      case "DL":
      case "DT":
      case "FOOTER":
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
      case "HEADER":
      case "HR":
      case "LI":
      case "MAIN":
      case "NAV":
      case "OL":
      case "P":
      case "PRE":
      case "SECTION":
      case "TABLE":
      case "TD":
      case "TH":
      case "TR":
      case "UL":
        return true;
      default:
        return false;
    }
  };
  const collectSearchTargets = (): SearchTargets | null => {
    const documentRoot = document.documentElement;
    if (!documentRoot || hasDeclarativeClosedShadowRoot || closedShadowOverflow) return null;
    const roots: Node[] = [documentRoot];
    trackedClosedShadowRoots.forEach(reference => {
      const root = nativeApply(nativeWeakRefDeref, reference, []);
      if (root) roots.push(root);
    });
    const fields: Array<HTMLInputElement | HTMLTextAreaElement> = [];
    const textGroups: Array<Array<SearchTextPart | null>> = [];
    const renderedCache = new WeakMap<Element, boolean>();
    const dynamicBoundaryCache = new WeakMap<Element, boolean>();
    let dynamicBoundaryChecks = 0;
    const isRenderedCached = (element: Element): boolean => {
      const cached = renderedCache.get(element);
      if (cached !== undefined) return cached;
      const rendered = isRendered(element);
      renderedCache.set(element, rendered);
      return rendered;
    };
    const isDynamicTextBoundaryElement = (element: Element): boolean | null => {
      if (!allowDynamicPageScripts) return false;
      const cached = dynamicBoundaryCache.get(element);
      if (cached !== undefined) return cached;
      if (dynamicBoundaryChecks >= 2_048) return null;
      dynamicBoundaryChecks += 1;
      const display = readStyleProperty(element, "display");
      const boundary = display === "block"
        || display === "flex"
        || display === "flow-root"
        || display === "grid"
        || display === "list-item"
        || display === "table"
        || nativeApply(nativeIndexOf, display, ["block ", 0]) === 0;
      dynamicBoundaryCache.set(element, boundary);
      return boundary;
    };
    let rootIndex = 0;
    let nodes = 0;
    let complexityUnits = 0;
    while (rootIndex < roots.length) {
      const root = roots[rootIndex++]!;
      observeRoot(root);
      let textGroup: Array<SearchTextPart | null> = [];
      textGroups.push(textGroup);
      let forceBoundary = false;
      let previousBoundary: Element | null | undefined;
      let previousPreserveWhitespace: boolean | undefined;
      const walker = nativeCreateTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
      );
      let node: Node | null;
      while ((node = walker.nextNode())) {
        nodes += 1;
        if (node.nodeType === Node.TEXT_NODE) {
          const textNode = node as Text;
          const textRoot = nativeApply(nativeGetRootNode, textNode, []);
          const parent = textNode.parentElement ?? (
            nativeIsPrototypeOf(ShadowRoot.prototype, textRoot) ? (textRoot as ShadowRoot).host : null
          );
          const parentTag = parent ? toUpperCase(readTagName(parent)) : "";
          const raw = readText(textNode);
          complexityUnits += raw.length;
          if (
            parent
            && parentTag !== "SCRIPT"
            && parentTag !== "STYLE"
            && parentTag !== "TEXTAREA"
            && isRenderedCached(parent)
          ) {
            let boundary: Element | null = null;
            let ancestor: Element | null = parent;
            let depth = 0;
            let boundaryUncertain = false;
            while (ancestor) {
              if (isStaticTextBoundaryElement(ancestor)) {
                boundary = ancestor;
                break;
              }
              const dynamicBoundary = isDynamicTextBoundaryElement(ancestor);
              if (dynamicBoundary === null) {
                boundaryUncertain = true;
                break;
              }
              if (dynamicBoundary) {
                boundary = ancestor;
                break;
              }
              ancestor = ancestor.parentElement;
              depth += 1;
              if (depth > 256) return null;
            }
            const insidePre = Boolean(nativeApply(nativeClosest, parent, ["pre"]));
            const whiteSpace = allowDynamicPageScripts && !insidePre && isWhitespace(raw)
              ? readStyleProperty(parent, "white-space")
              : "";
            const preserveWhitespace = insidePre
              || nativeApply(nativeIndexOf, whiteSpace, ["pre", 0]) === 0
              || whiteSpace === "break-spaces";
            if (
              textGroup.length > 0
              && (
                forceBoundary
                || boundaryUncertain
                || previousBoundary !== boundary
                || previousPreserveWhitespace !== preserveWhitespace
              )
            ) {
              textGroup = [];
              textGroups.push(textGroup);
            }
            forceBoundary = false;
            previousBoundary = boundary;
            previousPreserveWhitespace = preserveWhitespace;
            textGroup.push({ node: textNode, preserveWhitespace });
          }
        } else if (nativeIsPrototypeOf(ElementType.prototype, node)) {
          const element = node as Element;
          complexityUnits += 8;
          if (isStaticTextBoundaryElement(element) && isRenderedCached(element)) forceBoundary = true;
          const openShadowRoot = readOpenShadowRoot(element);
          if (openShadowRoot) roots.push(openShadowRoot);
          if (
            nativeIsPrototypeOf(HTMLInputElement.prototype, element)
            || nativeIsPrototypeOf(HTMLTextAreaElement.prototype, element)
          ) {
            const field = element as HTMLInputElement | HTMLTextAreaElement;
            const fieldValue = readFieldValue(field);
            complexityUnits += fieldValue.length;
            const inputType = field instanceof HTMLInputElement && inputTypeGetter
              ? nativeApply(inputTypeGetter, field, [])
              : field instanceof HTMLInputElement
                ? field.type
                : "textarea";
            if (
              !(field instanceof HTMLInputElement)
              || inputType === "search"
              || inputType === "tel"
              || inputType === "text"
              || inputType === "url"
            ) fields.push(field);
          }
        }
        if (
          nodes > 50_000
          || complexityUnits > 500_000
        ) return null;
      }
    }
    return { fields, textGroups };
  };
  const isRendered = (element: Element): boolean => {
    if (nativeApply(nativeClosest, element, ["[hidden], [inert], [aria-hidden='true']"])) return false;
    return nativeCheckVisibility
      ? nativeApply(nativeCheckVisibility, element, [{ checkOpacity: true, checkVisibilityCSS: true }])
      : true;
  };
  const collectManualMatches = async (
    targets: SearchTargets,
    nextQuery: string,
    isCurrent: () => boolean
  ): Promise<{ cancelled: boolean; matches: ManualSearchMatch[]; truncated: boolean }> => {
    const matches: ManualSearchMatch[] = [];
    const searchPattern = new NativeRegExp(escapeRegExp(nextQuery), "giu");
    let chunkStartedAt = nativeNow();
    let operations = 0;
    let scannedTargets = 0;
    let cancelled = false;
    let truncated = false;
    const yieldIfNeeded = async (counter: number): Promise<boolean> => {
      if (counter % 128 !== 0 || nativeNow() - chunkStartedAt <= 4) return isCurrent();
      await new NativePromise<void>(resolve => nativeSetTimeout(resolve, 0));
      chunkStartedAt = nativeNow();
      return isCurrent();
    };
    const collect = async (
      value: string,
      append: (start: number, end: number) => void
    ): Promise<boolean> => {
      searchPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = nativeApply(nativeRegExpExec, searchPattern, [value]))) {
        const index = match.index;
        const matchLength = match[0].length;
        if (matches.length >= 5_000) {
          truncated = true;
          return false;
        }
        append(index, index + matchLength);
        operations += 1;
        if (!(await yieldIfNeeded(operations))) {
          cancelled = true;
          return false;
        }
      }
      return true;
    };
    const appendTextMatches = async (value: string, segments: FlatTextSegment[]): Promise<boolean> => (
      await collect(value, (start, end) => {
        let startSegment: FlatTextSegment | undefined;
        let endSegment: FlatTextSegment | undefined;
        for (const segment of segments) {
          if (!startSegment && segment.flatEnd > start) startSegment = segment;
          if (segment.flatStart < end) endSegment = segment;
        }
        if (!startSegment || !endSegment) return;
        matches.push({
          endNode: endSegment.node,
          endOffset: endSegment.nodeStart + Math.max(
            0,
            Math.min(endSegment.flatEnd - endSegment.flatStart, end - endSegment.flatStart)
          ),
          kind: "text",
          startNode: startSegment.node,
          startOffset: startSegment.nodeStart + Math.max(0, start - startSegment.flatStart)
        });
      })
    );
    for (const group of targets.textGroups) {
      let value = "";
      const segments: FlatTextSegment[] = [];
      let pendingSpace: { node: Text; offset: number } | null = null;
      for (const part of group) {
        scannedTargets += 1;
        if (!(await yieldIfNeeded(scannedTargets))) {
          cancelled = true;
          break;
        }
        if (part === null) continue;
        const node = part.node;
        const raw = readText(node);
        if (part.preserveWhitespace) {
          const flatStart = value.length;
          value += raw;
          segments.push({
            flatEnd: value.length,
            flatStart,
            node,
            nodeStart: 0
          });
          continue;
        }
        let offset = 0;
        while (offset < raw.length) {
          if (isWhitespace(raw[offset]!)) {
            if (value) pendingSpace = { node, offset };
            offset += 1;
            continue;
          }
          if (pendingSpace && value) {
            const flatStart = value.length;
            value += " ";
            segments.push({
              flatEnd: flatStart + 1,
              flatStart,
              node: pendingSpace.node,
              nodeStart: pendingSpace.offset
            });
            pendingSpace = null;
          }
          const runStart = offset;
          while (offset < raw.length && !isWhitespace(raw[offset]!)) offset += 1;
          const flatStart = value.length;
          value += nativeApply(nativeStringSlice, raw, [runStart, offset]);
          segments.push({
            flatEnd: value.length,
            flatStart,
            node,
            nodeStart: runStart
          });
        }
      }
      if (truncated || cancelled) break;
      if (!(await appendTextMatches(value, segments))) break;
    }
    if (!truncated && !cancelled) {
      for (const field of targets.fields) {
        scannedTargets += 1;
        if (!(await yieldIfNeeded(scannedTargets))) {
          cancelled = true;
          break;
        }
        const fieldValue = readFieldValue(field);
        if (!isRendered(field)) continue;
        if (!(await collect(fieldValue, (start, end) => matches.push({ end, field, kind: "field", start })))) break;
      }
    }
    const matchNode = (match: ManualSearchMatch): Node => (
      match.kind === "field" ? match.field : match.startNode
    );
    const composedAnchor = (node: Node): Node => {
      let anchor = node;
      let root = nativeApply(nativeGetRootNode, anchor, []);
      while (nativeIsPrototypeOf(ShadowRoot.prototype, root)) {
        anchor = (root as ShadowRoot).host;
        root = nativeApply(nativeGetRootNode, anchor, []);
      }
      return anchor;
    };
    nativeApply(nativeArraySort, matches, [(left: ManualSearchMatch, right: ManualSearchMatch) => {
      const leftNode = matchNode(left);
      const rightNode = matchNode(right);
      const leftRoot = nativeApply(nativeGetRootNode, leftNode, []);
      const rightRoot = nativeApply(nativeGetRootNode, rightNode, []);
      const comparableLeft = leftRoot === rightRoot ? leftNode : composedAnchor(leftNode);
      const comparableRight = leftRoot === rightRoot ? rightNode : composedAnchor(rightNode);
      if (comparableLeft === comparableRight) return 0;
      const position = nativeApply(nativeCompareDocumentPosition, comparableLeft, [comparableRight]);
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    }]);
    return { cancelled, matches, truncated };
  };
  const revealManualMatch = (match: ManualSearchMatch): boolean => {
    try {
      getSelection()?.removeAllRanges();
      if (match.kind === "field") {
        nativeApply(
          match.field instanceof HTMLInputElement
            ? nativeInputSetSelectionRange
            : nativeTextareaSetSelectionRange,
          match.field,
          [match.start, match.end]
        );
        nativeApply(nativeScrollIntoView, match.field, [{ block: "center", inline: "nearest" }]);
        nativeApply(nativeAnimate, match.field, [[
          { outline: "3px solid Highlight", outlineOffset: "2px" },
          { outline: "3px solid transparent", outlineOffset: "2px" }
        ], { duration: 1_200, easing: "ease-out" }]);
        return true;
      }
      const range = nativeCreateRange();
      range.setStart(match.startNode, match.startOffset);
      range.setEnd(match.endNode, match.endOffset);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const root = nativeApply(nativeGetRootNode, match.startNode, []);
      const parent = match.startNode.parentElement ?? (
        nativeIsPrototypeOf(ShadowRoot.prototype, root) ? (root as ShadowRoot).host : null
      );
      if (parent) {
        nativeApply(nativeScrollIntoView, parent, [{ block: "center", inline: "nearest" }]);
      }
      return true;
    } catch {
      return false;
    }
  };
  const runManualSearch = async (
    targets: SearchTargets,
    nextQuery: string,
    direction: "current" | "next" | "previous",
    changed: boolean,
    requestId: number,
    runId: number
  ): Promise<void> => {
    const isCurrent = (): boolean => (
      manualSearchRunId === runId
      && latestSearchRequestId === requestId
      && query === nextQuery
    );
    const { cancelled, matches } = await collectManualMatches(targets, nextQuery, isCurrent);
    if (cancelled || !isCurrent()) return;
    const reset = changed
      || lastManualRevision !== manualRevision
      || manualIndex < 0
      || manualIndex >= matches.length;
    if (matches.length === 0) {
      manualIndex = -1;
      lastManualRevision = manualRevision;
      found = false;
    } else {
      if (reset) manualIndex = direction === "previous" ? matches.length - 1 : 0;
      else if (direction === "previous") manualIndex = (manualIndex - 1 + matches.length) % matches.length;
      else if (direction === "next") manualIndex = (manualIndex + 1) % matches.length;
      const revealed = revealManualMatch(matches[manualIndex]!);
      lastManualRevision = manualRevision;
      found = revealed;
    }
    post({
      type: "html-studio-search-result",
      requestId,
      query: nextQuery,
      found,
      current: found ? manualIndex + 1 : 0,
      total: matches.length,
      countComplete: false,
      countReliable: false,
      searchLimited: true
    });
  };
  const runSearch = async (
    nextQuery: string,
    direction: "current" | "next" | "previous",
    requestId: number
  ): Promise<void> => {
    latestSearchRequestId = requestId;
    const runId = ++manualSearchRunId;
    const changed = nextQuery !== query;
    query = nextQuery;
    if (!query) {
      found = false;
      getSelection()?.removeAllRanges();
      post({
        type: "html-studio-search-result",
        requestId,
        query,
        found: false,
        current: 0,
        total: 0,
        countComplete: true,
        countReliable: true
      });
      return;
    }
    if (changed) {
      found = false;
      getSelection()?.removeAllRanges();
    }
    const targets = collectSearchTargets();
    if (!targets) {
      found = false;
      post({
        type: "html-studio-search-result",
        requestId,
        query,
        found: false,
        current: 0,
        total: 0,
        countComplete: false,
        countReliable: false,
        searchLimited: true
      });
      return;
    }
    if (allowDynamicPageScripts) {
      await runManualSearch(targets, query, direction, changed, requestId, runId);
      return;
    }
    const backwards = direction === "previous";
    found = nativeFind(query, false, backwards, true, false, false, false);
    post({
      type: "html-studio-search-result",
      requestId,
      query,
      found,
      current: 0,
      total: 0,
      countComplete: false,
      countReliable: false
    });
  };
  const onMessage = (event: MessageEvent<unknown>): void => {
    const data = event.data as Partial<SearchBridgeMessage> & { direction?: string };
    if (!data || data.channel !== channel) return;
    if (data.type === "html-studio-page-state-restore") {
      const x = Number.isFinite(data.scrollX) ? Math.max(0, Math.min(10_000_000, Math.floor(data.scrollX!))) : 0;
      const y = Number.isFinite(data.scrollY) ? Math.max(0, Math.min(10_000_000, Math.floor(data.scrollY!))) : 0;
      nativeScrollTo(x, y);
      nativeRequestAnimationFrame(() => {
        nativeScrollTo(x, y);
        sendState("html-studio-page-state-restored");
      });
      return;
    }
    if (data.type === "html-studio-page-state-request") {
      sendState();
      return;
    }
    if (data.type !== "html-studio-search") return;
    const next = typeof data.query === "string" ? data.query.slice(0, 500) : "";
    const direction = data.direction === "previous" ? "previous" : data.direction === "next" ? "next" : "current";
    const requestId = Number.isSafeInteger(data.requestId) && data.requestId! >= 0 ? data.requestId! : 0;
    void runSearch(next, direction, requestId).catch(() => {
      if (latestSearchRequestId !== requestId || query !== next) return;
      found = false;
      post({
        type: "html-studio-search-result",
        requestId,
        query: next,
        found: false,
        current: 0,
        total: 0,
        countComplete: false,
        countReliable: false,
        searchLimited: true
      });
    });
  };
  const connect = (): void => {
    port?.close();
    const pair = new Channel();
    port = pair.port1;
    port.addEventListener("message", onMessage);
    port.start();
    parent.postMessage({ channel, type: "html-studio-search-ready" }, "*", [pair.port2]);
    sendState();
  };
  const observe = (): void => {
    if (document.documentElement) observeRoot(document.documentElement);
  };
  const notifyStateChange = (): void => {
    nativeSetTimeout(() => sendState(), 0);
  };
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  history.pushState = function(...args): void {
    originalPushState(...args);
    notifyStateChange();
  };
  history.replaceState = function(...args): void {
    originalReplaceState(...args);
    notifyStateChange();
  };
  addEventListener("hashchange", notifyStateChange);
  addEventListener("popstate", notifyStateChange);
  addEventListener("scroll", () => {
    if (scrollTimer) return;
    scrollTimer = nativeSetTimeout(() => {
      scrollTimer = 0;
      sendState();
    }, 120);
  }, { passive: true });
  addEventListener("input", invalidateSearch, true);
  addEventListener("change", invalidateSearch, true);
  addEventListener("pagehide", () => {
    sendState();
    post({ type: "html-studio-search-leaving" });
    port?.close();
  });
  addEventListener("click", event => {
    const link = event.target instanceof ElementType
      ? event.target.closest<HTMLAnchorElement>("a[href]")
      : null;
    if (!link || link.target && link.target !== "_self") return;
    try {
      const next = new URL(link.href, location.href);
      if (next.origin !== location.origin || next.pathname !== location.pathname || next.search !== location.search) {
        post({ type: "html-studio-search-leaving" });
      }
    } catch {
      post({ type: "html-studio-search-leaving" });
    }
  }, true);
  addEventListener("keydown", event => {
    const legacyKeyCode = (event as unknown as { keyCode?: number }).keyCode;
    if (event.isComposing || legacyKeyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
      event.preventDefault();
      post({ type: "html-studio-search-open" });
    }
  }, true);
  observe();
  connect();
  if (document.readyState === "loading") {
    addEventListener("DOMContentLoaded", () => {
      observe();
      invalidateSearch();
    }, { once: true });
  }
  addEventListener("load", () => nativeSetTimeout(() => {
    observe();
    found = false;
    connect();
  }, 0), { once: true, capture: true });
}
/* eslint-enable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- End isolated search-bridge runtime. */

function findSearchBridgeInsertionOffset(source: Buffer): number {
  const byteOrderMarkEnd = source.length >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf
    ? 3
    : 0;
  let insertionOffset = byteOrderMarkEnd;
  let cursor = skipHtmlSpaceAndComments(source, byteOrderMarkEnd);
  if (cursor === null) return insertionOffset;

  if (matchesTagStart(source, cursor, "<!doctype")) {
    const doctypeEnd = findMarkupEnd(source, cursor + "<!doctype".length);
    if (doctypeEnd === null) return insertionOffset;
    insertionOffset = doctypeEnd;
    cursor = skipHtmlSpaceAndComments(source, doctypeEnd);
    if (cursor === null) return insertionOffset;
  }

  if (matchesTagStart(source, cursor, "<html")) {
    const htmlEnd = findMarkupEnd(source, cursor + "<html".length);
    if (htmlEnd === null) return insertionOffset;
    insertionOffset = htmlEnd;
    cursor = skipHtmlSpaceAndComments(source, htmlEnd);
    if (cursor === null) return insertionOffset;
  }

  if (matchesTagStart(source, cursor, "<head")) {
    const headEnd = findMarkupEnd(source, cursor + "<head".length);
    if (headEnd !== null) insertionOffset = headEnd;
  }
  return insertionOffset;
}

function skipHtmlSpaceAndComments(source: Buffer, start: number): number | null {
  let cursor = start;
  while (cursor < source.length) {
    while (cursor < source.length && isHtmlSpace(source[cursor])) cursor += 1;
    if (!matchesAsciiCaseInsensitive(source, cursor, "<!--")) return cursor;
    const commentEnd = source.indexOf(Buffer.from("-->", "ascii"), cursor + 4);
    if (commentEnd < 0) return null;
    cursor = commentEnd + 3;
  }
  return cursor;
}

function findMarkupEnd(source: Buffer, start: number): number | null {
  let quote = 0;
  for (let index = start; index < source.length; index += 1) {
    const value = source[index]!;
    if (quote !== 0) {
      if (value === quote) quote = 0;
      continue;
    }
    if (value === 0x22 || value === 0x27) {
      quote = value;
      continue;
    }
    if (value === 0x3e) return index + 1;
  }
  return null;
}

function matchesTagStart(source: Buffer, offset: number, expected: string): boolean {
  if (!matchesAsciiCaseInsensitive(source, offset, expected)) return false;
  const next = source[offset + expected.length];
  return next === undefined || isHtmlSpace(next) || next === 0x2f || next === 0x3e;
}

function isHtmlSpace(value: number | undefined): boolean {
  return value === 0x09 || value === 0x0a || value === 0x0c || value === 0x0d || value === 0x20;
}

function matchesAsciiCaseInsensitive(source: Buffer, offset: number, expected: string): boolean {
  if (offset + expected.length > source.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const actual = source[offset + index]!;
    const normalized = actual >= 0x41 && actual <= 0x5a ? actual + 0x20 : actual;
    if (normalized !== expected.charCodeAt(index)) return false;
  }
  return true;
}
