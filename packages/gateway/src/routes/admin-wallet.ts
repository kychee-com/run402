/**
 * Admin wallet detail page — shows all data for a single wallet address.
 *
 * Routes:
 *   GET /admin/wallet/:address          — wallet detail page (requires session)
 *   GET /admin/api/wallet/:address      — JSON wallet data (requires session)
 */

import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { ADMIN_SESSION_SECRET } from "../config.js";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { asyncHandler } from "../utils/async-handler.js";

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

// ---- Wallet stats API ----

router.get("/admin/api/wallet/:address", asyncHandler(async (req: Request, res: Response) => {
  const session = getSession(req);
  if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }

  const address = (req.params.address as string).toLowerCase();

  const [
    billingRes,
    projectsRes,
    subdomainsRes,
    functionsRes,
    ledgerRes,
    chargesRes,
    sightingRes,
    contactRes,
    topupsRes,
  ] = await Promise.all([
    // Billing account
    pool.query(sql(`
      SELECT ba.id, ba.status, ba.available_usd_micros, ba.held_usd_micros,
             ba.tier, ba.lease_started_at, ba.lease_expires_at,
             ba.funding_policy, ba.primary_contact_email, ba.created_at
      FROM internal.billing_accounts ba
      JOIN internal.billing_account_wallets baw ON baw.billing_account_id = ba.id
      WHERE baw.wallet_address = $1
    `), [address]),
    // Projects
    pool.query(sql(`
      SELECT id, name, schema_slot, tier, status, api_calls, storage_bytes,
             pinned, demo_mode, created_at
      FROM internal.projects
      WHERE wallet_address = $1
      ORDER BY created_at DESC
    `), [address]),
    // Subdomains (for all projects owned by this wallet)
    pool.query(sql(`
      SELECT s.name, s.project_id, s.created_at
      FROM internal.subdomains s
      WHERE s.project_id IN (SELECT id FROM internal.projects WHERE wallet_address = $1)
      ORDER BY s.created_at DESC
    `), [address]),
    // Functions (for all projects owned by this wallet)
    pool.query(sql(`
      SELECT f.id, f.project_id, f.name, f.runtime, f.timeout_seconds, f.memory_mb, f.created_at
      FROM internal.functions f
      WHERE f.project_id IN (SELECT id FROM internal.projects WHERE wallet_address = $1)
      ORDER BY f.created_at DESC
    `), [address]),
    // Recent ledger entries
    pool.query(sql(`
      SELECT al.direction, al.kind, al.amount_usd_micros, al.balance_after_available,
             al.reference_type, al.reference_id, al.metadata, al.created_at
      FROM internal.allowance_ledger al
      JOIN internal.billing_account_wallets baw ON baw.billing_account_id = al.billing_account_id
      WHERE baw.wallet_address = $1
      ORDER BY al.created_at DESC
      LIMIT 50
    `), [address]),
    // Charge authorizations
    pool.query(sql(`
      SELECT id, sku, amount_usd_micros, status, created_at
      FROM internal.charge_authorizations
      WHERE wallet_address = $1
      ORDER BY created_at DESC
      LIMIT 50
    `), [address]),
    // Wallet sighting
    pool.query(sql(`
      SELECT wallet_address, first_seen_at, last_seen_at, source
      FROM internal.wallet_sightings
      WHERE wallet_address = $1
    `), [address]),
    // Agent contact
    pool.query(sql(`
      SELECT name, email, webhook, created_at
      FROM internal.agent_contacts
      WHERE wallet_address = $1
    `), [address]).catch(() => ({ rows: [] })),
    // Stripe topups
    pool.query(sql(`
      SELECT bt.status, bt.funded_usd_micros, bt.charged_usd_cents, bt.payer_email, bt.livemode, bt.created_at, bt.paid_at
      FROM internal.billing_topups bt
      WHERE bt.wallet_address = $1
      ORDER BY bt.created_at DESC
      LIMIT 20
    `), [address]).catch(() => ({ rows: [] })),
  ]);

  const billing = billingRes.rows[0] || null;
  const projects = projectsRes.rows;
  const subdomains = subdomainsRes.rows;
  const functions = functionsRes.rows;
  const ledger = ledgerRes.rows;
  const charges = chargesRes.rows;
  const sighting = sightingRes.rows[0] || null;
  const contact = contactRes.rows[0] || null;
  const topups = topupsRes.rows;

  // Summary stats
  const activeProjects = projects.filter((p: { status: string }) => p.status === "active");
  const totalApiCalls = projects.reduce((s: number, p: { api_calls: number }) => s + p.api_calls, 0);
  const totalStorageBytes = projects.reduce((s: number, p: { storage_bytes: number }) => s + Number(p.storage_bytes), 0);

  res.json({
    address,
    billing: billing ? {
      id: billing.id,
      status: billing.status,
      availableUsd: Number(billing.available_usd_micros) / 1_000_000,
      heldUsd: Number(billing.held_usd_micros) / 1_000_000,
      tier: billing.tier,
      leaseStartedAt: billing.lease_started_at,
      leaseExpiresAt: billing.lease_expires_at,
      fundingPolicy: billing.funding_policy,
      contactEmail: billing.primary_contact_email,
      createdAt: billing.created_at,
    } : null,
    summary: {
      totalProjects: projects.length,
      activeProjects: activeProjects.length,
      totalApiCalls,
      totalStorageMb: Math.round(totalStorageBytes / 1048576 * 100) / 100,
      subdomains: subdomains.length,
      functions: functions.length,
    },
    projects: projects.map((p: Record<string, unknown>) => ({
      id: p.id,
      name: p.name,
      schemaSlot: p.schema_slot,
      tier: p.tier,
      status: p.status,
      apiCalls: p.api_calls,
      storageMb: Math.round(Number(p.storage_bytes) / 1048576 * 100) / 100,
      pinned: p.pinned,
      demoMode: p.demo_mode,
      createdAt: p.created_at,
    })),
    subdomains: subdomains.map((s: Record<string, unknown>) => ({
      name: s.name,
      projectId: s.project_id,
      url: `https://${s.name}.run402.com`,
      createdAt: s.created_at,
    })),
    functions: functions.map((f: Record<string, unknown>) => ({
      id: f.id,
      projectId: f.project_id,
      name: f.name,
      runtime: f.runtime,
      timeoutSeconds: f.timeout_seconds,
      memoryMb: f.memory_mb,
      createdAt: f.created_at,
    })),
    ledger: ledger.map((l: Record<string, unknown>) => ({
      direction: l.direction,
      kind: l.kind,
      amountUsd: Number(l.amount_usd_micros) / 1_000_000,
      balanceAfterUsd: Number(l.balance_after_available) / 1_000_000,
      referenceType: l.reference_type,
      referenceId: l.reference_id,
      metadata: l.metadata,
      createdAt: l.created_at,
    })),
    charges: charges.map((c: Record<string, unknown>) => ({
      id: c.id,
      sku: c.sku,
      amountUsd: Number(c.amount_usd_micros) / 1_000_000,
      status: c.status,
      createdAt: c.created_at,
    })),
    topups: topups.map((t: Record<string, unknown>) => ({
      status: t.status,
      fundedUsd: Number(t.funded_usd_micros) / 1_000_000,
      chargedUsdCents: t.charged_usd_cents,
      payerEmail: t.payer_email,
      livemode: t.livemode,
      createdAt: t.created_at,
      paidAt: t.paid_at,
    })),
    sighting,
    contact,
  });
}));

