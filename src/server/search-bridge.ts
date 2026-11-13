import { scanHtmlDocument } from "../scope/bounded-html-parser";
import { createHash } from "node:crypto";
import type { DeckState } from "../presentation/deck-state";
import { MAX_HTML_PREVIEW_BYTES } from "./preview-limits";
import { createDeckAdapters, type AdapterSnapshot } from "./deck-adapters";

export const MAX_SEARCH_BRIDGE_HTML_BYTES = MAX_HTML_PREVIEW_BYTES;

export interface SearchBridgeMessage {
  channel: string;
  documentRevision?: string;
  deck?: DeckState | null;
  page?: number;
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
  searchDeck?: boolean;
  matchPages?: number[];
  targetPage?: number;
  navigationFailed?: boolean;
  searchLimited?: boolean;
  total?: number;
  truncatedReason?: "active-time" | "characters" | "document-size" | "dom-changed" | "matches" | "nodes" | "wall-time" | "unloaded-pages";
  type:
    | "html-studio-deck-go"
    | "html-studio-fullscreen-exit"
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
  const script = createPageBridgeScript(source, nonce, channel, allowDynamicPageScripts);
  const insertionOffset = findHtmlHeadInsertionOffset(source);
  return Buffer.concat(
    [source.subarray(0, insertionOffset), script, source.subarray(insertionOffset)],
    source.byteLength + script.byteLength
  );
}

/** Page control does not require decoding/scanning embedded media as HTML text. */
export function createPageBridgeScript(source: Buffer, nonce: string, channel: string, allowDynamicPageScripts: boolean): Buffer {
  const searchEnabled = source.byteLength <= MAX_SEARCH_BRIDGE_HTML_BYTES;
  const hasDeclarativeClosedShadowRoot = searchEnabled && mayDeclareShadowRoot(source) && scanHtmlDocument(source.toString("utf8"), {
    maxCharacters: source.length,
    maxPageScripts: 0,
    maxReferences: 0
  }).hasDeclarativeClosedShadowRoot;
  return Buffer.from(
    `<script nonce="${nonce}">document.currentScript?.remove();if(parent===top){${buildSearchBridgeSource(channel, hasDeclarativeClosedShadowRoot, allowDynamicPageScripts, createHash("sha256").update(source).digest("hex"), searchEnabled)}}</script>`,
    "utf8"
  );
}

// HTML attribute names are ASCII case-insensitive. A bounded, overlapping
// prefilter avoids decoding/copying all embedded media just to rule out this
// uncommon attribute. Positive candidates still use the full HTML parser.
function mayDeclareShadowRoot(source: Buffer): boolean {
  const chunkBytes = 64 * 1024;
  const overlap = "shadowrootmode".length - 1;
  for (let start = 0; start < source.length; start += chunkBytes) {
    if (/shadowrootmode/i.test(source.toString("latin1", start, Math.min(source.length, start + chunkBytes + overlap)))) return true;
  }
  return false;
}

function buildSearchBridgeSource(
  channel: string,
  hasDeclarativeClosedShadowRoot: boolean,
  allowDynamicPageScripts: boolean,
  documentRevision: string,
  searchEnabled: boolean
): string {
  return `(${searchBridgeRuntime.toString()})(${JSON.stringify(channel)},${JSON.stringify(hasDeclarativeClosedShadowRoot)},${JSON.stringify(allowDynamicPageScripts)},${JSON.stringify(documentRevision)},${JSON.stringify(searchEnabled)},(${createDeckAdapters.toString().replace(/[\u0080-\uFFFF]/g, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"))}))`;
}

