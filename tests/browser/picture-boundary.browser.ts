import { existsSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { unobscuredCourseRect } from "../../src/presentation/picture-projection";
let browser: Browser;
beforeAll(async()=>{
  const chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser=await chromium.launch({executablePath:process.env.HTML_STUDIO_CHROMIUM_PATH??(existsSync(chrome)?chrome:undefined),headless:true});
});
afterAll(async()=>{await browser?.close();});
describe("course image privacy in Chromium",()=>{
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
