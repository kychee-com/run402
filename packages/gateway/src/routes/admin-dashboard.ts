/**
 * Admin dashboard with Google OAuth (restricted to @kychee.com).
 *
 * Routes:
 *   GET  /admin              — dashboard (requires session)
 *   GET  /admin/login        — login page
 *   GET  /admin/oauth/google — initiate OAuth
 *   GET  /admin/oauth/google/callback — OAuth callback
 *   GET  /admin/logout       — clear session
 *   GET  /admin/api/stats    — JSON stats (requires session)
 */

import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_SESSION_SECRET, MAX_SCHEMA_SLOTS } from "../config.js";
import { pool } from "../db/pool.js";
import { projectCache } from "../services/projects.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

const ALLOWED_DOMAIN = "kychee.com";
const SESSION_COOKIE = "run402_admin";
const SESSION_DAYS = 7;
const STATE_COOKIE = "run402_oauth_state";

// ---- Helpers ----

function hmacSign(payload: string): string {
  return crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update(payload).digest("hex");
}

function createSession(email: string, name: string): string {
  const payload = JSON.stringify({ email, name, exp: Date.now() + SESSION_DAYS * 86400_000 });
  const b64 = Buffer.from(payload).toString("base64url");
  return `${b64}.${hmacSign(b64)}`;
}

function verifySession(cookie: string): { email: string; name: string } | null {
  const [b64, sig] = cookie.split(".");
  if (!b64 || !sig) return null;
  if (!crypto.timingSafeEqual(Buffer.from(hmacSign(b64), "hex"), Buffer.from(sig, "hex"))) return null;
  try {
    const data = JSON.parse(Buffer.from(b64, "base64url").toString());
    if (data.exp < Date.now()) return null;
    return { email: data.email, name: data.name };
  } catch { return null; }
}

function getSession(req: Request): { email: string; name: string } | null {
  const raw = req.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  return verifySession(raw.split("=").slice(1).join("="));
}

function getRedirectUri(req: Request): string {
  const proto = req.protocol;
  const host = req.get("host") || "localhost:4022";
  return `${proto}://${host}/admin/oauth/google/callback`;
}

// ---- Login page ----

router.get("/admin/login", (_req: Request, res: Response) => {
  const error = typeof _req.query.error === "string" ? _req.query.error : "";
  res.type("html").send(loginPage(error));
});

// ---- Initiate OAuth ----

router.get("/admin/oauth/google", (req: Request, res: Response) => {
  if (!GOOGLE_CLIENT_ID) {
    res.status(500).send("GOOGLE_CLIENT_ID not configured");
    return;
  }
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = Buffer.from(JSON.stringify({ nonce, exp: Date.now() + 600_000 })).toString("base64url");
  const stateSigned = `${state}.${hmacSign(state)}`;

  res.cookie(STATE_COOKIE, stateSigned, { httpOnly: true, secure: req.secure, sameSite: "lax", maxAge: 600_000 });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state: stateSigned,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ---- OAuth callback ----

router.get("/admin/oauth/google/callback", asyncHandler(async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const stateParam = req.query.state as string;
  if (!code || !stateParam) { res.redirect("/admin/login?error=Missing+code+or+state"); return; }

  // Verify state
  const stateCookie = req.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith(`${STATE_COOKIE}=`));
  const storedState = stateCookie?.split("=").slice(1).join("=");
  if (stateParam !== storedState) { res.redirect("/admin/login?error=Invalid+state"); return; }

  const [stateB64, stateSig] = stateParam.split(".");
  if (!stateB64 || !stateSig) { res.redirect("/admin/login?error=Bad+state"); return; }
  try {
    if (!crypto.timingSafeEqual(Buffer.from(hmacSign(stateB64), "hex"), Buffer.from(stateSig, "hex"))) {
      res.redirect("/admin/login?error=State+signature+mismatch"); return;
    }
    const stateData = JSON.parse(Buffer.from(stateB64, "base64url").toString());
    if (stateData.exp < Date.now()) { res.redirect("/admin/login?error=State+expired"); return; }
  } catch { res.redirect("/admin/login?error=Bad+state+data"); return; }

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: getRedirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) { res.redirect("/admin/login?error=Token+exchange+failed"); return; }
  const tokens = await tokenRes.json() as { access_token: string };

  // Get user info
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) { res.redirect("/admin/login?error=Failed+to+get+user+info"); return; }
  const user = await userRes.json() as { email: string; name: string };

  // Check domain
  const domain = user.email.split("@")[1];
  if (domain !== ALLOWED_DOMAIN) {
    res.redirect(`/admin/login?error=Only+@${ALLOWED_DOMAIN}+accounts+are+allowed`);
    return;
  }

  // Set session cookie
  const sessionVal = createSession(user.email, user.name);
  res.cookie(SESSION_COOKIE, sessionVal, {
    httpOnly: true,
    secure: req.secure,
    sameSite: "lax",
    maxAge: SESSION_DAYS * 86400_000,
    path: "/",
  });
  // Clear state cookie
  res.clearCookie(STATE_COOKIE);
  res.redirect("/admin");
}));