// ---- Project detail page (augmented with finance cards) ----

router.get("/admin/project/:id", asyncHandler(async (req: Request, res: Response) => {
  const session = getSession(req);
  if (!session) { res.redirect("/admin/login"); return; }

  const projectId = req.params.id as string;
  const result = await pool.query(
    sql(`SELECT id, name, wallet_address, tier, status, created_at FROM internal.projects WHERE id = $1`),
    [projectId],
  );
  const project = result.rows[0] as { id: string; name: string; wallet_address: string | null; tier: string; status: string; created_at: Date } | undefined;
  if (!project) {
    res.status(404).type("html").send(`<!DOCTYPE html><html><head><title>Not Found</title></head><body style="background:#0A0A0F;color:#E0E0E0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center"><h1 style="color:#FF5050">Project not found</h1><p style="color:#9CA3AF">${escHtml(projectId)}</p><a href="/admin" style="color:#00FF9F">Back to dashboard</a></div></body></html>`);
    return;
  }
  res.type("html").send(projectDetailPage(session.name, project));
}));

// ---- Wallet detail page ----

router.get("/admin/wallet/:address", (req: Request, res: Response) => {
  const session = getSession(req);
  if (!session) { res.redirect("/admin/login"); return; }
  const address = (req.params.address as string).toLowerCase();
  res.type("html").send(walletPage(session.name, address));
});