// The bridge deliberately snapshots unbound DOM intrinsics before user scripts run.
/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- DOM intrinsics are captured unbound, then invoked with their verified receiver through the pre-captured Reflect.apply. */
function searchBridgeRuntime(
  channel: string,
  hasDeclarativeClosedShadowRoot: boolean,
  allowDynamicPageScripts: boolean,
  documentRevision: string,
  searchEnabled: boolean,
  adapterFactory: typeof createDeckAdapters
): void {
  "use strict";
  const Channel = MessageChannel;
  const Observer = MutationObserver;
  const ElementType = Element;
  const NativePromise = Promise;
  const NativeKeyboardEvent = KeyboardEvent;
  const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
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
  const nativeStringify = JSON.stringify.bind(JSON);
  const nativeScrollIntoView = ElementType.prototype.scrollIntoView;
  const nativeElementScrollBy = ElementType.prototype.scrollBy;
  const nativeElementRect = ElementType.prototype.getBoundingClientRect;
  const nativeRangeRect = Range.prototype.getBoundingClientRect;
  const nativeInputSetSelectionRange = HTMLInputElement.prototype.setSelectionRange;
  const nativeGetStyleProperty = CSSStyleDeclaration.prototype.getPropertyValue;
  const nativeTextareaSetSelectionRange = HTMLTextAreaElement.prototype.setSelectionRange;
  const nativeSetTimeout = window.setTimeout.bind(window) as (callback: () => void, delay?: number) => number;
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeRequestAnimationFrame = requestAnimationFrame.bind(window);
  const nativeGetAttribute = ElementType.prototype.getAttribute;
  const nativeGetElementById = document.getElementById.bind(document);
  const nativeTextContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")?.get;
  const NativeRegExp = RegExp;
  const nativeRegExpExec = RegExp.prototype.exec;
  const nativeRegExpTest = RegExp.prototype.test;
  const nativeScrollTo = scrollTo.bind(window);
  const nativeToLocaleUpperCase = String.prototype.toLocaleUpperCase;
  const nativeStringSlice = String.prototype.slice;
  const nativeWeakRefDeref = WeakRef.prototype.deref;
  // Selection is invisible in decks using user-select:none and when the host
  // search box retains focus. Paint a range without changing the document text.
  const NativeHighlight = typeof Highlight === "function" ? Highlight : null;
  const highlightRegistry = typeof CSS === "object" ? CSS.highlights : undefined;
  const nativeSetHighlight = highlightRegistry?.set.bind(highlightRegistry);
  const nativeDeleteHighlight = highlightRegistry?.delete.bind(highlightRegistry);
  const highlightName = `html-studio-search-${channel}`;
  if (NativeHighlight && highlightRegistry) {
    const style = new CSSStyleSheet();
    style.replaceSync(`::highlight(${highlightName}){background-color:#ffe16a;color:#171717;text-shadow:none}`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, style];
  }
  const clearHighlight = (): void => { nativeDeleteHighlight?.(highlightName); };
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
  let manualSearchRunId = 0;
  let manualRefreshTimer = 0;
  let lastManualMatch: ManualSearchMatch | null = null;
  let navigatingSearchRun = 0;
  let scrollTimer = 0;
  let deckTimer = 0;
  let lastReportedDeck = "";
  let lastStableDeck: DeckState | null = null;
  let missingDeckSince = 0;
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
  type DeckSnapshot = { state: DeckState; elements: Element[]; navigation: "hash" | "keyboard" } | AdapterSnapshot;
  const readAdapters = adapterFactory();
  // Both adapters are bounded and observe the author's state; they never add IDs
  // or change active classes. Numeric keyboard decks require a matching counter.
  const readLegacyDeckSnapshot = (): DeckSnapshot | null => {
    if (!allowDynamicPageScripts || !document.body) return null;
    const walker = nativeCreateTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    const slides = new Map<number, Element>();
    let slidePrefix: string | undefined;
    const ordered: Element[] = [];
    const stage = nativeGetElementById("stage");
    const viewport = nativeGetElementById("viewport");
    const started = nativeNow();
    let visited = 0;
    while (walker.nextNode()) {
      if (++visited > 15_000 || (visited % 100 === 0 && nativeNow() - started > 12)) return null;
      const element = walker.currentNode as Element;
      const id = nativeApply(nativeGetAttribute, element, ["id"]);
      const className = nativeApply(nativeGetAttribute, element, ["class"]);
      if (!className?.split(/\s+/).includes("slide")) continue;
      if (!id && stage && viewport && stage.parentElement === viewport && element.parentElement === stage) {
        ordered.push(element);
        if (ordered.length > 500) return null;
      }
      const numberedId = id ? /^(p|slide-)(\d{1,3})$/i.exec(id) : null;
      if (!numberedId) continue;
      const prefix = numberedId[1]!.toLowerCase();
      if (slidePrefix && slidePrefix !== prefix) return null;
      slidePrefix = prefix;
      const number = Number(numberedId[2]);
      if (number < 1 || number > 500 || slides.has(number)) return null;
      slides.set(number, element);
    }
    const navigation = slides.size ? "hash" : "keyboard";
    if (navigation === "keyboard") {
      const counter = nativeGetElementById("curno"), total = nativeGetElementById("totno");
      if (!counter || !total || !nativeTextContent || !/^(?:#[1-9]\d{0,2})?$/.test(location.hash)) return null;
      const totalText = String(nativeApply(nativeTextContent, total, [])).trim();
      if (!/^[1-9]\d{0,2}$/.test(totalText) || Number(totalText) !== ordered.length) return null;
      ordered.forEach((element, index) => slides.set(index + 1, element));
    }
    if (slides.size < 2 || slides.size > 500) return null;
    const pages: DeckState["pages"] = [];
    const elements: Element[] = [];
    let current = 0;
    for (let number = 1; number <= slides.size; number += 1) {
      const element = slides.get(number);
      if (!element) return null;
      elements.push(element);
      const id = nativeApply(nativeGetAttribute, element, ["id"]) as string;
      const className = nativeApply(nativeGetAttribute, element, ["class"]) as string;
      const ariaHidden = nativeApply(nativeGetAttribute, element, ["aria-hidden"]);
      if (ariaHidden === "false" || className.split(/\s+/).includes("active")) {
        if (current) return null;
        current = number;
      }
      const headingWalker = nativeCreateTreeWalker(element, NodeFilter.SHOW_ELEMENT);
      let heading: Element | null = null;
      let headingSteps = 0;
      while (headingWalker.nextNode() && ++headingSteps <= 100) {
        const candidate = headingWalker.currentNode as Element;
        if (["H1", "H2", "H3"].includes(readTagName(candidate))) { heading = candidate; break; }
      }
      const title = heading && nativeTextContent ? String(nativeApply(nativeTextContent, heading, [])) : "";
      pages.push({ hash: navigation === "hash" ? `#${id}` : `#${number}`, title: title.replace(/\s+/g, " ").trim().slice(0, 160) });
      if (nativeNow() - started > 20) return null;
    }
    if (!current) return null;
    if (navigation === "keyboard") {
      const counter = nativeGetElementById("curno")!;
      if (String(nativeApply(nativeTextContent!, counter, [])).trim() !== String(current)) return null;
    }
    return { state: { current, pages }, elements, navigation };
  };
  const readDeckSnapshot = (): DeckSnapshot | null => {
    if (!allowDynamicPageScripts) return null;
    return readLegacyDeckSnapshot() ?? readAdapters();
  };
  const readDeckState = (): DeckState | null => readDeckSnapshot()?.state ?? null;
  let deckNavigationRun = 0;
  let readingRestoreRun = 0;
  const navigateDeckTo = async (target: number, stillCurrent: () => boolean = () => true): Promise<void> => {
    const run = ++deckNavigationRun;
    const initial = readDeckSnapshot();
    if (!initial || !Number.isSafeInteger(target) || target < 1 || target > initial.state.pages.length) return;
    if (initial.navigation === "observe") return;
    if (initial.navigation === "hash") {
      const hash = initial.state.pages[target - 1]!.hash;
      if (location.hash !== hash) location.hash = hash;
      return;
    }
    const deadline = nativeNow() + 2_400;
    let first = true;
    while (run === deckNavigationRun && stillCurrent() && nativeNow() < deadline) {
      const deck = readDeckSnapshot();
      if (!deck || deck.navigation === "observe" || deck.navigation === "hash" || deck.state.pages.length !== initial.state.pages.length) return;
      const current = deck.state.current;
      if (current === target) return;
      let key = target > current ? "ArrowRight" : "ArrowLeft";
      if (first && target - 1 < Math.abs(target - current)) key = "Home";
      if (first && deck.state.pages.length - target < Math.min(target - 1, Math.abs(target - current))) key = "End";
      first = false;
      if (deck.navigation === "adapter") deck.go?.(target);
      else nativeApply(nativeDispatchEvent, document, [new NativeKeyboardEvent("keydown", { key, bubbles: true, cancelable: true })]);
      // Yield between author-controlled steps and stop if the author ignores a key.
      const stepDeadline = Math.min(deadline, nativeNow() + (deck.navigation === "adapter" ? 700 : 240));
      let changed = false;
      do {
        await new NativePromise<void>(resolve => nativeSetTimeout(resolve, 0));
        if (run !== deckNavigationRun || !stillCurrent()) return;
        const next = readDeckSnapshot();
        if (next && next.state.current !== current) { changed = true; break; }
        await new NativePromise<void>(resolve => nativeSetTimeout(resolve, 20));
      } while (nativeNow() < stepDeadline);
      if (!changed) return;
    }
  };
  const sendState = (type: SearchBridgeMessage["type"] = "html-studio-page-state", deck = readDeckState()): void => {
    // A cross-fade briefly exposes two pages. Keep the sidebar on the last
    // confirmed page until the animation settles; never use this grace state
    // for navigation acknowledgements or search hit validation.
    if (!deck && lastStableDeck && type === "html-studio-page-state") {
      if (!missingDeckSince) missingDeckSince = nativeNow();
      if (nativeNow() - missingDeckSince < 1_500) { scheduleDeckState(); return; }
    }
    lastStableDeck = deck;
    if (deck) missingDeckSince = 0;
    lastReportedDeck = nativeStringify(deck);
    post({
      type,
      deck,
      documentRevision,
      pathname: location.pathname.slice(0, 4_096),
      search: location.search.slice(0, 4_096),
      hash: location.hash.slice(0, 4_096),
      page: deck?.adapter && deck.canNavigate ? deck.current : undefined,
      scrollX: Math.max(0, Math.floor(scrollX)),
      scrollY: Math.max(0, Math.floor(scrollY))
    });
  };
  // Hash changes can precede a deck's animation/render. Observe the actual slide
  // state too, coalescing bursts and avoiding repeated sidebar/output updates.
  const scheduleDeckState = (): void => {
    if (!allowDynamicPageScripts || deckTimer) return;
    deckTimer = nativeSetTimeout(() => {
      deckTimer = 0;
      const deck = readDeckState();
      if (nativeStringify(deck) !== lastReportedDeck) sendState("html-studio-page-state", deck);
    }, 80);
  };
  const invalidateSearch = (): void => {
    if (!query) return;
    if (navigatingSearchRun) return;
    manualSearchRunId += 1;
    if (allowDynamicPageScripts) {
      // Coalesce changes without moving the user's current match. A clock or
      // animation elsewhere in the page must not reset every Next to result 1.
      if (!manualRefreshTimer) manualRefreshTimer = nativeSetTimeout(() => {
        manualRefreshTimer = 0;
        if (query) requestSearch(query, "current", latestSearchRequestId, true);
      }, 120);
      return;
    }
    found = false;
    clearHighlight();
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
    new Observer(records => {
      invalidateSearch();
      if (!allowDynamicPageScripts) return;
      if (records.length > 200 || records.some(record => {
        if (record.type === "childList") return true;
        const element = nativeIsPrototypeOf(ElementType.prototype, record.target) ? record.target as Element : record.target.parentElement;
        if (!element) return false;
        return true;
      })) scheduleDeckState();
    }).observe(root, {
      attributeFilter: ["aria-hidden", "class", "hidden", "id", "inert", "style", "value"],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
  };
  type SearchTextPart = { node: Text; preserveWhitespace: boolean };
  type SearchTargets = {
    deck: DeckState | null;
    slides: Map<Element, number>;
    fields: Array<HTMLInputElement | HTMLTextAreaElement>;
    textGroups: Array<Array<SearchTextPart | null>>;
    incomplete: boolean;
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
  const sameManualMatch = (left: ManualSearchMatch, right: ManualSearchMatch): boolean => {
    if (left.kind === "field" && right.kind === "field") {
      return left.field === right.field && left.start === right.start && left.end === right.end;
    }
    return left.kind === "text" && right.kind === "text"
      && left.startNode === right.startNode && left.startOffset === right.startOffset
      && left.endNode === right.endNode && left.endOffset === right.endOffset;
  };
  const matchElement = (match: ManualSearchMatch): Element | null => (
    match.kind === "field" ? match.field : match.startNode.parentElement
  );
  const matchSlide = (match: ManualSearchMatch, targets: SearchTargets): Element | null => {
    let element = matchElement(match);
    for (let depth = 0; element && depth < 256; depth++, element = element.parentElement) {
      if (targets.slides.has(element)) return element;
    }
    return null;
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
  const collectSearchTargets = async (isCurrent: () => boolean): Promise<SearchTargets | null> => {
    const documentRoot = document.documentElement;
    if (!documentRoot || hasDeclarativeClosedShadowRoot || closedShadowOverflow) return null;
    const roots: Node[] = [documentRoot];
    trackedClosedShadowRoots.forEach(reference => {
      const root = nativeApply(nativeWeakRefDeref, reference, []);
      if (root) roots.push(root);
    });
    const fields: Array<HTMLInputElement | HTMLTextAreaElement> = [];
    const textGroups: Array<Array<SearchTextPart | null>> = [];
    const snapshot = readDeckSnapshot();
    const deck = snapshot?.state ?? null;
    const slides = new Map<Element, number>();
    snapshot?.elements.forEach((element, index) => { if (element) slides.set(element, index + 1); });
    const renderedCache = new WeakMap<Element, boolean>();
    const dynamicBoundaryCache = new WeakMap<Element, boolean>();
    let dynamicBoundaryChecks = 0;
    const isRenderedCached = (element: Element): boolean => {
      const cached = renderedCache.get(element);
      if (cached !== undefined) return cached;
      let slide: Element | null = element;
      for (let depth = 0; slide && !slides.has(slide) && depth < 256; depth++) slide = slide.parentElement;
      if (slide && !slides.has(slide)) slide = null;
      let rendered: boolean;
      if (slide && slides.has(slide)) {
        // A slide's display/opacity/aria-hidden are navigation state, not a
        // reason to omit its text from document search. Keep nested hidden
        // controls excluded and verify visibility after navigating to a match.
        let ancestor: Element | null = element;
        let depth = 0;
        rendered = true;
        while (ancestor && ancestor !== slide) {
          const cachedAncestor = renderedCache.get(ancestor);
          if (cachedAncestor !== undefined) { rendered = cachedAncestor; break; }
          if (++depth > 256 || nativeApply(nativeGetAttribute, ancestor, ["hidden"]) !== null
            || nativeApply(nativeGetAttribute, ancestor, ["inert"]) !== null
            || nativeApply(nativeGetAttribute, ancestor, ["aria-hidden"]) === "true"
            || readStyleProperty(ancestor, "display") === "none"
            || (readStyleProperty(ancestor, "visibility") === "hidden"
              && readStyleProperty(slide, "visibility") !== "hidden")) { rendered = false; break; }
          ancestor = ancestor.parentElement;
        }
      } else rendered = isRendered(element);
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
    const started = nativeNow();
    let chunkStarted = started;
    let activeMs = 0;
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
        if (nodes > 50_000 || nativeNow() - started > 2_000) return null;
        if (nodes % 128 === 0 && nativeNow() - chunkStarted >= 4) {
          activeMs += nativeNow() - chunkStarted;
          if (activeMs > 250 || !isCurrent()) return null;
          await new NativePromise<void>(resolve => nativeSetTimeout(resolve, 0));
          chunkStarted = nativeNow();
          if (!isCurrent()) return null;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          const textNode = node as Text;
          const textRoot = nativeApply(nativeGetRootNode, textNode, []);
          const parent = textNode.parentElement ?? (
            nativeIsPrototypeOf(ShadowRoot.prototype, textRoot) ? (textRoot as ShadowRoot).host : null
          );
          const parentTag = parent ? toUpperCase(readTagName(parent)) : "";
          if (["SCRIPT", "STYLE", "TEXTAREA"].includes(parentTag)) continue;
          const raw = readText(textNode);
          if (parent && isRenderedCached(parent)) {
            complexityUnits += raw.length;
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
            ) {
              if (isRenderedCached(field)) fields.push(field);
            }
          }
        }
        if (complexityUnits > 2 * 1024 * 1024) return null;
      }
    }
    return { deck, slides, fields, textGroups, incomplete: Boolean(snapshot?.elements.some(element => !element)) };
  };
  const renderedBox = (element: Element): Element | null => {
    let box: Element | null = element;
    let depth = 0;
    while (box && readStyleProperty(box, "display") === "contents") {
      if (++depth > 256 || ["hidden", "collapse"].includes(readStyleProperty(box, "visibility"))) return null;
      box = box.parentElement;
    }
    return box;
  };
  const isRendered = (element: Element): boolean => {
    if (nativeApply(nativeClosest, element, ["[hidden], [inert], [aria-hidden='true']"])) return false;
    const box = renderedBox(element);
    if (!box) return false;
    return nativeCheckVisibility
      ? nativeApply(nativeCheckVisibility, box, [{ checkOpacity: true, checkVisibilityCSS: true }])
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
        // Segments are ordered. Binary lookup keeps repeated words in a long
        // paragraph from rescanning every preceding character for each match.
        let low = 0, high = segments.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (segments[middle]!.flatEnd <= start) low = middle + 1;
          else high = middle;
        }
        const startSegment = segments[low];
        low = 0; high = segments.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (segments[middle]!.flatStart < end) low = middle + 1;
          else high = middle;
        }
        const endSegment = segments[low - 1];
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
        let nextYieldOffset = 8_192;
        while (offset < raw.length) {
          if (offset >= nextYieldOffset) {
            nextYieldOffset = offset + 8_192;
            if (!(await yieldIfNeeded(128))) { cancelled = true; break; }
          }
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
        if (!isRendered(field) && !matchSlide({ kind: "field", field, start: 0, end: 0 }, targets)) continue;
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
  const revealManualMatch = (match: ManualSearchMatch, scroll = true): boolean => {
    try {
      clearHighlight();
      getSelection()?.removeAllRanges();
      if (match.kind === "field") {
        nativeApply(
          match.field instanceof HTMLInputElement
            ? nativeInputSetSelectionRange
            : nativeTextareaSetSelectionRange,
          match.field,
          [match.start, match.end]
        );
        if (scroll) nativeApply(nativeScrollIntoView, match.field, [{ block: "center", inline: "nearest", behavior: "instant" }]);
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
      if (NativeHighlight) nativeSetHighlight?.(highlightName, new NativeHighlight(range));
      const root = nativeApply(nativeGetRootNode, match.startNode, []);
      const parent = match.startNode.parentElement ?? (
        nativeIsPrototypeOf(ShadowRoot.prototype, root) ? (root as ShadowRoot).host : null
      );
      if (parent && scroll) {
        const box = renderedBox(parent);
        if (box) nativeApply(nativeScrollIntoView, box, [{ block: "center", inline: "nearest", behavior: "instant" }]);
        // Centering a paragraph can leave its last matching line thousands of
        // pixels away. Reveal the range itself through nested scroll containers.
        let ancestor: Element | null = box;
        let depth = 0;
        while (ancestor && ancestor !== document.body && ancestor !== document.documentElement && ++depth <= 256) {
          const rect = nativeApply(nativeRangeRect, range, []);
          const bounds = nativeApply(nativeElementRect, ancestor, []);
          const top = bounds.top + ancestor.clientTop;
          const left = bounds.left + ancestor.clientLeft;
          const deltaY = /^(auto|scroll)$/.test(readStyleProperty(ancestor, "overflow-y"))
            && (rect.top < top || rect.bottom > top + ancestor.clientHeight)
            ? rect.top + rect.height / 2 - top - ancestor.clientHeight / 2 : 0;
          const deltaX = /^(auto|scroll)$/.test(readStyleProperty(ancestor, "overflow-x"))
            && (rect.left < left || rect.right > left + ancestor.clientWidth)
            ? rect.left + rect.width / 2 - left - ancestor.clientWidth / 2 : 0;
          if (deltaX || deltaY) nativeApply(nativeElementScrollBy, ancestor, [{ left: deltaX, top: deltaY, behavior: "instant" }]);
          ancestor = ancestor.parentElement;
        }
        const rect = nativeApply(nativeRangeRect, range, []);
        const x = rect.left < 0 || rect.right > innerWidth ? scrollX + rect.left + rect.width / 2 - innerWidth / 2 : scrollX;
        const y = rect.top < 0 || rect.bottom > innerHeight ? scrollY + rect.top + rect.height / 2 - innerHeight / 2 : scrollY;
        nativeScrollTo({ left: x, top: y, behavior: "instant" });
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
    runId: number,
    refresh: boolean,
    requestedPage?: number
  ): Promise<void> => {
    const isCurrent = (): boolean => (
      manualSearchRunId === runId
      && latestSearchRequestId === requestId
      && query === nextQuery
    );
    const { cancelled, matches, truncated } = await collectManualMatches(targets, nextQuery, isCurrent);
    if (cancelled || !isCurrent()) return;
    const pageOf = (match: ManualSearchMatch): number | undefined => targets.slides.get(matchSlide(match, targets)!);
    // Deck navigation is by matching page, not by every repeated word on it.
    const matchPages = [...new Set(matches.map(pageOf).filter((page): page is number => page !== undefined))].sort((a, b) => a - b);
    const previous = changed || !lastManualMatch ? -1 : matches.findIndex(match => sameManualMatch(match, lastManualMatch!));
    const reset = previous < 0;
    if (matches.length === 0) {
      manualIndex = -1;
      lastManualMatch = null;
      clearHighlight();
      getSelection()?.removeAllRanges();
      found = false;
    } else {
      if (reset) {
        manualIndex = direction === "previous" ? matches.length - 1 : 0;
        if (targets.deck && direction !== "previous") {
          const currentOrLater = matches.findIndex(match => {
            const slide = matchSlide(match, targets);
            return slide && targets.slides.get(slide)! >= targets.deck!.current;
          });
          if (currentOrLater >= 0) manualIndex = currentOrLater;
        }
      }
      else if (direction === "previous") manualIndex = (previous - 1 + matches.length) % matches.length;
      else if (direction === "next") manualIndex = (previous + 1) % matches.length;
      else manualIndex = previous;
      if (targets.deck && matchPages.length) {
        let page = requestedPage && matchPages.includes(requestedPage) ? requestedPage : pageOf(matches[manualIndex]!);
        if (!changed && !refresh && !requestedPage && direction !== "current") {
          const from = targets.deck.current;
          page = direction === "next" ? matchPages.find(p => p > from) ?? matchPages[0]
            : [...matchPages].reverse().find(p => p < from) ?? matchPages.at(-1);
        }
        const index = matches.findIndex(match => pageOf(match) === page);
        if (index >= 0) manualIndex = index;
      }
      const match = matches[manualIndex]!;
      const slide = matchSlide(match, targets);
      const targetPage = slide ? targets.slides.get(slide)! : null;
      const element = matchElement(match);
      let visible = !element || isRendered(element);
      if (slide && targetPage && targets.deck && (targetPage !== targets.deck.current || !visible)) {
        if (!refresh) {
          navigatingSearchRun = runId;
          try {
            await navigateDeckTo(targetPage, isCurrent);
            const started = nativeNow();
            do {
              await new NativePromise<void>(resolve => nativeSetTimeout(resolve, 40));
              if (!isCurrent()) return;
              const active = readDeckState()?.current === targetPage;
              visible = active && Boolean(element?.isConnected && isRendered(element));
            } while (!visible && nativeNow() - started < 2_400);
          } finally { if (navigatingSearchRun === runId) navigatingSearchRun = 0; }
        } else visible = false;
      }
      if (!isCurrent()) return;
      found = visible && revealManualMatch(match, !refresh && (reset || direction !== "current" || Boolean(requestedPage)));
      if (found && targetPage && NativeHighlight) {
        const ranges: Range[] = [];
        for (const item of matches) if (item.kind === "text" && pageOf(item) === targetPage) {
          const range = document.createRange();
          range.setStart(item.startNode, item.startOffset); range.setEnd(item.endNode, item.endOffset);
          ranges.push(range);
        }
        nativeSetHighlight?.(highlightName, new NativeHighlight(...ranges));
      }
      lastManualMatch = match;
      if (!found) { clearHighlight(); getSelection()?.removeAllRanges(); }
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
      searchLimited: true,
      searchDeck: Boolean(targets.deck),
      matchPages,
      navigationFailed: !refresh && matches.length > 0 && !found,
      truncatedReason: truncated ? "matches" : targets.incomplete ? "unloaded-pages" : undefined,
      page: lastManualMatch ? targets.slides.get(matchSlide(lastManualMatch, targets)!) : undefined
    });
  };
  const runSearch = async (
    nextQuery: string,
    direction: "current" | "next" | "previous",
    requestId: number,
    refresh: boolean,
    targetPage?: number
  ): Promise<void> => {
    if (manualRefreshTimer) {
      nativeClearTimeout(manualRefreshTimer);
      manualRefreshTimer = 0;
    }
    latestSearchRequestId = requestId;
    const runId = ++manualSearchRunId;
    navigatingSearchRun = 0;
    const changed = nextQuery !== query;
    query = nextQuery;
    if (!query) {
      found = false;
      lastManualMatch = null;
      clearHighlight();
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
      clearHighlight();
      getSelection()?.removeAllRanges();
    }
    if (!searchEnabled) {
      post({ type: "html-studio-search-result", requestId, query, found: false, current: 0, total: 0,
        countComplete: false, countReliable: false, searchLimited: true, truncatedReason: "document-size" });
      return;
    }
    const targets = await collectSearchTargets(() => runId === manualSearchRunId && requestId === latestSearchRequestId);
    if (runId !== manualSearchRunId || requestId !== latestSearchRequestId) return;
    if (!targets) {
      found = false;
      lastManualMatch = null;
      clearHighlight();
      post({
        type: "html-studio-search-result",
        requestId,
        query,
        found: false,
        current: 0,
        total: 0,
        countComplete: false,
        countReliable: false,
        searchLimited: true,
        searchInvalidated: true
      });
      return;
    }
    if (allowDynamicPageScripts) {
      await runManualSearch(targets, query, direction, changed, requestId, runId, refresh, targetPage);
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
  const requestSearch = (next: string, direction: "current" | "next" | "previous", requestId: number, refresh = false, targetPage?: number): void => {
    void runSearch(next, direction, requestId, refresh, targetPage).catch(() => {
      if (latestSearchRequestId !== requestId || query !== next) return;
      found = false;
      lastManualMatch = null;
      clearHighlight();
      post({ type: "html-studio-search-result", requestId, query: next, found: false,
        current: 0, total: 0, countComplete: false, countReliable: false, searchLimited: true });
    });
  };
  const onMessage = (event: MessageEvent<unknown>): void => {
    const data = event.data as Partial<SearchBridgeMessage> & { direction?: string };
    if (!data || data.channel !== channel) return;
    if (data.type === "html-studio-deck-go") {
      readingRestoreRun += 1;
      const deck = readDeckState();
      if (!deck || !Number.isSafeInteger(data.page) || data.page! < 1 || data.page! > deck.pages.length) return;
      const target = deck.pages[data.page! - 1];
      if (!target) return;
      void navigateDeckTo(data.page!).then(() => sendState(), () => sendState());
      return;
    }
    if (data.type === "html-studio-page-state-restore") {
      if (data.page !== undefined && (!Number.isSafeInteger(data.page) || data.page < 1 || data.page > 500)) return;
      const run = ++readingRestoreRun;
      const restorePort = port;
      const current = (): boolean => run === readingRestoreRun && port === restorePort;
      const x = Number.isFinite(data.scrollX) ? Math.max(0, Math.min(10_000_000, Math.floor(data.scrollX!))) : 0;
      const y = Number.isFinite(data.scrollY) ? Math.max(0, Math.min(10_000_000, Math.floor(data.scrollY!))) : 0;
      const restore = async (): Promise<void> => {
        let deck = readDeckSnapshot();
        // Frameworks may create slides after load. A page request cannot be
        // acknowledged as a mere scroll restore while those slides are absent.
        if (data.page !== undefined) {
          const deadline = nativeNow() + 5_000;
          while (current() && !deck && nativeNow() < deadline) {
            await new NativePromise<void>(resolve => nativeSetTimeout(resolve, 60));
            deck = readDeckSnapshot();
          }
          if (!current() || !deck?.state.adapter || data.page > deck.state.pages.length) return;
        }
        const page = deck?.state.adapter && Number.isSafeInteger(data.page) && data.page! >= 1 && data.page! <= deck.state.pages.length
          ? data.page! - 1 : deck && deck.navigation !== "hash" ? deck.state.pages.findIndex(page => page.hash === data.hash) : -1;
        if (page !== undefined && page >= 0) {
          await navigateDeckTo(page + 1, current);
          if (!current()) return;
          if (readDeckState()?.current !== page + 1) { sendState(); return; }
        } else if (typeof data.hash === "string" && data.hash.length <= 4_096
          && (data.hash === "" || data.hash.startsWith("#")) && location.hash !== data.hash) {
          location.hash = data.hash;
        }
        nativeScrollTo(x, y);
        nativeRequestAnimationFrame(() => {
          if (!current()) return;
          const actual = readDeckState();
          if (data.page !== undefined && actual?.current !== data.page) return;
          nativeScrollTo(x, y);
          sendState("html-studio-page-state-restored", actual);
        });
      };
      void restore().catch(() => { if (current()) sendState(); });
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
    requestSearch(next, direction, requestId, false, Number.isSafeInteger(data.targetPage) ? data.targetPage : undefined);
  };
  const connect = (): void => {
    readingRestoreRun += 1;
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
  addEventListener("animationend", () => { invalidateSearch(); scheduleDeckState(); }, true);
  addEventListener("transitionend", () => { invalidateSearch(); scheduleDeckState(); }, true);
  addEventListener("pagehide", () => {
    deckNavigationRun += 1;
    readingRestoreRun += 1;
    if (manualRefreshTimer) nativeClearTimeout(manualRefreshTimer);
    manualRefreshTimer = 0;
    manualSearchRunId += 1;
    lastManualMatch = null;
    clearHighlight();
    sendState();
    post({ type: "html-studio-search-leaving" });
    port?.close();
  });
  addEventListener("click", event => {
    scheduleDeckState();
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
    scheduleDeckState();
    const legacyKeyCode = (event as unknown as { keyCode?: number }).keyCode;
    if (event.isComposing || legacyKeyCode === 229) return;
    if (event.key === "Escape") post({ type: "html-studio-fullscreen-exit" });
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

export function findHtmlHeadInsertionOffset(source: Buffer): number {
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
