import { resolveNativeWindow, type NativeWindowRegistry } from "./native-window";

export interface CaptureRect { x: number; y: number; width: number; height: number }
interface CapturedImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number; quality: "good" }): CapturedImage;
  toJPEG(quality: number): Uint8Array;
}
export interface CaptureContents {
  capturePage(rect: CaptureRect, options: { stayHidden: boolean }): Promise<CapturedImage>;
  getZoomFactor(): number;
  isDestroyed(): boolean;
}
type CaptureRegistry = NativeWindowRegistry<{ webContents?: CaptureContents }>;

export function captureContents(win: Window, registry?: CaptureRegistry): CaptureContents | null {
  const wc = resolveNativeWindow(win, registry)?.webContents;
  return wc && typeof wc.capturePage === "function" && typeof wc.getZoomFactor === "function" && !wc.isDestroyed() ? wc : null;
}

export function toCaptureRect(rect: CaptureRect, zoom: number): CaptureRect | null {
  if (![rect.x,rect.y,rect.width,rect.height,zoom].every(Number.isFinite) || zoom <= 0 || zoom > 5 || rect.x < 0 || rect.y < 0) return null;
  const x=Math.ceil(rect.x*zoom), y=Math.ceil(rect.y*zoom);
  const width=Math.floor((rect.x+rect.width)*zoom)-x, height=Math.floor((rect.y+rect.height)*zoom)-y;
  return width >= 2 && height >= 2 && width <= 8192 && height <= 8192 && width*height <= 24_000_000 ? {x,y,width,height} : null;
}

/** A host overlay must never become part of the audience image, even when its
 * pointer-events are disabled. Inspect paintable host rectangles, not just hit tests. */
export function unobscuredCourseRect(frame: HTMLIFrameElement): CaptureRect | null {
  const doc=frame.ownerDocument, win=doc.defaultView;
  if (!win || !frame.isConnected || doc.visibilityState === "hidden") return null;
  if (!frame.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  const frameBounds=frame.getBoundingClientRect();
  let left=Math.max(0,frameBounds.left), right=Math.min(win.innerWidth,frameBounds.right);
  let top=Math.max(0,frameBounds.top), bottom=Math.min(win.innerHeight,frameBounds.bottom);
  // A zoomed page can be larger than its preview. Capture only the visible
  // intersection of the iframe and each clipping ancestor, excluding scrollbars.
  for(let parent=doc.fullscreenElement===frame ? null : frame.parentElement;parent;parent=parent.parentElement){
    const style=win.getComputedStyle(parent), box=parent.getBoundingClientRect();
    const sx=parent.offsetWidth ? box.width/parent.offsetWidth : 1;
    const sy=parent.offsetHeight ? box.height/parent.offsetHeight : 1;
    if(style.overflowX!=="visible"){
      const edge=box.left+parent.clientLeft*sx;
      left=Math.max(left,edge);right=Math.min(right,edge+parent.clientWidth*sx);
    }
    if(style.overflowY!=="visible"){
      const edge=box.top+parent.clientTop*sy;
      top=Math.max(top,edge);bottom=Math.min(bottom,edge+parent.clientHeight*sy);
    }
  }
  if(right-left<2||bottom-top<2) return null;
  const r={left,right,top,bottom,x:left,y:top,width:right-left,height:bottom-top};
  const intersects=(a:DOMRect):boolean=>a.width>0&&a.height>0&&a.right>r.left&&a.left<r.right&&a.bottom>r.top&&a.top<r.bottom;
  const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_ELEMENT);
  let steps=0;
  while(walker.nextNode()){
    if(++steps>20_000) return null;
    const el=walker.currentNode as Element;
    if(el===frame || el.contains(frame)) continue;
    const bounds = el.getBoundingClientRect();
    if(!intersects(bounds)) continue;
    const style=win.getComputedStyle(el);
    if(style.visibility==="hidden"||style.display==="none"||Number(style.opacity)===0) continue;
    // Invisible descendants of a hidden subtree have rectangles in Chromium.
    if(typeof el.checkVisibility === "function" && !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
    // Only exclude ordinary-flow rectangles proven to be clipped by ancestors.
    // Hit testing a point cannot prove safety for clip-path, masks or holes.
    const ancestors: Element[] = [];
    let escaped = style.position === "absolute" || style.position === "fixed";
    for (let parent=el.parentElement;parent&&!parent.contains(frame);parent=parent.parentElement) {
      ancestors.push(parent);
      const position=win.getComputedStyle(parent).position;
      if(position === "absolute" || position === "fixed") escaped=true;
    }
    if (!escaped) {
      let left=bounds.left, right=bounds.right, top=bounds.top, bottom=bounds.bottom;
      for(const ancestor of ancestors){
        const clip=win.getComputedStyle(ancestor), box=ancestor.getBoundingClientRect();
        if(clip.overflowX !== "visible"){left=Math.max(left,box.left);right=Math.min(right,box.right);}
        if(clip.overflowY !== "visible"){top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);}
      }
      if(right<=left||bottom<=top||right<=r.left||left>=r.right||bottom<=r.top||top>=r.bottom) continue;
    }
    return null;
  }
  // Rounded iframe corners could expose the host background, but never content.
  return {x:r.x,y:r.y,width:r.width,height:r.height};
}