// ---- HTML ----

function walletPage(userName: string, address: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wallet ${escHtml(address.slice(0, 10))}… — Run402 Admin</title>
<link rel="icon" href="https://run402.com/favicon.svg" type="image/svg+xml">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0A0A0F;color:#E0E0E0;font-family:system-ui,sans-serif;min-height:100vh}
.wrap{max-width:1060px;margin:0 auto;padding:40px 24px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;flex-wrap:wrap;gap:12px}
h1{font-size:22px;color:#fff}
h1 .g{color:#00FF9F}
.nav{display:flex;align-items:center;gap:12px;font-size:13px;color:#9CA3AF}
.nav a{color:#9CA3AF;text-decoration:none;padding:6px 12px;border:1px solid #1E1E2A;border-radius:6px;transition:border-color .2s}
.nav a:hover{border-color:#00FF9F;color:#00FF9F}
.addr{font-family:monospace;font-size:13px;color:#9CA3AF;word-break:break-all;margin-bottom:24px;background:#12121A;padding:12px 16px;border-radius:8px;border:1px solid #1E1E2A}
.addr a{color:#6366F1;text-decoration:none}
.addr a:hover{text-decoration:underline}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin-bottom:28px}
.stat{background:#12121A;border:1px solid #1E1E2A;border-radius:12px;padding:18px}
.stat-label{font-size:11px;color:#4B5563;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px}
.stat-value{font-size:24px;font-weight:700;color:#fff;font-variant-numeric:tabular-nums}
.stat-value .g{color:#00FF9F}
.stat-value .warn{color:#FBBF24}
.stat-value .bad{color:#FF5050}
.stat-sub{font-size:11px;color:#4B5563;margin-top:4px}
.section{margin-bottom:28px}
.section h2{font-size:15px;color:#fff;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.section h2 .dot{width:8px;height:8px;border-radius:50%;background:#00FF9F}
table{width:100%;border-collapse:collapse;background:#12121A;border:1px solid #1E1E2A;border-radius:12px;overflow:hidden}
th{text-align:left;font-size:11px;color:#4B5563;text-transform:uppercase;letter-spacing:.8px;padding:10px 14px;border-bottom:1px solid #1E1E2A}
td{padding:8px 14px;font-size:13px;border-bottom:1px solid rgba(255,255,255,0.03);font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
.pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500}
.pill-green{background:rgba(0,255,159,0.1);color:#00FF9F}
.pill-yellow{background:rgba(251,191,36,0.1);color:#FBBF24}
.pill-red{background:rgba(255,80,80,0.1);color:#FF5050}
.pill-gray{background:rgba(255,255,255,0.05);color:#9CA3AF}
.pill-blue{background:rgba(99,102,241,0.1);color:#6366F1}
.empty{color:#4B5563;font-size:13px;padding:20px;text-align:center}
.loading{color:#4B5563;font-size:13px;text-align:center;padding:40px}
.ts{color:#4B5563;font-size:12px;text-align:center;margin-top:24px}
.mono{font-family:monospace;font-size:12px}
a.sub-link{color:#6366F1;text-decoration:none}
a.sub-link:hover{text-decoration:underline}
@media(max-width:600px){.grid{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1><span class="g">run402</span> wallet</h1>
    <div class="nav">
      <a href="/admin">Dashboard</a>
      <span>${escHtml(userName)}</span>
      <a href="/admin/logout">Logout</a>
    </div>
  </header>

  <div class="addr">
    ${escHtml(address)}
    &nbsp;·&nbsp;
    <a href="https://basescan.org/address/${escHtml(address)}" target="_blank" rel="noopener">Basescan</a>
  </div>

  <div id="content"><div class="loading">Loading wallet data…</div></div>
  <div class="ts" id="ts"></div>
</div>

<script>
var ADDR=${JSON.stringify(address)};
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function fmt(n){return Number(n).toLocaleString()}
function relTime(iso){
  if(!iso)return '—';
  var d=new Date(iso),now=Date.now(),diff=d.getTime()-now;
  var abs=Math.abs(diff),days=Math.floor(abs/86400000),hrs=Math.floor((abs%86400000)/3600000);
  var s=days>0?days+'d '+hrs+'h':hrs+'h';
  return diff<0?s+' ago':'in '+s;
}
function fmtDate(iso){
  if(!iso)return '—';
  return new Date(iso).toLocaleDateString()+' '+new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}

async function load(){
  try{
    var r=await fetch('/admin/api/wallet/'+ADDR);
    if(r.status===401){location.href='/admin/login';return}
    var d=await r.json();
    render(d);
    document.getElementById('ts').textContent='Updated: '+new Date().toLocaleString();
  }catch(e){
    document.getElementById('content').innerHTML='<div class="loading" style="color:#FF5050">Failed to load wallet data</div>';
  }
}

function pillStatus(s){
  if(s==='active')return 'pill-green';
  if(s==='archived'||s==='expired')return 'pill-yellow';
  if(s==='deleted')return 'pill-red';
  return 'pill-gray';
}

function render(d){
  var html='';
  var b=d.billing;
  var s=d.summary;

  // ---- Summary cards ----
  html+='<div class="grid">';
  if(b){
    var bc=b.availableUsd<1?'bad':b.availableUsd<5?'warn':'g';
    html+='<div class="stat"><div class="stat-label">Balance</div><div class="stat-value"><span class="'+bc+'">$'+b.availableUsd.toFixed(2)+'</span></div>'
      +(b.heldUsd>0?'<div class="stat-sub">$'+b.heldUsd.toFixed(2)+' held</div>':'')+'</div>';
    html+='<div class="stat"><div class="stat-label">Tier</div><div class="stat-value">'+(b.tier?'<span class="g">'+esc(b.tier)+'</span>':'<span style="color:#4B5563">none</span>')+'</div>'
      +(b.leaseExpiresAt?'<div class="stat-sub">Expires '+relTime(b.leaseExpiresAt)+'</div>':'')+'</div>';
  } else {
    html+='<div class="stat"><div class="stat-label">Billing</div><div class="stat-value"><span style="color:#4B5563">none</span></div></div>';
  }
  html+='<div class="stat"><div class="stat-label">Projects</div><div class="stat-value"><span class="g">'+s.activeProjects+'</span> <span style="font-size:14px;color:#4B5563">/ '+s.totalProjects+'</span></div></div>';
  html+='<div class="stat"><div class="stat-label">API Calls</div><div class="stat-value">'+fmt(s.totalApiCalls)+'</div></div>';
  html+='<div class="stat"><div class="stat-label">Storage</div><div class="stat-value">'+s.totalStorageMb+' <span style="font-size:14px;color:#9CA3AF">MB</span></div></div>';
  html+='<div class="stat"><div class="stat-label">Subdomains</div><div class="stat-value"><span class="g">'+s.subdomains+'</span></div></div>';
  html+='<div class="stat"><div class="stat-label">Functions</div><div class="stat-value">'+s.functions+'</div></div>';
  html+='</div>';

  // ---- Contact / sighting ----
  if(d.contact || d.sighting){
    html+='<div class="section"><h2><span class="dot" style="background:#9CA3AF"></span>Identity</h2><table>';
    if(d.contact){
      html+='<tr><td style="color:#4B5563;width:120px">Name</td><td>'+esc(d.contact.name||'—')+'</td></tr>';
      if(d.contact.email) html+='<tr><td style="color:#4B5563">Email</td><td>'+esc(d.contact.email)+'</td></tr>';
      if(d.contact.webhook) html+='<tr><td style="color:#4B5563">Webhook</td><td class="mono">'+esc(d.contact.webhook)+'</td></tr>';
    }
    if(d.sighting){
      html+='<tr><td style="color:#4B5563">First seen</td><td>'+fmtDate(d.sighting.first_seen_at)+'</td></tr>';
      html+='<tr><td style="color:#4B5563">Last seen</td><td>'+fmtDate(d.sighting.last_seen_at)+'</td></tr>';
      html+='<tr><td style="color:#4B5563">Source</td><td>'+esc(d.sighting.source)+'</td></tr>';
    }
    if(b&&b.contactEmail) html+='<tr><td style="color:#4B5563">Billing email</td><td>'+esc(b.contactEmail)+'</td></tr>';
    html+='</table></div>';
  }

  // ---- Projects ----
  html+='<div class="section"><h2><span class="dot"></span>Projects</h2>';
  if(d.projects.length===0){
    html+='<div class="empty">No projects</div>';
  } else {
    html+='<table><tr><th>Name</th><th>ID</th><th>Tier</th><th>Status</th><th>API Calls</th><th>Storage</th><th>Created</th></tr>';
    for(var p of d.projects){
      html+='<tr><td><strong>'+esc(p.name)+'</strong>'+(p.pinned?' 📌':'')+(p.demoMode?' <span class="pill pill-blue">demo</span>':'')+'</td>';
      html+='<td class="mono" style="font-size:11px">'+esc(p.id)+'</td>';
      html+='<td>'+esc(p.tier)+'</td>';
      html+='<td><span class="pill '+pillStatus(p.status)+'">'+esc(p.status)+'</span></td>';
      html+='<td>'+fmt(p.apiCalls)+'</td>';
      html+='<td>'+p.storageMb+' MB</td>';
      html+='<td>'+fmtDate(p.createdAt)+'</td></tr>';
    }
    html+='</table>';
  }
  html+='</div>';

  // ---- Subdomains ----
  if(d.subdomains.length>0){
    html+='<div class="section"><h2><span class="dot" style="background:#6366F1"></span>Subdomains</h2><table><tr><th>Subdomain</th><th>Project</th><th>Created</th></tr>';
    for(var sd of d.subdomains){
      html+='<tr><td><a class="sub-link" href="'+esc(sd.url)+'" target="_blank">'+esc(sd.name)+'.run402.com</a></td>';
      html+='<td class="mono" style="font-size:11px">'+esc(sd.projectId||'—')+'</td>';
      html+='<td>'+fmtDate(sd.createdAt)+'</td></tr>';
    }
    html+='</table></div>';
  }

  // ---- Functions ----
  if(d.functions.length>0){
    html+='<div class="section"><h2><span class="dot" style="background:#FBBF24"></span>Functions</h2><table><tr><th>Name</th><th>Project</th><th>Runtime</th><th>Memory</th><th>Timeout</th><th>Created</th></tr>';
    for(var fn of d.functions){
      html+='<tr><td><strong>'+esc(fn.name)+'</strong></td>';
      html+='<td class="mono" style="font-size:11px">'+esc(fn.projectId)+'</td>';
      html+='<td>'+esc(fn.runtime)+'</td>';
      html+='<td>'+fn.memoryMb+' MB</td>';
      html+='<td>'+fn.timeoutSeconds+'s</td>';
      html+='<td>'+fmtDate(fn.createdAt)+'</td></tr>';
    }
    html+='</table></div>';
  }

  // ---- Ledger ----
  if(d.ledger.length>0){
    html+='<div class="section"><h2><span class="dot" style="background:#6366F1"></span>Ledger (last 50)</h2><table><tr><th>Date</th><th>Kind</th><th>Amount</th><th>Balance After</th><th>Ref</th></tr>';
    for(var l of d.ledger){
      var sign=l.direction==='credit'?'+':'−';
      var cls=l.direction==='credit'?'color:#00FF9F':'color:#FF5050';
      html+='<tr><td>'+fmtDate(l.createdAt)+'</td>';
      html+='<td><span class="pill pill-gray">'+esc(l.kind)+'</span></td>';
      html+='<td style="'+cls+'">'+sign+'$'+Math.abs(l.amountUsd).toFixed(2)+'</td>';
      html+='<td>$'+l.balanceAfterUsd.toFixed(2)+'</td>';
      html+='<td class="mono" style="font-size:11px">'+esc(l.referenceType||'')+' '+esc(l.referenceId||'')+'</td></tr>';
    }
    html+='</table></div>';
  }

  // ---- Charges ----
  if(d.charges.length>0){
    html+='<div class="section"><h2><span class="dot" style="background:#FF5050"></span>Charges (last 50)</h2><table><tr><th>Date</th><th>SKU</th><th>Amount</th><th>Status</th></tr>';
    for(var c of d.charges){
      html+='<tr><td>'+fmtDate(c.createdAt)+'</td>';
      html+='<td>'+esc(c.sku)+'</td>';
      html+='<td>$'+c.amountUsd.toFixed(4)+'</td>';
      html+='<td><span class="pill '+pillStatus(c.status)+'">'+esc(c.status)+'</span></td></tr>';
    }
    html+='</table></div>';
  }

  // ---- Topups ----
  if(d.topups.length>0){
    html+='<div class="section"><h2><span class="dot" style="background:#00FF9F"></span>Topups (Stripe)</h2><table><tr><th>Date</th><th>Status</th><th>Funded</th><th>Charged</th><th>Payer</th><th>Live</th></tr>';
    for(var t of d.topups){
      var tc=t.status==='credited'?'pill-green':t.status==='paid'?'pill-yellow':'pill-gray';
      html+='<tr><td>'+fmtDate(t.createdAt)+'</td>';
      html+='<td><span class="pill '+tc+'">'+esc(t.status)+'</span></td>';
      html+='<td>$'+t.fundedUsd.toFixed(2)+'</td>';
      html+='<td>'+(t.chargedUsdCents?'$'+(t.chargedUsdCents/100).toFixed(2):'—')+'</td>';
      html+='<td>'+esc(t.payerEmail||'—')+'</td>';
      html+='<td>'+(t.livemode?'✓':'test')+'</td></tr>';
    }
    html+='</table></div>';
  }

  document.getElementById('content').innerHTML=html;
}

load();
</script>
</body>
</html>`;
}

// ---- Project detail page with finance cards (Phase 10 augmentation) ----

function projectDetailPage(
  userName: string,
  project: { id: string; name: string; wallet_address: string | null; tier: string; status: string; created_at: Date },
): string {
  const walletLink = project.wallet_address
    ? `<a href="/admin/wallet/${escHtml(project.wallet_address)}" class="wallet-link">View wallet activity →</a>`
    : `<span style="color:#4B5563">(no wallet address)</span>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Project ${escHtml(project.name)} — Run402 Admin</title>
<link rel="icon" href="https://run402.com/favicon.svg" type="image/svg+xml">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0A0A0F;color:#E0E0E0;font-family:system-ui,sans-serif;min-height:100vh}
.wrap{max-width:1200px;margin:0 auto;padding:40px 24px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px}
h1{font-size:22px;color:#fff}
h1 .g{color:#00FF9F}
.nav{display:flex;align-items:center;gap:12px;font-size:13px;color:#9CA3AF}
.nav a{color:#9CA3AF;text-decoration:none;padding:6px 12px;border:1px solid #1E1E2A;border-radius:6px;transition:border-color .2s}
.nav a:hover{border-color:#00FF9F;color:#00FF9F}

.project-header{background:#12121A;border:1px solid #1E1E2A;border-radius:12px;padding:20px 24px;margin-bottom:24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.project-name{font-size:20px;color:#fff;font-weight:600}
.project-meta{font-size:12px;color:#9CA3AF;margin-top:4px}
.project-meta span{margin-right:14px}
.wallet-link{color:#00FF9F;text-decoration:none;font-size:13px;padding:8px 14px;border:1px solid #00FF9F;border-radius:6px;transition:background .15s}
.wallet-link:hover{background:rgba(0,255,159,0.1)}

.window-selector{display:flex;gap:8px;margin-bottom:20px}
.window-btn{background:#12121A;border:1px solid #1E1E2A;color:#9CA3AF;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;transition:all .15s}
.window-btn:hover{border-color:#00FF9F}
.window-btn.active{background:#00FF9F;color:#0A0A0F;border-color:#00FF9F;font-weight:600}

.kpi-row{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
.kpi{background:#12121A;border:1px solid #1E1E2A;border-radius:12px;padding:24px}
.kpi .label{font-size:12px;color:#4B5563;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}
.kpi .value{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums;color:#fff}
.kpi .value.positive{color:#00FF9F}
.kpi .value.negative{color:#FF5050}
.kpi .value.unknown{color:#4B5563}

.note{background:rgba(99,102,241,0.05);border:1px solid rgba(99,102,241,0.15);color:#9CA3AF;padding:12px 16px;border-radius:8px;font-size:12px;margin-bottom:20px}
.export-btn{background:transparent;border:1px solid #1E1E2A;color:#9CA3AF;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;transition:all .15s;margin-left:12px}
.export-btn:hover{border-color:#00FF9F;color:#00FF9F}

.loading{color:#4B5563;font-size:13px;text-align:center;padding:40px}
@media(max-width:700px){.kpi-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1><span class="g">run402</span> project</h1>
    <div class="nav">
      <a href="/admin">Dashboard</a>
      <a href="/admin/projects">Projects</a>
      <a href="/admin/subdomains">Subdomains</a>
      <a href="/admin/finance">Finance</a>
      <a href="/admin/llms-txt">llms.txt</a>
      <span>${escHtml(userName)}</span>
      <a href="/admin/logout">Logout</a>
    </div>
  </header>

  <div class="project-header">
    <div>
      <div class="project-name">${escHtml(project.name || "(unnamed)")}</div>
      <div class="project-meta">
        <span><code style="color:#9CA3AF;font-family:monospace">${escHtml(project.id)}</code></span>
        <span>tier: <strong>${escHtml(project.tier)}</strong></span>
        <span>status: <strong>${escHtml(project.status)}</strong></span>
        <span>created: ${escHtml(new Date(project.created_at).toLocaleDateString())}</span>
      </div>
    </div>
    ${walletLink}
  </div>

  <div class="window-selector" id="window-selector">
    <button class="window-btn" data-window="24h">24h</button>
    <button class="window-btn" data-window="7d">7d</button>
    <button class="window-btn active" data-window="30d">30d</button>
    <button class="window-btn" data-window="90d">90d</button>
    <button class="export-btn" id="export-project-btn">Export CSV</button>
  </div>

  <div class="kpi-row">
    <div class="kpi finance-revenue-card"><div class="label">Project Revenue</div><div class="value" id="kpi-revenue">—</div></div>
    <div class="kpi finance-cost-card"><div class="label">Project Direct Cost</div><div class="value" id="kpi-cost">—</div></div>
    <div class="kpi finance-margin-card"><div class="label">Project Direct Margin</div><div class="value" id="kpi-margin">—</div></div>
  </div>

  <div class="note">
    Direct costs only. Shared infrastructure overhead (RDS, ECS Fargate, ALB, CloudFront, etc.) is not allocated to individual projects. See the <a href="/admin/finance" style="color:#00FF9F">Finance tab</a> for platform totals.
  </div>
</div>

<script>
(function() {
  var projectId = ${JSON.stringify(project.id)};
  var currentWindow = "30d";

  function fmtUsd(micros) {
    if (micros === null || micros === undefined) return "—";
    var dollars = Number(micros) / 1_000_000;
    return "$" + dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function setKpi(id, micros, isMargin) {
    var el = document.getElementById(id);
    if (micros === null || micros === undefined) {
      el.textContent = "—";
      el.className = "value unknown";
      return;
    }
    el.textContent = fmtUsd(micros);
    if (isMargin) {
      el.className = "value " + (Number(micros) > 0 ? "positive" : Number(micros) < 0 ? "negative" : "unknown");
    } else {
      el.className = "value";
    }
  }

  async function loadFinance() {
    try {
      var res = await fetch("/admin/api/finance/project/" + projectId + "?window=" + currentWindow, { credentials: "same-origin" });
      if (res.status === 404) {
        document.getElementById("kpi-revenue").textContent = "no data";
        document.getElementById("kpi-cost").textContent = "no data";
        document.getElementById("kpi-margin").textContent = "no data";
        return;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      setKpi("kpi-revenue", data.revenue_usd_micros, false);
      setKpi("kpi-cost", data.direct_cost_usd_micros, false);
      setKpi("kpi-margin", data.direct_margin_usd_micros, true);
    } catch (e) {
      document.getElementById("kpi-revenue").textContent = "error";
      document.getElementById("kpi-cost").textContent = "error";
      document.getElementById("kpi-margin").textContent = "error";
    }
  }

  document.getElementById("window-selector").addEventListener("click", function(e) {
    if (e.target.tagName !== "BUTTON") return;
    var win = e.target.getAttribute("data-window");
    if (!win) return;
    currentWindow = win;
    document.querySelectorAll(".window-btn").forEach(function(b) {
      b.classList.toggle("active", b === e.target);
    });
    loadFinance();
  });

  document.getElementById("export-project-btn").addEventListener("click", function() {
    location.href = "/admin/api/finance/export?scope=project&id=" + encodeURIComponent(projectId) + "&window=" + currentWindow + "&format=csv";
  });

  loadFinance();
})();
</script>
</body>
</html>`;
}

export default router;
