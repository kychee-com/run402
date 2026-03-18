function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function fmt(n){return Number(n).toLocaleString()}
function pct(n){return n.toFixed(1)+'%'}
function pillClass(v,warn,bad){return v>=bad?'pill-red':v>=warn?'pill-yellow':'pill-green'}

async function load(){
  try{
    const r=await fetch('/admin/api/stats');
    if(r.status===401){location.href='/admin/login';return}
    const d=await r.json();
    render(d);
    document.getElementById('ts').textContent='Updated: '+new Date().toLocaleString();
  }catch(e){
    document.getElementById('content').innerHTML='<div class="loading" style="color:#FF5050">Failed to load stats</div>';
  }
}

function render(d){
  const p=d.projects, u=d.usage, inf=d.infrastructure, b=d.billing;
  const slotPct=inf.slotsUtilization;
  const slotColor=slotPct>90?'bad':slotPct>70?'warn':'g';

  let html='<div class="grid">';
  html+='<div class="stat tip" data-tip="Projects with an active lease currently loaded in the in-memory cache"><div class="stat-label">Active Projects</div><div class="stat-value"><span class="g">'+fmt(p.active)+'</span></div></div>';
  html+='<div class="stat tip" data-tip="Total REST and SQL API calls across all projects since creation"><div class="stat-label">Total API Calls</div><div class="stat-value">'+fmt(u.totalApiCalls)+'</div></div>';
  html+='<div class="stat tip" data-tip="Combined S3 storage used by file uploads across all projects"><div class="stat-label">Storage Used</div><div class="stat-value">'+u.totalStorageMb+' <span style="font-size:14px;color:#9CA3AF">MB</span></div></div>';
  html+='<div class="stat tip" data-tip="Each project gets a Postgres schema slot. '+fmt(inf.slotsTotal)+' total slots. Green < 70%, yellow 70-90%, red > 90%"><div class="stat-label">Schema Slots</div><div class="stat-value"><span class="'+slotColor+'">'+fmt(inf.slotsUsed)+'</span> <span style="font-size:14px;color:#9CA3AF">/ '+fmt(inf.slotsTotal)+'</span></div>';
  html+='<div class="bar-wrap"><div class="bar-fill" style="width:'+slotPct+'%;background:'+(slotPct>90?'#FF5050':slotPct>70?'#FBBF24':'#00FF9F')+'"></div></div></div>';
  html+='<div class="stat tip" data-tip="Distinct Ethereum wallet addresses seen across all sources: faucet drips, billing accounts, projects, and charge authorizations"><div class="stat-label">Unique Wallets</div><div class="stat-value"><span class="g">'+fmt(b.uniqueWallets)+'</span></div></div>';
  html+='<div class="stat tip" data-tip="Accounts created via Stripe checkout or wallet-based billing. Each account can have multiple wallets"><div class="stat-label">Billing Accounts</div><div class="stat-value">'+fmt(b.accounts)+'</div></div>';
  html+='<div class="stat tip" data-tip="Sum of all prepaid USDC allowance across billing accounts (available_usd_micros / 1M)"><div class="stat-label">Total Allowance</div><div class="stat-value">$'+b.totalAvailableUsd.toFixed(2)+'</div></div>';
  html+='<div class="stat tip" data-tip="Custom subdomains claimed on *.run402.com, each pointing to a deployed project site"><div class="stat-label">Subdomains</div><div class="stat-value">'+fmt(inf.subdomains)+'</div></div>';
  html+='<div class="stat tip" data-tip="Lambda functions deployed by projects for serverless compute"><div class="stat-label">Functions</div><div class="stat-value">'+fmt(inf.functions)+'</div></div>';
  html+='</div>';

  // Projects by status
  html+='<div class="section"><h2><span class="dot"></span><span class="tip" data-tip="All projects in the database grouped by lifecycle status: active (leased), archived (lease expired, read-only), deleted (past grace period)">Projects by Status</span></h2><table><tr><th>Status</th><th>Count</th></tr>';
  for(const [s,c] of Object.entries(p.byStatus)){
    const cls=s==='active'?'pill-green':s==='archived'?'pill-yellow':s==='deleted'?'pill-red':'pill-gray';
    html+='<tr><td><span class="pill '+cls+'">'+esc(s)+'</span></td><td>'+fmt(c)+'</td></tr>';
  }
  html+='</table></div>';

  // Projects by tier
  html+='<div class="section"><h2><span class="dot"></span><span class="tip" data-tip="Active projects broken down by pricing tier. Pinned projects never expire. Expiring shows projects whose lease ends within 7 days">Active Projects by Tier</span></h2><table><tr><th>Tier</th><th>Count</th></tr>';
  for(const [t,c] of Object.entries(p.byTier)){
    html+='<tr><td>'+esc(t)+'</td><td>'+fmt(c)+'</td></tr>';
  }
  html+='<tr style="border-top:1px solid #1E1E2A"><td><strong>Pinned</strong></td><td>'+fmt(p.pinned)+'</td></tr>';
  html+='<tr><td><strong style="color:#FBBF24">Expiring in 7d</strong></td><td>'+fmt(p.expiringIn7d)+'</td></tr>';
  html+='</table></div>';

  // Faucet section
  const f=d.faucet;
  if(f && f.enabled){
    html+='<div class="section"><h2><span class="dot" style="background:#6366F1"></span><span class="tip" data-tip="Testnet USDC faucet on Base Sepolia. Gives 0.25 USDC per drip (1 per 24h per IP). Auto-refills from Coinbase CDP every ~2.4h">Faucet (Base Sepolia USDC)</span></h2>';

    // Balance stat card
    html+='<div class="grid" style="margin-bottom:16px">';
    html+='<div class="stat tip" data-tip="Live USDC balance of the treasury wallet on Base Sepolia. Red < $1, yellow < $5, green otherwise"><div class="stat-label">Treasury Balance</div><div class="stat-value">';
    if(f.balanceUsdc!==null){
      const bc=f.balanceUsdc<1?'bad':f.balanceUsdc<5?'warn':'g';
      html+='<span class="'+bc+'">$'+f.balanceUsdc.toFixed(2)+'</span> <span style="font-size:12px;color:#9CA3AF">USDC</span>';
    } else { html+='<span style="color:#4B5563">offline</span>'; }
    html+='</div>';
    if(f.treasuryAddress) html+='<div class="faucet-addr">'+esc(f.treasuryAddress)+'</div>';
    html+='</div>';
    const lastWallet=f.cumulativeWallets.length?f.cumulativeWallets[f.cumulativeWallets.length-1].v:0;
    html+='<div class="stat tip" data-tip="Distinct wallet addresses that have received at least one faucet drip (source=faucet in wallet_sightings)"><div class="stat-label">Total Faucet Wallets</div><div class="stat-value"><span class="g">'+fmt(lastWallet)+'</span></div></div>';
    html+='</div>';

    // Charts row
    html+='<div class="chart-row">';
    html+='<div class="chart-wrap"><div class="chart-header"><span class="chart-title tip" data-tip="Treasury USDC balance after each drip, refill, and periodic poll. Dips are drips, jumps are CDP refills">Balance Over Time</span></div><canvas id="cvBalance"></canvas></div>';
    html+='<div class="chart-wrap"><div class="chart-header"><span class="chart-title tip" data-tip="Running total of unique wallets that have requested a faucet drip, by day">Cumulative Wallets</span></div><canvas id="cvWallets"></canvas></div>';
    html+='</div>';
    html+='</div>';
  }

  // Admin Wallets section
  html+='<div class="section"><h2><span class="dot" style="background:#F59E0B"></span><span class="tip" data-tip="Wallet addresses authorized to call admin APIs via SIWX authentication. Admin wallets can pin/unpin projects, run SQL, and manage any project without a service key">Admin Wallets</span></h2>';
  html+='<div id="admin-wallets-content"><div class="loading">Loading...</div></div>';
  html+='<div style="margin-top:12px;display:flex;gap:8px;align-items:center">';
  html+='<input id="aw-address" type="text" placeholder="0x..." style="background:#12121A;border:1px solid #1E1E2A;border-radius:8px;padding:8px 12px;color:#E0E0E0;font-size:13px;font-family:monospace;flex:1;outline:none">';
  html+='<input id="aw-label" type="text" placeholder="Label (optional)" style="background:#12121A;border:1px solid #1E1E2A;border-radius:8px;padding:8px 12px;color:#E0E0E0;font-size:13px;width:160px;outline:none">';
  html+='<button onclick="addAdminWallet()" style="background:#F59E0B;color:#000;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">Add Wallet</button>';
  html+='</div>';
  html+='<div style="margin-top:6px;font-size:11px;color:#4B5563">Hint: run <code style="background:#1E1E2A;padding:2px 6px;border-radius:4px;color:#9CA3AF">run402 allowance export</code> to get your wallet address</div>';
  html+='</div>';

  document.getElementById('content').innerHTML=html;

  // Draw charts after DOM update
  if(f && f.enabled){
    if(f.balanceHistory.length>1) drawAreaChart('cvBalance',f.balanceHistory.map(function(p){return{t:new Date(p.t).getTime(),v:p.v}}),'#6366F1','$');
    else noData('cvBalance');
    if(f.cumulativeWallets.length>1) drawAreaChart('cvWallets',f.cumulativeWallets.map(function(p){return{t:new Date(p.d).getTime(),v:p.v}}),'#00FF9F','');
    else noData('cvWallets');
  }

  // Load admin wallets
  loadAdminWallets();
}

