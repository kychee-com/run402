/**
 * Admin llms.txt analytics page — CloudFront log analysis.
 *
 * Routes:
 *   GET /admin/llms-txt          — analytics page (requires session)
 *   GET /admin/api/llms-txt-stats — JSON stats (requires session)
 */

import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { ADMIN_SESSION_SECRET } from "../config.js";
import { asyncHandler } from "../utils/async-handler.js";
import { getCfLogStats } from "../services/cf-logs.js";

const router = Router();

const SESSION_COOKIE = "run402_admin";

function hmacSign(payload: string): string {
  return crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update(payload).digest("hex");
}

function getSession(req: Request): { email: string; name: string } | null {
  const raw = req.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const cookie = raw.split("=").slice(1).join("=");
  const [b64, sig] = cookie.split(".");
  if (!b64 || !sig) return null;
  if (!crypto.timingSafeEqual(Buffer.from(hmacSign(b64), "hex"), Buffer.from(sig, "hex"))) return null;
  try {
    const data = JSON.parse(Buffer.from(b64, "base64url").toString());
    if (data.exp < Date.now()) return null;
    return { email: data.email, name: data.name };
  } catch { return null; }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- Stats API ----

router.get("/admin/api/llms-txt-stats", asyncHandler(async (req: Request, res: Response) => {
  const session = getSession(req);
  if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
  const stats = await getCfLogStats();
  res.json(stats);
}));

// ---- Page ----

router.get("/admin/llms-txt", asyncHandler(async (req: Request, res: Response) => {
  const session = getSession(req);
  if (!session) { res.redirect("/admin/login"); return; }
  res.type("html").send(page(session.name, session.email));
}));

function page(name: string, email: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Run402 Admin — llms.txt Analytics</title>
<link rel="icon" href="https://run402.com/favicon.svg" type="image/svg+xml">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0A0A0F;color:#E0E0E0;font-family:system-ui,sans-serif;min-height:100vh}
.wrap{max-width:960px;margin:0 auto;padding:40px 24px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:40px;flex-wrap:wrap;gap:12px}
h1{font-size:24px;color:#fff}
h1 .g{color:#00FF9F}
h1 .sub{font-size:14px;color:#9CA3AF;font-weight:400;margin-left:8px}
.nav{display:flex;align-items:center;gap:12px;font-size:13px;color:#9CA3AF}
.nav a{color:#9CA3AF;text-decoration:none;padding:6px 12px;border:1px solid #1E1E2A;border-radius:6px;transition:border-color .2s,color .2s}
.nav a:hover,.nav a.active{border-color:#00FF9F;color:#00FF9F}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-bottom:32px}
.stat{background:#12121A;border:1px solid #1E1E2A;border-radius:12px;padding:20px}
.stat-label{font-size:11px;color:#4B5563;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}
.stat-value{font-size:28px;font-weight:700;color:#fff;font-variant-numeric:tabular-nums}
.stat-value .g{color:#00FF9F}
.stat-value .dim{font-size:14px;color:#9CA3AF;font-weight:400}
.section{margin-bottom:32px}
.section h2{font-size:16px;color:#fff;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.section h2 .dot{width:8px;height:8px;border-radius:50%;background:#00FF9F}
table{width:100%;border-collapse:collapse;background:#12121A;border:1px solid #1E1E2A;border-radius:12px;overflow:hidden}
th{text-align:left;font-size:11px;color:#4B5563;text-transform:uppercase;letter-spacing:.8px;padding:12px 16px;border-bottom:1px solid #1E1E2A}
td{padding:10px 16px;font-size:13px;border-bottom:1px solid rgba(255,255,255,0.03);font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
.pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500}
.pill-green{background:rgba(0,255,159,0.1);color:#00FF9F}
.pill-blue{background:rgba(99,102,241,0.1);color:#818CF8}
.pill-yellow{background:rgba(251,191,36,0.1);color:#FBBF24}
.pill-red{background:rgba(255,80,80,0.1);color:#FF5050}
.pill-gray{background:rgba(255,255,255,0.05);color:#9CA3AF}
.pill-cyan{background:rgba(34,211,238,0.1);color:#22D3EE}
.pill-purple{background:rgba(168,85,247,0.1);color:#A855F7}
.chart-wrap{background:#12121A;border:1px solid #1E1E2A;border-radius:12px;padding:20px 20px 12px;position:relative}
.chart-wrap canvas{width:100%;height:200px;display:block}
.chart-header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}
.chart-title{font-size:13px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.8px}
.chart-value{font-size:22px;font-weight:700;color:#fff;font-variant-numeric:tabular-nums}
.chart-value .g{color:#00FF9F}
.chart-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:32px}
.tip{position:relative;cursor:help}
.tip::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:#1E1E2A;color:#E0E0E0;font-size:12px;font-weight:400;line-height:1.5;padding:8px 12px;border-radius:8px;border:1px solid #2A2A3A;white-space:normal;width:max-content;max-width:260px;pointer-events:none;opacity:0;transition:opacity .15s;z-index:10;text-transform:none;letter-spacing:normal;box-shadow:0 4px 12px rgba(0,0,0,.4)}
.tip:hover::after{opacity:1}
.tip::before{content:'';position:absolute;bottom:calc(100% + 2px);left:50%;transform:translateX(-50%);border:6px solid transparent;border-top-color:#1E1E2A;pointer-events:none;opacity:0;transition:opacity .15s;z-index:10}
.tip:hover::before{opacity:1}
.loading{color:#4B5563;font-size:13px;text-align:center;padding:40px}
.ts{color:#4B5563;font-size:12px;text-align:center;margin-top:24px}
.bar-inline{display:inline-block;height:14px;border-radius:3px;vertical-align:middle;margin-right:6px}
.unavailable{background:#12121A;border:1px solid #1E1E2A;border-radius:12px;padding:40px;text-align:center;color:#9CA3AF}
.unavailable .title{font-size:18px;color:#fff;margin-bottom:8px}
@media(max-width:600px){.grid{grid-template-columns:1fr 1fr}.chart-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1><span class="g">run402</span> admin<span class="sub">llms.txt analytics</span></h1>
    <div class="nav">
      <a href="/admin">Dashboard</a>
      <a href="/admin/llms-txt" class="active">llms.txt</a>
      <span>${escHtml(name)}</span>
      <a href="/admin/logout">Logout</a>
    </div>
  </header>

  <div id="content"><div class="loading">Loading analytics...</div></div>
  <div class="ts" id="ts"></div>
</div>

<script>
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function fmt(n){return Number(n).toLocaleString()}

var CATEGORY_PILLS={
  'python':'pill-green','curl':'pill-yellow','jvm':'pill-blue',
  'go':'pill-cyan','rust':'pill-purple','node-client':'pill-yellow',
  'claude':'pill-green','openai':'pill-green',
  'bot':'pill-gray','browser':'pill-gray','internal':'pill-gray','other':'pill-gray'
};

async function load(){
  try{
    var r=await fetch('/admin/api/llms-txt-stats');
    if(r.status===401){location.href='/admin/login';return}
    var d=await r.json();
    render(d);
    document.getElementById('ts').textContent='Updated: '+new Date().toLocaleString()+' (cached 5 min)';
  }catch(e){
    document.getElementById('content').innerHTML='<div class="loading" style="color:#FF5050">Failed to load analytics</div>';
  }
}

function render(d){
  if(!d.available){
    document.getElementById('content').innerHTML='<div class="unavailable"><div class="title">CloudFront logs not available</div><p>Set CF_LOG_BUCKET environment variable to enable.</p></div>';
    return;
  }

  var html='';

  // ---- Summary cards ----
  html+='<div class="grid">';
  html+='<div class="stat tip" data-tip="Total llms.txt fetches since logging was enabled"><div class="stat-label">llms.txt (all time)</div><div class="stat-value"><span class="g">'+fmt(d.allTime.llmsTxt)+'</span></div></div>';
  html+='<div class="stat tip" data-tip="llms.txt fetches in the last 24 hours"><div class="stat-label">llms.txt (24h)</div><div class="stat-value"><span class="g">'+fmt(d.last24h.llmsTxt)+'</span></div></div>';
  html+='<div class="stat tip" data-tip="Total openapi.json fetches since logging was enabled"><div class="stat-label">openapi.json (all time)</div><div class="stat-value">'+fmt(d.allTime.openapiJson)+'</div></div>';
  html+='<div class="stat tip" data-tip="openapi.json fetches in the last 24 hours"><div class="stat-label">openapi.json (24h)</div><div class="stat-value">'+fmt(d.last24h.openapiJson)+'</div></div>';
  html+='<div class="stat tip" data-tip="Distinct IP addresses that fetched agent-relevant files"><div class="stat-label">Unique IPs</div><div class="stat-value">'+fmt(d.uniqueIps)+'</div></div>';
  html+='<div class="stat tip" data-tip="Data covers '+esc(d.firstLog||'?')+' to '+esc(d.lastLog||'?')+'"><div class="stat-label">Log Range</div><div class="stat-value" style="font-size:16px">'+esc(d.firstLog||'—')+' <span class="dim">to</span> '+esc(d.lastLog||'—')+'</div></div>';
  html+='</div>';

  // ---- Charts ----
  html+='<div class="chart-row">';
  html+='<div class="chart-wrap"><div class="chart-header"><span class="chart-title">Hourly (last 24h)</span><span class="chart-value"><span class="g">'+fmt(d.last24h.llmsTxt+d.last24h.openapiJson)+'</span> <span class="dim">hits</span></span></div><canvas id="cvHourly"></canvas></div>';
  html+='<div class="chart-wrap"><div class="chart-header"><span class="chart-title">Daily (all time)</span><span class="chart-value"><span class="g">'+fmt(d.allTime.llmsTxt)+'</span> <span class="dim">total</span></span></div><canvas id="cvDaily"></canvas></div>';
  html+='</div>';

  // ---- Path breakdown ----
  html+='<div class="section"><h2><span class="dot"></span>Agent File Hits (All Time)</h2><table><tr><th>Path</th><th>Hits</th><th>Bar</th></tr>';
  var maxHits=d.agentFiles.length?d.agentFiles[0].hits:1;
  for(var i=0;i<d.agentFiles.length;i++){
    var af=d.agentFiles[i];
    var pct=Math.max(2,af.hits/maxHits*100);
    html+='<tr><td><code>'+esc(af.path)+'</code></td><td>'+fmt(af.hits)+'</td><td><div class="bar-inline" style="width:'+pct+'%;background:#00FF9F40"></div></td></tr>';
  }
  html+='</table></div>';

  // ---- User-Agent table ----
  html+='<div class="section"><h2><span class="dot" style="background:#6366F1"></span>Who reads llms.txt? (User-Agents)</h2><table><tr><th>User-Agent</th><th>Type</th><th>Hits</th></tr>';
  for(var i=0;i<d.userAgents.length;i++){
    var ua=d.userAgents[i];
    var pillCls=CATEGORY_PILLS[ua.category]||'pill-gray';
    html+='<tr><td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(ua.agent)+'"><code style="font-size:12px">'+esc(ua.agent)+'</code></td>';
    html+='<td><span class="pill '+pillCls+'">'+esc(ua.category)+'</span></td>';
    html+='<td>'+fmt(ua.hits)+'</td></tr>';
  }
  if(!d.userAgents.length) html+='<tr><td colspan="3" style="color:#4B5563;text-align:center">No data yet</td></tr>';
  html+='</table></div>';

  document.getElementById('content').innerHTML=html;

  // Draw charts
  if(d.hourly24h.length>1) drawBarChart('cvHourly',d.hourly24h.map(function(p){return{label:p.hour.slice(11,16),v:p.hits}}),'#00FF9F');
  else noData('cvHourly');

  // Aggregate daily data for llms.txt
  var dailyLlms={};
  for(var i=0;i<d.daily.length;i++){
    var row=d.daily[i];
    if(row.path==='/llms.txt'){
      dailyLlms[row.date]=(dailyLlms[row.date]||0)+row.hits;
    }
  }
  var dailyData=Object.keys(dailyLlms).sort().map(function(date){return{t:new Date(date+'T12:00:00Z').getTime(),v:dailyLlms[date]}});
  if(dailyData.length>1) drawAreaChart('cvDaily',dailyData,'#6366F1','');
  else noData('cvDaily');
}

function noData(id){
  var c=document.getElementById(id);if(!c)return;
  var ctx=c.getContext('2d');
  c.width=c.offsetWidth*2;c.height=c.offsetHeight*2;
  ctx.scale(2,2);
  ctx.fillStyle='#4B5563';ctx.font='13px system-ui';ctx.textAlign='center';
  ctx.fillText('No data yet',c.offsetWidth/2,c.offsetHeight/2);
}

function drawBarChart(id,data,color){
  var c=document.getElementById(id);if(!c)return;
  var W=c.offsetWidth,H=c.offsetHeight;
  c.width=W*2;c.height=H*2;
  var ctx=c.getContext('2d');ctx.scale(2,2);

  var pad={t:20,r:12,b:32,l:40};
  var cw=W-pad.l-pad.r,ch=H-pad.t-pad.b;
  var vals=data.map(function(d){return d.v});
  var maxV=Math.max.apply(null,vals);
  if(maxV===0)maxV=1;

  var barW=Math.max(2,cw/data.length-2);
  var gap=(cw-barW*data.length)/(data.length);

  // Grid lines
  ctx.strokeStyle='rgba(255,255,255,0.04)';ctx.lineWidth=1;
  for(var i=0;i<5;i++){
    var gy=pad.t+ch*i/4;
    ctx.beginPath();ctx.moveTo(pad.l,gy);ctx.lineTo(W-pad.r,gy);ctx.stroke();
  }

  // Y-axis labels
  ctx.fillStyle='#4B5563';ctx.font='10px system-ui';ctx.textAlign='right';
  for(var i=0;i<5;i++){
    var lv=maxV*(4-i)/4;
    ctx.fillText(Math.round(lv).toString(),pad.l-6,pad.t+ch*i/4+3);
  }

  // Bars
  for(var i=0;i<data.length;i++){
    var bx=pad.l+i*(barW+gap)+gap/2;
    var bh=data[i].v/maxV*ch;
    var by=pad.t+ch-bh;

    // Gradient bar
    var grad=ctx.createLinearGradient(0,by,0,pad.t+ch);
    grad.addColorStop(0,color);
    grad.addColorStop(1,color+'20');
    ctx.fillStyle=grad;

    // Rounded top
    var r=Math.min(3,barW/2);
    ctx.beginPath();
    ctx.moveTo(bx,pad.t+ch);
    ctx.lineTo(bx,by+r);
    ctx.quadraticCurveTo(bx,by,bx+r,by);
    ctx.lineTo(bx+barW-r,by);
    ctx.quadraticCurveTo(bx+barW,by,bx+barW,by+r);
    ctx.lineTo(bx+barW,pad.t+ch);
    ctx.closePath();
    ctx.fill();

    // Glow
    ctx.shadowColor=color;ctx.shadowBlur=6;
    ctx.fill();
    ctx.shadowBlur=0;
  }

  // X-axis labels (every 3-6 hours)
  ctx.fillStyle='#4B5563';ctx.font='10px system-ui';ctx.textAlign='center';
  var step=data.length<=12?2:data.length<=24?4:6;
  for(var i=0;i<data.length;i+=step){
    var lx=pad.l+i*(barW+gap)+gap/2+barW/2;
    ctx.fillText(data[i].label,lx,H-pad.b+16);
  }

  // Tooltip
  var tooltip=document.createElement('div');
  tooltip.style.cssText='position:absolute;display:none;background:#1E1E2A;color:#E0E0E0;font-size:12px;padding:6px 10px;border-radius:6px;border:1px solid #2A2A3A;pointer-events:none;white-space:nowrap;z-index:10;box-shadow:0 4px 12px rgba(0,0,0,.4)';
  c.parentNode.style.position='relative';
  c.parentNode.appendChild(tooltip);

  c.addEventListener('mousemove',function(e){
    var rect=c.getBoundingClientRect();
    var mx=e.clientX-rect.left;
    var idx=Math.floor((mx/c.offsetWidth*W-pad.l)/(barW+gap));
    if(idx<0)idx=0;if(idx>=data.length)idx=data.length-1;
    var pt=data[idx];
    tooltip.innerHTML='<span style="color:'+color+'">'+pt.v+' hits</span><br><span style="color:#4B5563">'+pt.label+'</span>';
    tooltip.style.display='block';
    var tx=e.clientX-rect.left-tooltip.offsetWidth/2;
    var ty=e.clientY-rect.top-tooltip.offsetHeight-12;
    if(tx<0)tx=0;if(tx+tooltip.offsetWidth>rect.width)tx=rect.width-tooltip.offsetWidth;
    tooltip.style.left=tx+'px';tooltip.style.top=ty+'px';
  });
  c.addEventListener('mouseleave',function(){tooltip.style.display='none'});
}

function drawAreaChart(id,data,color,prefix){
  var c=document.getElementById(id);if(!c)return;
  var W=c.offsetWidth,H=c.offsetHeight;
  c.width=W*2;c.height=H*2;
  var ctx=c.getContext('2d');ctx.scale(2,2);

  var pad={t:24,r:12,b:28,l:48};
  var cw=W-pad.l-pad.r,ch=H-pad.t-pad.b;
  var vals=data.map(function(p){return p.v});
  var times=data.map(function(p){return p.t});
  var minV=0;
  var maxV=Math.max.apply(null,vals)*1.2;
  if(maxV===0)maxV=1;
  var minT=times[0],maxT=times[times.length-1];
  if(maxT===minT)maxT+=1;

  function x(t){return pad.l+(t-minT)/(maxT-minT)*cw}
  function y(v){return pad.t+ch-(v-minV)/(maxV-minV)*ch}

  // Grid
  ctx.strokeStyle='rgba(255,255,255,0.04)';ctx.lineWidth=1;
  for(var i=0;i<5;i++){
    var gy=pad.t+ch*i/4;
    ctx.beginPath();ctx.moveTo(pad.l,gy);ctx.lineTo(W-pad.r,gy);ctx.stroke();
  }

  // Y labels
  ctx.fillStyle='#4B5563';ctx.font='10px system-ui';ctx.textAlign='right';
  for(var i=0;i<5;i++){
    var lv=minV+(maxV-minV)*(4-i)/4;
    ctx.fillText(prefix+Math.round(lv),pad.l-6,pad.t+ch*i/4+3);
  }

  // X labels
  ctx.textAlign='center';
  var labelCount=Math.min(6,data.length);
  for(var i=0;i<labelCount;i++){
    var idx=Math.round(i*(data.length-1)/(labelCount-1));
    var dt=new Date(data[idx].t);
    ctx.fillText((dt.getMonth()+1)+'/'+dt.getDate(),x(data[idx].t),H-pad.b+16);
  }

  // Fill
  var grad=ctx.createLinearGradient(0,pad.t,0,pad.t+ch);
  grad.addColorStop(0,color+'40');
  grad.addColorStop(1,color+'00');
  ctx.beginPath();ctx.moveTo(x(data[0].t),y(data[0].v));
  for(var i=1;i<data.length;i++)ctx.lineTo(x(data[i].t),y(data[i].v));
  ctx.lineTo(x(data[data.length-1].t),pad.t+ch);
  ctx.lineTo(x(data[0].t),pad.t+ch);
  ctx.closePath();ctx.fillStyle=grad;ctx.fill();

  // Line
  ctx.beginPath();ctx.moveTo(x(data[0].t),y(data[0].v));
  for(var i=1;i<data.length;i++)ctx.lineTo(x(data[i].t),y(data[i].v));
  ctx.strokeStyle=color;ctx.lineWidth=2;ctx.lineJoin='round';ctx.stroke();

  // Glow
  ctx.shadowColor=color;ctx.shadowBlur=8;
  ctx.beginPath();ctx.moveTo(x(data[0].t),y(data[0].v));
  for(var i=1;i<data.length;i++)ctx.lineTo(x(data[i].t),y(data[i].v));
  ctx.strokeStyle=color+'80';ctx.lineWidth=1;ctx.stroke();
  ctx.shadowBlur=0;

  // Dots for each data point
  for(var i=0;i<data.length;i++){
    ctx.beginPath();ctx.arc(x(data[i].t),y(data[i].v),3,0,Math.PI*2);
    ctx.fillStyle=color;ctx.fill();
  }

  // Latest value dot (larger)
  var last=data[data.length-1];
  ctx.beginPath();ctx.arc(x(last.t),y(last.v),5,0,Math.PI*2);
  ctx.fillStyle=color;ctx.fill();
  ctx.beginPath();ctx.arc(x(last.t),y(last.v),10,0,Math.PI*2);
  ctx.fillStyle=color+'20';ctx.fill();

  // Tooltip
  var tooltip=document.createElement('div');
  tooltip.style.cssText='position:absolute;display:none;background:#1E1E2A;color:#E0E0E0;font-size:12px;padding:6px 10px;border-radius:6px;border:1px solid #2A2A3A;pointer-events:none;white-space:nowrap;z-index:10;box-shadow:0 4px 12px rgba(0,0,0,.4)';
  c.parentNode.style.position='relative';
  c.parentNode.appendChild(tooltip);

  c.addEventListener('mousemove',function(e){
    var rect=c.getBoundingClientRect();
    var mx=e.clientX-rect.left;
    var best=0,bestDist=Infinity;
    for(var i=0;i<data.length;i++){
      var px=(data[i].t-minT)/(maxT-minT)*cw+pad.l;
      var screenX=px*c.offsetWidth/W;
      var dist=Math.abs(screenX-mx);
      if(dist<bestDist){bestDist=dist;best=i}
    }
    var pt=data[best];
    var dt=new Date(pt.t);
    tooltip.innerHTML='<span style="color:'+color+'">'+pt.v+' hits</span><br><span style="color:#4B5563">'+dt.toLocaleDateString()+'</span>';
    tooltip.style.display='block';
    var tx=e.clientX-rect.left-tooltip.offsetWidth/2;
    var ty=e.clientY-rect.top-tooltip.offsetHeight-12;
    if(tx<0)tx=0;if(tx+tooltip.offsetWidth>rect.width)tx=rect.width-tooltip.offsetWidth;
    tooltip.style.left=tx+'px';tooltip.style.top=ty+'px';
  });
  c.addEventListener('mouseleave',function(){tooltip.style.display='none'});
}

load();
setInterval(load,60000);
</script>
</body>
</html>`;
}

export default router;
