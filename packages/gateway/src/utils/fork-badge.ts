/**
 * Fork badge injection — inject the forkable overlay into HTML responses
 * served from custom subdomains.
 *
 * Checks whether the app behind a subdomain has a published, forkable version.
 * If so, injects a config block + the badge script before </body>.
 */

import { pool } from "../db/pool.js";

// ---------- Forkable status cache ----------

interface ForkableInfo {
  forkable: boolean;
  appName: string;
  versionId: string | null;
}

const forkableCache = new Map<string, { info: ForkableInfo; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Look up whether a subdomain's project has a published forkable version.
 */
async function getForkableInfo(subdomain: string): Promise<ForkableInfo> {
  // Check cache
  const cached = forkableCache.get(subdomain);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.info;
  }

  const notForkable: ForkableInfo = { forkable: false, appName: subdomain, versionId: null };

  try {
    // subdomain → project_id → latest published forkable version
    const result = await pool.query(
      `SELECT av.id AS version_id, av.name AS app_name
       FROM internal.subdomains s
       JOIN internal.app_versions av ON av.project_id = s.project_id
       WHERE s.name = $1
         AND av.status = 'published'
         AND av.fork_allowed = true
         AND av.visibility IN ('public', 'unlisted')
       ORDER BY av.version DESC
       LIMIT 1`,
      [subdomain],
    );

    const info: ForkableInfo = result.rows.length > 0
      ? { forkable: true, appName: result.rows[0].app_name || subdomain, versionId: result.rows[0].version_id }
      : notForkable;

    forkableCache.set(subdomain, { info, expiresAt: Date.now() + CACHE_TTL_MS });
    return info;
  } catch {
    // On DB error, don't inject — fail open
    return notForkable;
  }
}

/**
 * Inject the fork badge into an HTML string if the app is forkable.
 * Returns the original HTML unchanged if not forkable or not HTML.
 */
export async function injectForkBadge(html: string, subdomain: string): Promise<string> {
  const info = await getForkableInfo(subdomain);
  if (!info.forkable) return html;

  const appUrl = `https://${subdomain}.run402.com`;
  const defaultTarget = `${subdomain}-copy`;

  // Build the config + script injection
  const configScript = `<script>
window.__RUN402_FORK_BADGE__=${JSON.stringify({
    forkable: true,
    appName: info.appName,
    appUrl,
    rootDomain: "run402.com",
    llmsUrl: "https://run402.com/llms.txt",
    position: "bottom-right",
    defaultTarget,
    promptVerb: "fork",
    showRewards: true,
    rewardsText: "Supports the original publisher (20% hosting share).",
    title: "Create your own live copy",
    bodyText: "Paste this into your coding agent.",
    initialMinimized: false,
  })};
</script>
<script>${FORK_BADGE_SCRIPT}</script>`;

  // Inject before </body> if present, otherwise append
  const bodyCloseIdx = html.lastIndexOf("</body>");
  if (bodyCloseIdx >= 0) {
    return html.slice(0, bodyCloseIdx) + configScript + "\n" + html.slice(bodyCloseIdx);
  }
  return html + configScript;
}

// ---------- Inline badge script ----------
// This is the self-contained Shadow DOM overlay from the consultation design.
// It reads window.__RUN402_FORK_BADGE__ and renders the UI.