async function loadAdminWallets(){
  var el=document.getElementById('admin-wallets-content');
  if(!el)return;
  try{
    var r=await fetch('/admin/api/admin-wallets');
    var d=await r.json();
    var wallets=d.wallets||[];
    if(wallets.length===0){
      el.innerHTML='<div style="color:#4B5563;font-size:13px;padding:12px">No admin wallets configured</div>';
      return;
    }
    var h='<table><tr><th>Address</th><th>Label</th><th>Added By</th><th>Added</th><th></th></tr>';
    for(var i=0;i<wallets.length;i++){
      var w=wallets[i];
      h+='<tr><td style="font-family:monospace;font-size:12px">'+esc(w.address)+'</td>';
      h+='<td>'+(w.label?esc(w.label):'<span style="color:#4B5563">-</span>')+'</td>';
      h+='<td>'+esc(w.added_by)+'</td>';
      h+='<td style="color:#9CA3AF">'+new Date(w.added_at).toLocaleDateString()+'</td>';
      h+='<td><button onclick="removeAdminWallet(\''+esc(w.address)+'\')" style="background:none;border:1px solid #1E1E2A;border-radius:6px;color:#FF5050;padding:4px 10px;font-size:12px;cursor:pointer">Remove</button></td></tr>';
    }
    h+='</table>';
    el.innerHTML=h;
  }catch(e){
    el.innerHTML='<div style="color:#FF5050;font-size:13px">Failed to load admin wallets</div>';
  }
}