/** Serial, bounded, ephemeral course-only frames. No screen capture permission,
 * desktop image, lecture data, user files or page-controlled capture coordinates. */
export class PictureProjection {
  private stopped=false;
  private timer=0;
  private revision=0;
  private observer: MutationObserver;
  private readonly sourceWindow: Window;
  private readonly timerWindow: Window;
  private readonly image: HTMLImageElement;
  private frames=0;

  constructor(private readonly frame: HTMLIFrameElement, container: HTMLElement,
    private readonly valid:()=>boolean, private readonly presented:()=>void,
    private readonly failed:(error:unknown)=>void, private readonly registry?:CaptureRegistry, timerWindow?: Window) {
    this.sourceWindow=frame.ownerDocument.defaultView!;
    this.timerWindow=timerWindow ?? this.sourceWindow;
    this.image=container.createEl("img",{cls:"html-studio-projection-picture",attr:{alt:"投屏课件"}});
    this.observer=new MutationObserver(()=>{this.revision++;});
    this.observer.observe(frame.ownerDocument.body,{subtree:true,childList:true,attributes:true,characterData:true});
  }

  start(): void { void this.tick(); }
  stop(): void {
    this.stopped=true;
    this.timerWindow.clearTimeout(this.timer);
    this.observer.disconnect();
    this.image.removeAttribute("src");this.image.remove();
  }

  private async tick(): Promise<void> {
    if(this.stopped) return;
    try {
      if(!this.valid() || this.frame.ownerDocument.defaultView !== this.sourceWindow) throw new Error("Course capture source changed");
      const wc=captureContents(this.sourceWindow, this.registry);
      if(!wc) throw new Error("Course capture is unavailable");
      const before=unobscuredCourseRect(this.frame);
      if(before){
        const revision=this.revision, zoom=wc.getZoomFactor();
        const region=toCaptureRect(before,zoom);
        if(region){
          let image=await wc.capturePage(region,{stayHidden:true});
          if(this.stopped) return;
          const after=unobscuredCourseRect(this.frame);
          if(this.valid()&&this.frame.ownerDocument.defaultView===this.sourceWindow&&revision===this.revision&&after&&JSON.stringify(before)===JSON.stringify(after)&&zoom===wc.getZoomFactor()&&!image.isEmpty()){
            const size=image.getSize(), ratio=Math.min(1,2560/size.width,1600/size.height);
            if(ratio<1) image=image.resize({width:Math.max(1,Math.floor(size.width*ratio)),height:Math.max(1,Math.floor(size.height*ratio)),quality:"good"});
            const data=image.toJPEG(90);
            if(data.length > 8*1024*1024) throw new Error("Course frame exceeds capture budget");
            this.image.src="data:image/jpeg;base64,"+Buffer.from(data).toString("base64");
            await this.image.decode();
            if(this.stopped) return;
            this.frames++;
            this.presented();
          }
        }
      }
    } catch(error){if(!this.stopped){this.stop();this.failed(error);}return;}
    if(!this.stopped) this.timer=this.timerWindow.setTimeout(()=>{void this.tick();},80);
  }
}