const FORK_BADGE_SCRIPT = `(()=>{
if(window.__RUN402_FORK_BADGE_MOUNTED__)return;
window.__RUN402_FORK_BADGE_MOUNTED__=true;
var I=window.__RUN402_FORK_BADGE__||{};
var hostname=String(I.appHost||location.hostname);
var appName=String(I.appName||hostname.split(".")[0]||"app").toLowerCase();
var appUrl=String(I.appUrl||location.origin||location.protocol+"//"+location.host);
var rootDomain=String(I.rootDomain||"run402.com");
var llmsUrl=String(I.llmsUrl||"https://run402.com/llms.txt");
var C={
forkable:I.forkable!==false,
position:I.position==="bottom-left"?"bottom-left":"bottom-right",
defaultTarget:String(I.defaultTarget||appName+"-copy"),
promptVerb:String(I.promptVerb||"fork").toLowerCase(),
title:String(I.title||"Create your own live copy"),
bodyText:String(I.bodyText||"Paste this into your coding agent."),
showRewards:I.showRewards!==false,
rewardsText:String(I.rewardsText||"Supports the original publisher (20% hosting share)."),
storageKey:String(I.storageKey||"run402:fork-badge:"+hostname),
initialMinimized:I.initialMinimized===true
};
if(!C.forkable)return;
function escRE(s){return s.replace(/[.*+?^\${}()|[\\]\\\\]/g,"\\\\$&")}
var rdp=new RegExp("(?:\\\\.)?"+escRE(rootDomain)+"$","i");
function san(v,fb){
var o=String(v||"").toLowerCase().trim();
o=o.replace(/^https?:\\/\\//,"").replace(/\\/.*$/,"").replace(rdp,"").replace(/\\.$/,"");
o=o.replace(/[^a-z0-9-]/g,"-").replace(/--+/g,"-").replace(/^-+|-+$/g,"");
o=o.slice(0,63).replace(/^-+|-+$/g,"");
return o||fb;
}
function loadSt(){try{var r=localStorage.getItem(C.storageKey);return r?JSON.parse(r):{}}catch(e){return{}}}
function saveSt(s){try{localStorage.setItem(C.storageKey,JSON.stringify(s))}catch(e){}}
var fb=san(appName+"-copy","app-copy");
var dt=san(C.defaultTarget,fb);
var st=Object.assign({minimized:C.initialMinimized},loadSt());
var h=document.createElement("div");
h.id="run402-fork-badge-host";
h.style.cssText="position:fixed;inset:0;pointer-events:none;z-index:2147483646;isolation:isolate";
document.documentElement.appendChild(h);
var sh=h.attachShadow({mode:"open"});
var sc=C.position==="bottom-left"?"r402-left":"r402-right";
var pc=st.minimized?"r402-panel":"r402-panel r402-entering";
sh.innerHTML='<style>:host{color-scheme:dark}*,*::before,*::after{box-sizing:border-box}.r402-anchor{position:fixed;bottom:max(16px,env(safe-area-inset-bottom));pointer-events:none;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#E5E7EB}.r402-right{right:max(16px,env(safe-area-inset-right))}.r402-left{left:max(16px,env(safe-area-inset-left))}.r402-panel,.r402-pill{position:absolute;bottom:0;visibility:hidden;opacity:0;transform:translateY(8px) scale(.985);pointer-events:none;transition:opacity 180ms ease,transform 180ms ease,box-shadow 180ms ease,border-color 180ms ease,visibility 0s linear 180ms;will-change:transform,opacity}.r402-right .r402-panel,.r402-right .r402-pill{right:0}.r402-left .r402-panel,.r402-left .r402-pill{left:0}.r402-anchor[data-state=expanded] .r402-panel{visibility:visible;opacity:1;transform:translateY(0) scale(1);pointer-events:auto;transition-delay:0s}.r402-anchor[data-state=minimized] .r402-pill{visibility:visible;opacity:1;transform:translateY(0) scale(1);pointer-events:auto;transition-delay:0s}.r402-panel{width:min(380px,calc(100vw - 24px));overflow:hidden;border-radius:16px;border:1px solid rgba(0,255,159,.18);background:radial-gradient(circle at top right,rgba(0,255,159,.08),transparent 34%),linear-gradient(180deg,rgba(18,18,26,.94),rgba(10,10,15,.96));box-shadow:0 18px 50px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.02) inset,0 0 24px rgba(0,255,159,.07);backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);transform-origin:bottom right}.r402-left .r402-panel{transform-origin:bottom left}.r402-panel.r402-entering{animation:r402-enter 240ms cubic-bezier(.2,.8,.2,1)}.r402-panel::after{content:"";position:absolute;top:0;left:-35%;width:35%;height:2px;background:linear-gradient(90deg,transparent,rgba(0,255,159,.9),transparent);opacity:0;animation:r402-scan 1400ms ease-out 120ms 1 both;pointer-events:none}.r402-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px 12px;border-bottom:1px solid rgba(255,255,255,.04)}.r402-kicker{display:inline-flex;align-items:center;gap:8px;min-width:0;font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#00FF9F}.r402-dot{width:8px;height:8px;flex:0 0 auto;border-radius:999px;background:#00FF9F}.r402-kicker .r402-dot{box-shadow:0 0 0 4px rgba(0,255,159,.10)}.r402-pill .r402-dot{box-shadow:0 0 0 0 rgba(0,255,159,.35);animation:r402-pulse 3.2s ease-in-out infinite}.r402-icon{appearance:none;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#9CA3AF;width:30px;height:30px;border-radius:9px;cursor:pointer;font:700 18px/1 "JetBrains Mono",ui-monospace,monospace;display:inline-flex;align-items:center;justify-content:center;padding:0}.r402-icon:hover{border-color:rgba(0,255,159,.22);background:rgba(0,255,159,.08);color:#E5E7EB;transform:translateY(-1px)}.r402-body{padding:14px 16px 0}.r402-title{margin:0 0 6px;font-size:16px;line-height:1.3;font-weight:700;color:#F3F4F6}.r402-text{margin:0 0 14px;font-size:13px;line-height:1.5;color:#9CA3AF}.r402-label{display:block;margin:0 0 8px;font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#6B7280}.r402-inputShell{display:flex;align-items:center;gap:8px;height:42px;padding:0 12px;margin-bottom:12px;border-radius:12px;border:1px solid rgba(0,255,159,.14);background:#101018}.r402-inputShell:focus-within{border-color:rgba(0,255,159,.34);box-shadow:0 0 0 3px rgba(0,255,159,.08)}.r402-input{flex:1 1 auto;min-width:0;border:0;outline:0;background:transparent;color:#E5E7EB;font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:600;caret-color:#00FF9F}.r402-input::placeholder{color:#4B5563}.r402-suffix{flex:0 0 auto;color:#6B7280;font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:600}.r402-codeShell{overflow:hidden;border-radius:12px;border:1px solid rgba(255,255,255,.06);background:#0F1016}.r402-codeHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#6B7280}.r402-inlineLink{color:#00FF9F;text-decoration:none}.r402-inlineLink:hover{text-decoration:underline}.r402-prompt{display:block;width:100%;min-height:88px;padding:12px 14px 14px;margin:0;border:0;outline:0;resize:none;background:linear-gradient(180deg,rgba(26,26,36,.94),rgba(13,13,19,.98));color:#FBBF24;font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;cursor:text}.r402-actions{padding:14px 16px 12px}.r402-copy{appearance:none;width:100%;height:44px;border-radius:12px;border:1px solid rgba(0,255,159,.32);background:linear-gradient(180deg,rgba(0,255,159,.14),rgba(0,255,159,.08));color:#00FF9F;font-size:14px;font-weight:700;cursor:pointer}.r402-copy:hover{border-color:rgba(0,255,159,.46);box-shadow:0 10px 24px rgba(0,255,159,.08);transform:translateY(-1px)}.r402-copy[data-state=success]{border-color:transparent;background:linear-gradient(180deg,rgba(0,255,159,.95),rgba(0,255,159,.8));color:#04110B}.r402-copy[data-state=fallback]{border-color:rgba(251,191,36,.28);background:linear-gradient(180deg,rgba(251,191,36,.12),rgba(251,191,36,.08));color:#FBBF24}.r402-meta{padding:0 16px 16px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;line-height:1.5;color:#6B7280}.r402-sep{color:#4B5563}.r402-pill{display:inline-flex;align-items:center;gap:10px;height:40px;max-width:calc(100vw - 24px);padding:0 14px;border-radius:999px;border:1px solid rgba(0,255,159,.22);background:rgba(10,10,15,.92);color:#E5E7EB;backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);box-shadow:0 10px 28px rgba(0,0,0,.38),0 0 0 1px rgba(255,255,255,.02) inset,0 0 20px rgba(0,255,159,.07);font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}.r402-pill:hover{border-color:rgba(0,255,159,.42);box-shadow:0 12px 32px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.02) inset,0 0 26px rgba(0,255,159,.12);transform:translateY(-1px)}.r402-pillBrand{color:#00FF9F}.r402-live{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.r402-input::selection,.r402-prompt::selection{background:rgba(0,255,159,.22);color:#FFF}.r402-icon:focus-visible,.r402-copy:focus-visible,.r402-pill:focus-visible,.r402-inlineLink:focus-visible,.r402-prompt:focus-visible{outline:2px solid rgba(0,255,159,.42);outline-offset:2px}@keyframes r402-enter{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes r402-scan{0%{opacity:0;transform:translateX(0)}20%{opacity:1}100%{opacity:0;transform:translateX(420%)}}@keyframes r402-pulse{0%,100%{box-shadow:0 0 0 0 rgba(0,255,159,.34)}50%{box-shadow:0 0 0 6px rgba(0,255,159,0)}}@media(max-width:640px){.r402-anchor{left:max(12px,env(safe-area-inset-left));right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom))}.r402-panel{left:0!important;right:0!important;width:auto;transform-origin:bottom center}.r402-pill{right:0!important;left:auto!important}}@media(max-width:420px){.r402-pillBrand{display:none}}@media(prefers-reduced-motion:reduce){.r402-panel,.r402-pill,.r402-copy,.r402-icon{transition:none!important;animation:none!important}.r402-panel::after,.r402-pill .r402-dot{animation:none!important}}</style><div class="r402-anchor '+sc+'" data-state="'+(st.minimized?"minimized":"expanded")+'"><button class="r402-pill" id="r402-open" type="button" aria-label="Show Run402 fork prompt"><span class="r402-dot" aria-hidden="true"></span><span>Forkable <span class="r402-pillBrand">Run402</span></span></button><section class="'+pc+'" id="r402-panel" aria-label="Fork this app on Run402"><div class="r402-header"><div class="r402-kicker"><span class="r402-dot" aria-hidden="true"></span><span>Forkable on Run402</span></div><button class="r402-icon" id="r402-minimize" type="button" aria-label="Minimize Run402 fork prompt">\\u2013</button></div><div class="r402-body"><h2 class="r402-title" id="r402-title"></h2><p class="r402-text" id="r402-text"></p><label class="r402-label" for="r402-target">New subdomain</label><div class="r402-inputShell"><input id="r402-target" class="r402-input" type="text" inputmode="url" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="'+dt+'"/><span class="r402-suffix">.'+rootDomain+'</span></div><div class="r402-codeShell"><div class="r402-codeHeader"><span>Agent prompt</span><a class="r402-inlineLink" id="r402-docs" href="'+llmsUrl+'" target="_blank" rel="noopener">llms.txt</a></div><textarea id="r402-prompt" class="r402-prompt" readonly rows="3"></textarea></div></div><div class="r402-actions"><button class="r402-copy" id="r402-copy" type="button" data-state="idle">Copy agent prompt</button></div><div class="r402-meta" id="r402-meta"><span>Fork is free; normal hosting applies.</span><span class="r402-sep" id="r402-sep">\\u00b7</span><span id="r402-rewards"></span></div><div class="r402-live" id="r402-live" aria-live="polite" aria-atomic="true"></div></section></div>';
var anchor=sh.querySelector(".r402-anchor");
var panel=sh.getElementById("r402-panel");
var openBtn=sh.getElementById("r402-open");
var minBtn=sh.getElementById("r402-minimize");
var tInput=sh.getElementById("r402-target");
var pArea=sh.getElementById("r402-prompt");
var cpBtn=sh.getElementById("r402-copy");
var tEl=sh.getElementById("r402-title");
var txEl=sh.getElementById("r402-text");
var rwEl=sh.getElementById("r402-rewards");
var spEl=sh.getElementById("r402-sep");
var lvEl=sh.getElementById("r402-live");
tEl.textContent=C.title;
txEl.textContent=C.bodyText;
rwEl.textContent=C.rewardsText;
if(!C.showRewards){rwEl.hidden=true;spEl.hidden=true}
tInput.value=dt;
function bp(){var n=san(tInput.value,dt);return"Read "+llmsUrl+", then "+C.promptVerb+" the published app at "+appUrl+" into https://"+n+"."+rootDomain+" on Run402."}
function up(){pArea.value=bp()}
function ann(m){lvEl.textContent="";requestAnimationFrame(function(){lvEl.textContent=m})}
function setMin(min,opts){
var mf=opts&&opts.moveFocus;
st.minimized=min;saveSt(st);
anchor.dataset.state=min?"minimized":"expanded";
panel.setAttribute("aria-hidden",String(min));
openBtn.setAttribute("aria-hidden",String(!min));
openBtn.setAttribute("aria-expanded",String(!min));
openBtn.tabIndex=min?0:-1;
if(min){panel.setAttribute("inert","");if(mf)openBtn.focus({preventScroll:true})}
else{panel.removeAttribute("inert");if(mf)cpBtn.focus({preventScroll:true})}
}
var rt=0;
function scs(l,m,d){clearTimeout(rt);cpBtn.textContent=l;cpBtn.dataset.state=m;rt=setTimeout(function(){cpBtn.textContent="Copy agent prompt";cpBtn.dataset.state="idle"},d||1600)}
async function cp(){
var t=pArea.value;
try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(t)}else{pArea.focus();pArea.select();if(!document.execCommand("copy"))throw 0}ann("Agent prompt copied to clipboard.");scs("Copied","success")}
catch(e){pArea.focus();pArea.select();ann("Prompt selected. Press Command C or Control C to copy.");scs("Press Ctrl/Cmd+C","fallback",2200)}
}
tInput.addEventListener("input",up);
tInput.addEventListener("blur",function(){tInput.value=san(tInput.value,dt);up()});
pArea.addEventListener("focus",function(){pArea.select()});
pArea.addEventListener("click",function(){setTimeout(function(){pArea.select()},0)});
panel.addEventListener("keydown",function(e){if(e.key==="Escape"){e.stopPropagation();setMin(true,{moveFocus:true})}});
cpBtn.addEventListener("click",cp);
openBtn.addEventListener("click",function(){setMin(false,{moveFocus:true})});
minBtn.addEventListener("click",function(){setMin(true,{moveFocus:true})});
up();setMin(!!st.minimized,{moveFocus:false});
})()`;