async function addAdminWallet(){
  var addr=document.getElementById('aw-address').value.trim();
  var label=document.getElementById('aw-label').value.trim();
  if(!addr){return}
  if(!/^0x[a-fA-F0-9]{40}$/.test(addr)){
    document.getElementById('aw-address').style.borderColor='#FF5050';
    return;
  }
  document.getElementById('aw-address').style.borderColor='#1E1E2A';
  try{
    var r=await fetch('/admin/api/admin-wallets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:addr,label:label||null})});
    if(!r.ok){var e=await r.json();alert(e.error||'Failed');return}
    document.getElementById('aw-address').value='';
    document.getElementById('aw-label').value='';
    loadAdminWallets();
  }catch(e){alert('Failed to add wallet')}
}

async function removeAdminWallet(addr){
  if(!confirm('Remove admin wallet '+addr+'?'))return;
  try{
    var r=await fetch('/admin/api/admin-wallets/'+encodeURIComponent(addr),{method:'DELETE'});
    if(!r.ok){var e=await r.json();alert(e.error||'Failed');return}
    loadAdminWallets();
  }catch(e){alert('Failed to remove wallet')}
}

function noData(id){
  var c=document.getElementById(id);
  if(!c)return;
  var ctx=c.getContext('2d');
  c.width=c.offsetWidth*2;c.height=c.offsetHeight*2;
  ctx.scale(2,2);
  ctx.fillStyle='#4B5563';ctx.font='13px system-ui';ctx.textAlign='center';
  ctx.fillText('No data yet',c.offsetWidth/2,c.offsetHeight/2);
}

function drawAreaChart(id,data,color,prefix){
  var c=document.getElementById(id);
  if(!c)return;
  var W=c.offsetWidth,H=c.offsetHeight;
  c.width=W*2;c.height=H*2;
  var ctx=c.getContext('2d');
  ctx.scale(2,2);

  var pad={t:24,r:12,b:28,l:48};
  var cw=W-pad.l-pad.r, ch=H-pad.t-pad.b;
  var vals=data.map(function(p){return p.v});
  var times=data.map(function(p){return p.t});
  var minV=Math.min.apply(null,vals)*0.9;
  var maxV=Math.max.apply(null,vals)*1.1;
  if(maxV===minV){maxV+=1;minV-=1}
  var minT=times[0],maxT=times[times.length-1];
  if(maxT===minT)maxT+=1;

  function x(t){return pad.l+(t-minT)/(maxT-minT)*cw}
  function y(v){return pad.t+ch-(v-minV)/(maxV-minV)*ch}

  // Grid lines
  ctx.strokeStyle='rgba(255,255,255,0.04)';ctx.lineWidth=1;
  for(var i=0;i<5;i++){
    var gy=pad.t+ch*i/4;
    ctx.beginPath();ctx.moveTo(pad.l,gy);ctx.lineTo(W-pad.r,gy);ctx.stroke();
  }

  // Y-axis labels
  ctx.fillStyle='#4B5563';ctx.font='10px system-ui';ctx.textAlign='right';
  for(var i=0;i<5;i++){
    var lv=minV+(maxV-minV)*(4-i)/4;
    ctx.fillText(prefix+(lv<10?lv.toFixed(2):Math.round(lv)),pad.l-6,pad.t+ch*i/4+3);
  }

  // X-axis labels
  ctx.textAlign='center';
  var labelCount=Math.min(5,data.length);
  for(var i=0;i<labelCount;i++){
    var idx=Math.round(i*(data.length-1)/(labelCount-1));
    var dt=new Date(data[idx].t);
    var label=(dt.getMonth()+1)+'/'+dt.getDate();
    ctx.fillText(label,x(data[idx].t),H-pad.b+16);
  }

  // Gradient fill
  var grad=ctx.createLinearGradient(0,pad.t,0,pad.t+ch);
  grad.addColorStop(0,color+'40');
  grad.addColorStop(1,color+'00');
  ctx.beginPath();
  ctx.moveTo(x(data[0].t),y(data[0].v));
  for(var i=1;i<data.length;i++) ctx.lineTo(x(data[i].t),y(data[i].v));
  ctx.lineTo(x(data[data.length-1].t),pad.t+ch);
  ctx.lineTo(x(data[0].t),pad.t+ch);
  ctx.closePath();
  ctx.fillStyle=grad;ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(x(data[0].t),y(data[0].v));
  for(var i=1;i<data.length;i++) ctx.lineTo(x(data[i].t),y(data[i].v));
  ctx.strokeStyle=color;ctx.lineWidth=2;ctx.lineJoin='round';ctx.stroke();

  // Glow effect
  ctx.shadowColor=color;ctx.shadowBlur=8;
  ctx.beginPath();
  ctx.moveTo(x(data[0].t),y(data[0].v));
  for(var i=1;i<data.length;i++) ctx.lineTo(x(data[i].t),y(data[i].v));
  ctx.strokeStyle=color+'80';ctx.lineWidth=1;ctx.stroke();
  ctx.shadowBlur=0;

  // Latest value dot
  var last=data[data.length-1];
  ctx.beginPath();ctx.arc(x(last.t),y(last.v),4,0,Math.PI*2);
  ctx.fillStyle=color;ctx.fill();
  ctx.beginPath();ctx.arc(x(last.t),y(last.v),8,0,Math.PI*2);
  ctx.fillStyle=color+'20';ctx.fill();

  // Interactive hover tooltip
  var tooltip=document.createElement('div');
  tooltip.className='chart-tip';
  tooltip.style.cssText='position:absolute;display:none;background:#1E1E2A;color:#E0E0E0;font-size:12px;padding:6px 10px;border-radius:6px;border:1px solid #2A2A3A;pointer-events:none;white-space:nowrap;z-index:10;box-shadow:0 4px 12px rgba(0,0,0,.4)';
  c.parentNode.style.position='relative';
  c.parentNode.appendChild(tooltip);

  c.addEventListener('mousemove',function(e){
    var rect=c.getBoundingClientRect();
    var mx=e.clientX-rect.left;
    // Find nearest data point
    var best=0,bestDist=Infinity;
    for(var i=0;i<data.length;i++){
      var dx=Math.abs(x(data[i].t)/2*c.offsetWidth/(W)-mx); // approximate
      var px=(data[i].t-minT)/(maxT-minT)*cw+pad.l;
      var screenX=px*c.offsetWidth/W;
      var dist=Math.abs(screenX-mx);
      if(dist<bestDist){bestDist=dist;best=i}
    }
    var pt=data[best];
    var dt=new Date(pt.t);
    var dateStr=dt.toLocaleDateString()+' '+dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    var valStr=prefix+(pt.v<10?pt.v.toFixed(2):Math.round(pt.v).toLocaleString());
    tooltip.innerHTML='<span style="color:'+color+'">'+valStr+'</span><br><span style="color:#4B5563">'+dateStr+'</span>';
    tooltip.style.display='block';
    var tx=e.clientX-rect.left-tooltip.offsetWidth/2;
    var ty=e.clientY-rect.top-tooltip.offsetHeight-12;
    if(tx<0)tx=0;if(tx+tooltip.offsetWidth>rect.width)tx=rect.width-tooltip.offsetWidth;
    tooltip.style.left=tx+'px';tooltip.style.top=ty+'px';
  });
  c.addEventListener('mouseleave',function(){tooltip.style.display='none'});
}

load();
setInterval(load, 30000);
