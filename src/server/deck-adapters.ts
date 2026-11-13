import type { DeckState } from "../presentation/deck-state";

export interface AdapterSnapshot {
  state: DeckState;
  elements: Array<Element | null>;
  navigation: "adapter" | "observe";
  go?: (page: number) => void;
}

/** Serialized into the isolated course frame. No imports or host objects at runtime. */
/* eslint-disable @typescript-eslint/unbound-method -- Captured DOM intrinsics are called with explicit receivers via Reflect.apply. */
export function createDeckAdapters(): () => AdapterSnapshot | null {
  const apply = Reflect.apply.bind(Reflect);
  const attr = Element.prototype.getAttribute;
  const rect = Element.prototype.getBoundingClientRect;
  const click = HTMLElement.prototype.click;
  const walker = document.createTreeWalker.bind(document);
  const now = performance.now.bind(performance);
  const style = getComputedStyle.bind(window);
  let deadline = 0;
  const text = Object.getOwnPropertyDescriptor(CharacterData.prototype, "data")!.get!;
  const get = (el: Element, name: string): string => String(apply(attr, el, [name]) ?? "");
  const words = (el: Element): string[] => get(el, "class").split(/\s+/);
  const content = (el: Element): string => {
    const nodes = walker(el, NodeFilter.SHOW_TEXT);
    let result = "";
    for (let count = 0; count < 100 && result.length < 1_024 && nodes.nextNode(); count++) {
      result += String(apply(text, nodes.currentNode, [])).slice(0, 1_024 - result.length);
    }
    return result.trim();
  };
  const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" || typeof value === "function") && value !== null ? value as Record<string, unknown> : null;
  const call = (obj: Record<string, unknown>, method: string, args: unknown[] = []): unknown => typeof obj[method] === "function" ? apply(obj[method] as (...args: unknown[]) => unknown, obj, args) : undefined;
  const elements = (value: unknown): Element[] | null => {
    if (!Array.isArray(value) || value.length < 2 || value.length > 500) return null;
    return value.every(el => el instanceof Element && el.ownerDocument === document && el.isConnected) ? value as Element[] : null;
  };
  const title = (el: Element | null): string => {
    if (!el) return "";
    const w = walker(el, NodeFilter.SHOW_ELEMENT);
    for (let count = 0; count < 100 && w.nextNode(); count++) {
      if (now() > deadline) return "";
      const h = w.currentNode as Element;
      if (/^H[1-3]$/.test(h.tagName)) return content(h).replace(/\s+/g, " ").slice(0, 160);
    }
    return "";
  };
  const snapshot = (adapter: "reveal" | "swiper" | "dom", list: Array<Element | null>, current: number, go?: (page: number) => void): AdapterSnapshot | null => {
    if (list.length < 2 || list.length > 500 || !Number.isInteger(current) || current < 1 || current > list.length) return null;
    return { state: { adapter, canNavigate: Boolean(go), current,
      pages: list.map((el,i) => ({ hash:`#@zj/${adapter}/${i+1}`, title:title(el) })) },
    elements:list, navigation:go ? "adapter" : "observe", go };
  };
  const dominant = (el: Element): boolean => {
    const r = apply(rect, el, []);
    // A carousel embedded in a scrolling article is not the document's deck.
    // Allow modest navigation/margins, but require one viewport-sized stage.
    const page = document.documentElement;
    const clipped = (axis: "overflowX" | "overflowY"): boolean => [page, document.body]
      .some(root => ["hidden", "clip"].includes(style(root)[axis]));
    // An outer hidden root can still contain a scrolling body/article shell.
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const cs = style(parent);
      if ((["auto", "scroll"].includes(cs.overflowY) && parent.scrollHeight > parent.clientHeight * 1.25)
        || (["auto", "scroll"].includes(cs.overflowX) && parent.scrollWidth > parent.clientWidth * 1.25)) return false;
    }
    return r.width >= innerWidth * .5 && r.height >= innerHeight * .45
      && (clipped("overflowY") || Math.max(page.scrollHeight, document.body.scrollHeight) <= innerHeight * 1.25)
      && (clipped("overflowX") || Math.max(page.scrollWidth, document.body.scrollWidth) <= innerWidth * 1.25);
  };
  return () => {
    if (!document.body) return null;
    const started = now();
    deadline = started + 24;
    const all: Element[] = [];
    const w = walker(document.body, NodeFilter.SHOW_ELEMENT);
    while (w.nextNode()) {
      if (all.length >= 15_000 || (all.length % 100 === 0 && now() - started > 12)) return null;
      all.push(w.currentNode as Element);
    }
    const revealRoots = all.filter(el => words(el).includes("reveal"));
    const reveal = record((window as unknown as Record<string, unknown>).Reveal);
    try {
      if (revealRoots.length > 0) {
        if (!reveal || revealRoots.length !== 1 || !dominant(revealRoots[0]!)) return null;
        const slides = elements(call(reveal,"getSlides"));
        const current = call(reveal,"getCurrentSlide");
        if (slides && new Set(slides).size === slides.length && slides.every(el => revealRoots[0]!.contains(el))) {
          const indices = slides.map(el => record(call(reveal,"getIndices",[el])));
          const valid = indices.every(i => i && Number.isInteger(i.h) && Number(i.h) >= 0 && Number(i.h) < 500
            && (i.v === undefined || Number.isInteger(i.v) && Number(i.v) >= 0 && Number(i.v) < 500));
          if (valid && call(reveal,"getTotalSlides") === slides.length) {
            return snapshot("reveal",slides,slides.indexOf(current as Element)+1,
              typeof reveal.slide === "function" ? page => { const i=indices[page-1]!; call(reveal,"slide",[i.h,i.v ?? 0]); } : undefined);
          }
        }
        return null;
      }
      const swipers = all.filter(el => record((el as unknown as Record<string, unknown>).swiper) && dominant(el));
      if (swipers.length > 1) return null;
      if (swipers.length === 1) {
        const root = swipers[0]!;
        const swiper = record((root as unknown as Record<string, unknown>).swiper)!;
        const params = record(swiper.params);
        if (swiper.destroyed || params?.slidesPerView !== undefined && params.slidesPerView !== 1) return null;
        const collection = record(swiper.slides);
        if (!collection || !Number.isInteger(collection.length) || Number(collection.length) < 1 || Number(collection.length) > 500) return null;
        const list = elements(Array.from({ length: Number(collection.length) }, (_, i) => collection[String(i)]));
        if (!list || list.some(el => !root.contains(el))) return null;
        const virtual = record(swiper.virtual), virtualSlides = virtual?.slides;
        const mapped = new Map<number, Element>();
        const loop = Boolean(params?.loop);
        const indexed = loop || Boolean(params && record(params.virtual)?.enabled);
        for (const [index,el] of list.entries()) {
          const raw = get(el,"data-swiper-slide-index");
          const n = indexed ? (/^\d{1,3}$/.test(raw) ? Number(raw) : -1) : index;
          if(n < 0 || n >= 500) return null;
          if (!mapped.has(n) || !words(el).includes("swiper-slide-duplicate")) mapped.set(n,el);
        }
        const total = Array.isArray(virtualSlides) && record(params?.virtual)?.enabled ? virtualSlides.length : mapped.size;
        if (total < 2 || total > 500 || [...mapped.keys()].some(n => n >= total)) return null;
        if (!record(params?.virtual)?.enabled && mapped.size !== Math.max(...mapped.keys()) + 1) return null;
        const method = loop ? "slideToLoop" : "slideTo";
        const active = list.filter(el => words(el).includes("swiper-slide-active"));
        if (active.length !== 1) return null;
        const current = indexed ? Number(get(active[0]!, "data-swiper-slide-index")) : list.indexOf(active[0]!);
        return snapshot("swiper",Array.from({length:total},(_,i)=>mapped.get(i) ?? null),current+1,
          typeof swiper[method] === "function" ? page => { call(swiper,method,[page-1]); } : undefined);
      }
    } catch { return null; }
    // Legacy numeric decks are validated by their strict adapter, never repaired
    // by guessing around a gap, duplicate number or mixed prefix here.
    const numbered = all.filter(el => words(el).includes("slide") && /^(p|slide-)\d+$/i.test(get(el,"id")));
    if (numbered.length) {
      const ids = numbered.map(el => /^(p|slide-)(\d+)$/i.exec(get(el,"id"))!);
      const zeroBased = ids.length >= 2 && ids.every((id,i) => id[1]!.toLowerCase() === ids[0]![1]!.toLowerCase() && Number(id[2]) === i);
      if (!zeroBased) return null;
    }
    const groups = new Map<Element,Element[]>();
    for(const el of all){
      if(!el.parentElement) continue;
      const classes=words(el);
      if(el.tagName !== "SECTION" && !classes.some(c=>["slide","page","screen","slide-page","slidev-page"].includes(c)) && !get(el,"data-slide")) continue;
      const group=groups.get(el.parentElement) ?? [];
      group.push(el);groups.set(el.parentElement,group);
    }
    const matches: Array<{list:Element[];current:number}> = [];
    for(const [parent,list] of groups){
      if(list.length < 2 || list.length > 500 || !dominant(parent)) continue;
      const semantic = /(?:^|[\s_-])(deck|slides|presentation|stage|slidev)(?:$|[\s_-])/i.test(get(parent,"id")+" "+get(parent,"class"))
        || list.every(el => words(el).some(c => ["slide","slide-page","slidev-page"].includes(c)));
      if (!semantic) continue;
      let current=0, invalid=false;
      for(const [i,el] of list.entries()){
        const cs=style(el);
        const hidden = el.hasAttribute("hidden") || get(el,"aria-hidden")==="true" || cs.display==="none" || cs.visibility==="hidden" || Number(cs.opacity)===0;
        const active = !hidden;
        if(active){if(current){invalid=true;break;} current=i+1;}
        else if(!hidden){invalid=true;break;}
        if(now()-started>24) return null;
      }
      if(!invalid && current) matches.push({list,current});
    }
    if(matches.length!==1) return null;
    const {list,current}=matches[0]!;
    const controls = all.filter(el=>["BUTTON","A"].includes(el.tagName) || get(el,"role")==="button");
    const labels=(el:Element):string[]=>[get(el,"id"),get(el,"aria-label"),get(el,"title"),content(el)].map(s=>s.trim().toLowerCase());
    const prev=controls.filter(el=>labels(el).some(s=>/^(prev|previous|prev-btn|prevbtn|previous slide|上一页|上一张|‹|←|❮)$/.test(s)));
    const next=controls.filter(el=>labels(el).some(s=>/^(next|next-btn|nextbtn|next slide|下一页|下一张|›|→|❯)$/.test(s)));
    // Counters corroborate structure; conflicting fractions never invent pages.
    const counters = all.filter(el=>/^(page[-_]?counter|slide[-_]?counter|page[-_]?number|pagination)$/i.test(get(el,"id")));
    for(const el of counters){const m=/^(\d{1,3})\s*[/／]\s*(\d{1,3})$/.exec(content(el));if(m&&(Number(m[1])!==current||Number(m[2])!==list.length))return null;}
    const links=list.map(el=>controls.find(link=>link.tagName==="A"&&get(el,"id")&&get(link,"href")==="#"+get(el,"id")));
    const go=links.every(Boolean) ? (page:number)=>{apply(click,links[page-1]!,[]);}
      : prev.length===1 && next.length===1 ? (page:number)=>{apply(click,page>current?next[0]!:prev[0]!,[]);} : undefined;
    return snapshot("dom",list,current,go);
  };
}

/* eslint-enable @typescript-eslint/unbound-method -- End of isolated DOM adapter. */