// ---- Logout ----

router.get("/admin/logout", (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.redirect("/admin/login");
});

// ---- Stats API ----

router.get("/admin/api/stats", asyncHandler(async (req: Request, res: Response) => {
  const session = getSession(req);
  if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }

  // Gather stats from cache
  const projects = [...projectCache.values()];
  const byTier: Record<string, number> = { prototype: 0, hobby: 0, team: 0 };
  let totalApiCalls = 0;
  let totalStorageBytes = 0;
  let pinnedCount = 0;
  const expiringIn7d: string[] = [];
  const now = Date.now();

  for (const p of projects) {
    byTier[p.tier] = (byTier[p.tier] || 0) + 1;
    totalApiCalls += p.apiCalls;
    totalStorageBytes += p.storageBytes;
    if (p.pinned) pinnedCount++;
    if (p.leaseExpiresAt && p.leaseExpiresAt.getTime() - now < 7 * 86400_000 && !p.pinned) {
      expiringIn7d.push(p.id);
    }
  }

  // DB-level stats
  const [allProjectsRes, billingRes, subdomainsRes, functionsRes, slotsRes] = await Promise.all([
    pool.query(`SELECT status, COUNT(*)::int AS count FROM internal.projects GROUP BY status`),
    pool.query(`SELECT COUNT(*)::int AS accounts, COALESCE(SUM(available_usd_micros),0)::bigint AS total_available FROM internal.billing_accounts`),
    pool.query(`SELECT COUNT(*)::int AS count FROM internal.subdomains`),
    pool.query(`SELECT COUNT(*)::int AS count FROM internal.functions`).catch(() => ({ rows: [{ count: 0 }] })),
    pool.query(`SELECT COUNT(*)::int AS used FROM information_schema.schemata WHERE schema_name ~ '^p\\d{4}$'`),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const row of allProjectsRes.rows) statusCounts[row.status] = row.count;

  const billing = billingRes.rows[0] || { accounts: 0, total_available: "0" };
  const slotsUsed = slotsRes.rows[0]?.used || 0;

  res.json({
    projects: {
      active: projects.length,
      byStatus: statusCounts,
      byTier,
      pinned: pinnedCount,
      expiringIn7d: expiringIn7d.length,
    },
    usage: {
      totalApiCalls,
      totalStorageBytes,
      totalStorageMb: Math.round(totalStorageBytes / 1048576 * 100) / 100,
    },
    infrastructure: {
      slotsUsed,
      slotsTotal: MAX_SCHEMA_SLOTS,
      slotsUtilization: Math.round(slotsUsed / MAX_SCHEMA_SLOTS * 10000) / 100,
      subdomains: subdomainsRes.rows[0]?.count || 0,
      functions: functionsRes.rows[0]?.count || 0,
    },
    billing: {
      accounts: billing.accounts,
      totalAvailableUsd: Number(billing.total_available) / 1_000_000,
    },
  });
}));

