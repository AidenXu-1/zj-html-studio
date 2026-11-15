import { existsSync, readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { unobscuredCourseRect } from "../../src/presentation/picture-projection";
import { previewBottomInset, observePreviewInset } from "../../src/view/preview-inset";
let browser: Browser;
beforeAll(async()=>{
  const chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser=await chromium.launch({executablePath:process.env.HTML_STUDIO_CHROMIUM_PATH??(existsSync(chrome)?chrome:undefined),headless:true});
});
afterAll(async()=>{await browser?.close();});
describe("course image privacy in Chromium",()=>{
  it("keeps both the active and replacement course above the status bar in a narrow pane",async()=>{
    const page=await browser.newPage();
    try{
      await page.setContent(`<style>${readFileSync('styles.css','utf8')}
        .status-bar{position:fixed;left:300px;top:480px;width:200px;height:20px;background:red}</style>
        <div id="view" class="html-studio-view" style="position:fixed;left:100px;top:100px;width:400px;height:400px;display:block">
        <div class="html-studio-iframe-host" style="height:100%;box-sizing:border-box">
        <div class="html-studio-preview-canvas"><iframe class="html-studio-iframe" srcdoc="Course"></iframe></div>
        <div class="html-studio-preview-canvas html-studio-preview-candidate"><iframe class="html-studio-iframe" srcdoc="Replacement"></iframe></div></div></div>
        <div class="status-bar">Private status</div>`);
      await page.addScriptTag({content:`const previewBottomInset=${previewBottomInset.toString()};window.insets=(${observePreviewInset.toString()})(document.querySelector('#view'),window)`});
      await page.waitForFunction(()=>document.querySelector<HTMLElement>('#view')!.style.getPropertyValue('--html-studio-bottom-inset')==='20px');
      for(const frame of await page.locator('iframe').all()) {
        expect(await frame.evaluate(el=>el.getBoundingClientRect().bottom)).toBeLessThan(480);
      }
    }finally{await page.close();}
  });
  it("reserves room for a floating status bar without bypassing other overlay protection",async()=>{
    const page=await browser.newPage();
    try{
      await page.setContent(`<style>${readFileSync('styles.css','utf8')}
        .status-bar{position:fixed;left:500px;top:480px;width:200px;height:20px;background:red}.status-bar.outside{left:800px}
        #note{position:fixed;left:150px;top:150px;width:100px;height:100px;background:lime;pointer-events:none}</style>
        <div id="view" class="html-studio-view" style="position:fixed;left:100px;top:100px;width:600px;height:400px;display:block">
        <div class="html-studio-iframe-host" style="height:100%;box-sizing:border-box"><iframe id="course" style="width:100%;height:100%;border:0" srcdoc="Course"></iframe></div></div>
        <div class="status-bar">Private status</div>`);
      await page.addScriptTag({content:`window.courseRect=()=>(${unobscuredCourseRect.toString()})(document.querySelector('#course'))`});
      const read=()=>page.evaluate(()=>(window as unknown as {courseRect:()=>unknown}).courseRect());
      expect(await read()).toBeNull();
      await page.addScriptTag({content:`const previewBottomInset=${previewBottomInset.toString()};window.insets=(${observePreviewInset.toString()})(document.querySelector('#view'),window)`});
      await page.waitForFunction(()=>(window as unknown as {courseRect:()=>unknown}).courseRect()!==null);
      expect(await page.locator('#course').evaluate(el=>el.getBoundingClientRect().bottom)).toBeLessThan(480);
      await page.evaluate(()=>{const el=document.createElement('div');el.id='note';document.body.append(el);});
      expect(await read()).toBeNull();
      await page.evaluate(()=>{
        document.querySelector('#note')!.remove();
        document.querySelector('.status-bar')!.classList.add('outside');
        (window as unknown as {insets:{update:()=>void}}).insets.update();
      });
      await page.waitForFunction(()=>document.querySelector('#course')!.getBoundingClientRect().bottom===486);
      expect(await read()).not.toBeNull();
    }finally{await page.close();}
  });
  it("refuses clipped, transparent-to-input and small host overlays even when their center does not hit them",async()=>{
    const page=await browser.newPage();
    try{
      await page.setContent('<style>.transparent-course{opacity:0}</style><iframe id="course" style="position:absolute;left:100px;top:100px;width:600px;height:400px;border:0" srcdoc="Course"></iframe>');
      await page.addScriptTag({content:`window.courseRect=()=>(${unobscuredCourseRect.toString()})(document.querySelector('#course'))`});
      const read=()=>page.evaluate(()=>(window as unknown as {courseRect:()=>unknown}).courseRect());
      expect(await read()).toMatchObject({x:100,y:100,width:600,height:400});
      for(const extra of ['clip-path:polygon(0 0,100% 0,100% 15%,0 15%)','pointer-events:none','width:20px;height:10px']){
        await page.evaluate(extra=>{const d=document.createElement('div');d.id='private';d.textContent='Private note';d.style.cssText='position:fixed;left:100px;top:100px;width:600px;height:400px;background:lime;z-index:999;'+extra;document.body.append(d);},extra);
        expect(await read()).toBeNull();
        await page.locator('#private').evaluate(el=>el.remove());
      }
      await page.locator('#course').evaluate(el=>el.classList.add('transparent-course'));
      expect(await read()).toBeNull();
    }finally{await page.close();}
  });
});
