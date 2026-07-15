export const MAX_SEARCH_BRIDGE_HTML_BYTES = 16 * 1024 * 1024;

export interface SearchBridgeMessage {
  channel: string;
  current?: number;
  query?: string;
  total?: number;
  type: "html-studio-search" | "html-studio-search-open" | "html-studio-search-ready" | "html-studio-search-result";
}

export function injectSearchBridge(source: string, nonce: string, channel: string): string {
  const script = `<script nonce="${nonce}">${buildSearchBridgeSource(channel)}</script>`;
  return `${source}${script}`;
}

function buildSearchBridgeSource(channel: string): string {
  return `(()=>{"use strict";const c=${JSON.stringify(channel)},p=(m)=>parent.postMessage({channel:c,...m},"*");let q="",n=0,i=0;const count=(v)=>{if(!v)return 0;const text=(document.body?.innerText||"").toLocaleLowerCase(),needle=v.toLocaleLowerCase();let total=0,at=0;while(total<10000&&(at=text.indexOf(needle,at))!==-1){total+=1;at+=Math.max(1,needle.length)}return total};const run=(v,back)=>{q=v;n=count(v);if(!v||n===0){getSelection()?.removeAllRanges();i=0;p({type:"html-studio-search-result",query:q,current:0,total:n});return}const found=window.find(v,false,back,true,false,false,false);if(found)i=back?(i<=1?n:i-1):(i>=n?1:i+1);else i=0;p({type:"html-studio-search-result",query:q,current:i,total:n})};addEventListener("message",(e)=>{if(e.source!==parent||!e.data||e.data.channel!==c||e.data.type!=="html-studio-search")return;const next=typeof e.data.query==="string"?e.data.query.slice(0,500):"";if(next!==q)i=e.data.direction==="previous"?1:0;run(next,e.data.direction==="previous")});addEventListener("keydown",(e)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLocaleLowerCase()==="f"){e.preventDefault();p({type:"html-studio-search-open"})}});p({type:"html-studio-search-ready"})})();`;
}