// ---- Dashboard page ----

router.get("/admin", asyncHandler(async (req: Request, res: Response) => {
  const session = getSession(req);
  if (!session) { res.redirect("/admin/login"); return; }
  res.type("html").send(dashboardPage(session.name, session.email));
}));

// ---- HTML Templates ----

function loginPage(error: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Run402 Admin — Login</title>
<link rel="icon" href="https://run402.com/favicon.svg" type="image/svg+xml">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0A0A0F;color:#E0E0E0;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#12121A;border:1px solid #1E1E2A;border-radius:16px;padding:48px;text-align:center;max-width:400px;width:90%}
h1{font-size:24px;color:#fff;margin-bottom:8px}
h1 .g{color:#00FF9F}
.sub{color:#9CA3AF;font-size:14px;margin-bottom:32px}
.error{background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.3);color:#FF5050;padding:10px 16px;border-radius:8px;font-size:13px;margin-bottom:20px}
.btn{display:inline-flex;align-items:center;gap:10px;background:#fff;color:#333;border:none;border-radius:8px;padding:12px 24px;font-size:15px;font-weight:500;cursor:pointer;text-decoration:none;transition:background .2s}
.btn:hover{background:#f0f0f0}
.btn svg{width:20px;height:20px}
.note{color:#4B5563;font-size:12px;margin-top:20px}
</style>
</head>
<body>
<div class="card">
  <h1><span class="g">run402</span> admin</h1>
  <p class="sub">Internal dashboard</p>
  ${error ? `<div class="error">${escHtml(error)}</div>` : ""}
  <a class="btn" href="/admin/oauth/google">
    <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
    Sign in with Google
  </a>
  <p class="note">Only @kychee.com accounts are allowed</p>
</div>
</body>
</html>`;
}

function dashboardPage(name: string, email: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Run402 Admin</title>
<link rel="icon" href="https://run402.com/favicon.svg" type="image/svg+xml">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0A0A0F;color:#E0E0E0;font-family:system-ui,sans-serif;min-height:100vh}
.wrap{max-width:960px;margin:0 auto;padding:40px 24px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:40px}
h1{font-size:24px;color:#fff}
h1 .g{color:#00FF9F}
.user{display:flex;align-items:center;gap:12px;font-size:13px;color:#9CA3AF}
.user a{color:#9CA3AF;text-decoration:none;padding:6px 12px;border:1px solid #1E1E2A;border-radius:6px;transition:border-color .2s}
.user a:hover{border-color:#00FF9F;color:#00FF9F}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:32px}
.stat{background:#12121A;border:1px solid #1E1E2A;border-radius:12px;padding:20px}
.stat-label{font-size:11px;color:#4B5563;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}
.stat-value{font-size:28px;font-weight:700;color:#fff;font-variant-numeric:tabular-nums}
.stat-value .g{color:#00FF9F}
.stat-value .warn{color:#FBBF24}
.stat-value .bad{color:#FF5050}
.section{margin-bottom:32px}
.section h2{font-size:16px;color:#fff;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.section h2 .dot{width:8px;height:8px;border-radius:50%;background:#00FF9F}
table{width:100%;border-collapse:collapse;background:#12121A;border:1px solid #1E1E2A;border-radius:12px;overflow:hidden}
th{text-align:left;font-size:11px;color:#4B5563;text-transform:uppercase;letter-spacing:.8px;padding:12px 16px;border-bottom:1px solid #1E1E2A}
td{padding:10px 16px;font-size:13px;border-bottom:1px solid rgba(255,255,255,0.03);font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
.pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500}
.pill-green{background:rgba(0,255,159,0.1);color:#00FF9F}
.pill-yellow{background:rgba(251,191,36,0.1);color:#FBBF24}
.pill-red{background:rgba(255,80,80,0.1);color:#FF5050}
.pill-gray{background:rgba(255,255,255,0.05);color:#9CA3AF}
.bar-wrap{height:8px;background:#1E1E2A;border-radius:4px;overflow:hidden;margin-top:8px}
.bar-fill{height:100%;border-radius:4px;transition:width .6s ease}
.loading{color:#4B5563;font-size:13px;text-align:center;padding:40px}
.ts{color:#4B5563;font-size:12px;text-align:center;margin-top:24px}
@media(max-width:600px){.grid{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1><span class="g">run402</span> admin</h1>
    <div class="user">
      <span>${escHtml(name)} (${escHtml(email)})</span>
      <a href="/admin/logout">Logout</a>
    </div>
  </header>

  <div id="content"><div class="loading">Loading stats...</div></div>
  <div class="ts" id="ts"></div>
</div>

<script>
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
  html+='<div class="stat"><div class="stat-label">Active Projects</div><div class="stat-value"><span class="g">'+fmt(p.active)+'</span></div></div>';
  html+='<div class="stat"><div class="stat-label">Total API Calls</div><div class="stat-value">'+fmt(u.totalApiCalls)+'</div></div>';
  html+='<div class="stat"><div class="stat-label">Storage Used</div><div class="stat-value">'+u.totalStorageMb+' <span style="font-size:14px;color:#9CA3AF">MB</span></div></div>';
  html+='<div class="stat"><div class="stat-label">Schema Slots</div><div class="stat-value"><span class="'+slotColor+'">'+fmt(inf.slotsUsed)+'</span> <span style="font-size:14px;color:#9CA3AF">/ '+fmt(inf.slotsTotal)+'</span></div>';
  html+='<div class="bar-wrap"><div class="bar-fill" style="width:'+slotPct+'%;background:'+(slotPct>90?'#FF5050':slotPct>70?'#FBBF24':'#00FF9F')+'"></div></div></div>';
  html+='<div class="stat"><div class="stat-label">Billing Accounts</div><div class="stat-value">'+fmt(b.accounts)+'</div></div>';
  html+='<div class="stat"><div class="stat-label">Total Allowance</div><div class="stat-value">$'+b.totalAvailableUsd.toFixed(2)+'</div></div>';
  html+='<div class="stat"><div class="stat-label">Subdomains</div><div class="stat-value">'+fmt(inf.subdomains)+'</div></div>';
  html+='<div class="stat"><div class="stat-label">Functions</div><div class="stat-value">'+fmt(inf.functions)+'</div></div>';
  html+='</div>';

  // Projects by status
  html+='<div class="section"><h2><span class="dot"></span>Projects by Status</h2><table><tr><th>Status</th><th>Count</th></tr>';
  for(const [s,c] of Object.entries(p.byStatus)){
    const cls=s==='active'?'pill-green':s==='archived'?'pill-yellow':s==='deleted'?'pill-red':'pill-gray';
    html+='<tr><td><span class="pill '+cls+'">'+esc(s)+'</span></td><td>'+fmt(c)+'</td></tr>';
  }
  html+='</table></div>';

  // Projects by tier
  html+='<div class="section"><h2><span class="dot"></span>Active Projects by Tier</h2><table><tr><th>Tier</th><th>Count</th></tr>';
  for(const [t,c] of Object.entries(p.byTier)){
    html+='<tr><td>'+esc(t)+'</td><td>'+fmt(c)+'</td></tr>';
  }
  html+='<tr style="border-top:1px solid #1E1E2A"><td><strong>Pinned</strong></td><td>'+fmt(p.pinned)+'</td></tr>';
  html+='<tr><td><strong style="color:#FBBF24">Expiring in 7d</strong></td><td>'+fmt(p.expiringIn7d)+'</td></tr>';
  html+='</table></div>';

  document.getElementById('content').innerHTML=html;
}

load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default router;
