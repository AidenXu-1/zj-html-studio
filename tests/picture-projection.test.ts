import { afterEach, describe, expect, it, vi } from "vitest";
import { PictureProjection, toCaptureRect } from "../src/presentation/picture-projection";
import { parseDeckState } from "../src/presentation/deck-state";
describe("course-only projection boundary",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("refuses an iframe adopted by a different window before asking the old window for pixels",async()=>{
    vi.stubGlobal("MutationObserver",class {observe(){} disconnect(){}});
    const capture=vi.fn();
    const original={clearTimeout:vi.fn(),electronWindow:{webContents:{capturePage:capture}}};
    const doc={defaultView:original};
    const frame={ownerDocument:doc} as unknown as HTMLIFrameElement;
    const image={removeAttribute:vi.fn(),remove:vi.fn()};
    const container={createEl:()=>image} as unknown as HTMLElement;
    const failed=vi.fn(), presented=vi.fn();
    const stream=new PictureProjection(frame,container,()=>true,presented,failed);
    doc.defaultView={...original};
    stream.start();
    await Promise.resolve();
    expect(failed).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(presented).not.toHaveBeenCalled();
  });
  it("rounds inward at all zoom factors and rejects invalid or unbounded rectangles",()=>{
    for(const zoom of [.75,1,1.25,2]){
      const r=toCaptureRect({x:10.3,y:15.8,width:800.2,height:600.4},zoom)!;
      expect(r.x).toBeGreaterThanOrEqual(10.3*zoom);
      expect(r.y).toBeGreaterThanOrEqual(15.8*zoom);
      expect(r.x+r.width).toBeLessThanOrEqual(810.5*zoom);
      expect(r.y+r.height).toBeLessThanOrEqual(616.2*zoom);
    }
    for(const value of [NaN,Infinity,-1,0,100_000]) expect(toCaptureRect({x:0,y:0,width:value,height:600},1)).toBeNull();
  });
  it("discards an in-flight old-window frame after the course moves",async()=>{
    vi.stubGlobal("MutationObserver",class {observe(){} disconnect(){}});
    vi.stubGlobal("NodeFilter",{SHOW_ELEMENT:1});
    const toJPEG=vi.fn();
    const captured={isEmpty:()=>false,getSize:()=>({width:800,height:600}),toJPEG,resize:()=>captured};
    let complete!:(image:typeof captured)=>void;
    const capture=vi.fn(()=>new Promise<typeof captured>(resolve=>{complete=resolve;}));
    const contents={capturePage:capture,getZoomFactor:()=>1,isDestroyed:()=>false};
    const original={innerWidth:1000,innerHeight:800,clearTimeout:vi.fn(),setTimeout:vi.fn(),electronWindow:{id:1}};
    const doc={defaultView:original,visibilityState:"visible",body:{},createTreeWalker:()=>({nextNode:()=>false})};
    const frame={ownerDocument:doc,isConnected:true,checkVisibility:()=>true,getBoundingClientRect:()=>({x:0,y:0,left:0,top:0,right:800,bottom:600,width:800,height:600})} as unknown as HTMLIFrameElement;
    const image={removeAttribute:vi.fn(),remove:vi.fn()};
    const presented=vi.fn();
    const stream=new PictureProjection(frame,{createEl:()=>image} as unknown as HTMLElement,()=>true,presented,vi.fn(),{fromId:()=>({webContents:contents})});
    stream.start();expect(capture).toHaveBeenCalledOnce();
    doc.defaultView={...original};complete(captured);
    await Promise.resolve();await Promise.resolve();
    expect(toJPEG).not.toHaveBeenCalled();expect(presented).not.toHaveBeenCalled();
    stream.stop();
  });
  it("keeps framework navigation tokens local, ordered and bounded",()=>{
    const pages=[1,2,3].map(n=>({hash:`#@zj/dom/${n}`,title:`Page ${n}`}));
    expect(parseDeckState({adapter:"dom",canNavigate:false,current:2,pages})).toMatchObject({canNavigate:false,current:2});
    for(const adapter of ["arbitrary","https://host","",null]) expect(parseDeckState({adapter,canNavigate:true,current:1,pages})).toBeNull();
    expect(parseDeckState({adapter:"dom",canNavigate:true,current:1,pages:[pages[2],pages[0]]})).toBeNull();
    expect(parseDeckState({adapter:"dom",canNavigate:true,current:1,pages:[{hash:"#@zj/dom/1?script",title:"x"},pages[1]]})).toBeNull();
  });
});
