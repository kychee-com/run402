/**
 * HTML template for the /admin/finance page.
 *
 * Styled to match the existing dashboardPage/adminTablePage templates in
 * admin-dashboard.ts (dark #0A0A0F, cards #12121A, neon green #00FF9F).
 *
 * Vanilla JS — no framework, no build step — per DD-10.
 */

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function financePage(name: string, _email: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Run402 Admin — Finance</title>
<link rel="icon" href="https://run402.com/favicon.svg" type="image/svg+xml">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0A0A0F;color:#E0E0E0;font-family:system-ui,sans-serif;min-height:100vh}
.wrap{max-width:1400px;margin:0 auto;padding:40px 24px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px}
h1{font-size:24px;color:#fff}
h1 .g{color:#00FF9F}
h2{font-size:15px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.8px;margin:32px 0 12px;font-weight:600}
.user{display:flex;align-items:center;gap:12px;font-size:13px;color:#9CA3AF}
.user a{color:#9CA3AF;text-decoration:none;padding:6px 12px;border:1px solid #1E1E2A;border-radius:6px;transition:border-color .2s}
.user a:hover{border-color:#00FF9F;color:#00FF9F}

.window-selector{display:flex;gap:8px;margin-bottom:24px}
.window-btn{background:#12121A;border:1px solid #1E1E2A;color:#9CA3AF;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;transition:all .15s}
.window-btn:hover{border-color:#00FF9F}
.window-btn.active{background:#00FF9F;color:#0A0A0F;border-color:#00FF9F;font-weight:600}

.kpi-row{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:32px}
.kpi{background:#12121A;border:1px solid #1E1E2A;border-radius:12px;padding:24px}
.kpi .label{font-size:12px;color:#4B5563;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}
.kpi .value{font-size:32px;font-weight:700;font-variant-numeric:tabular-nums;color:#fff}
.kpi .value.positive{color:#00FF9F}
.kpi .value.negative{color:#FF5050}
.kpi .value.unknown{color:#4B5563}
.kpi .sub{font-size:12px;color:#4B5563;margin-top:8px}

.drift-warning{background:rgba(255,204,0,0.08);border:1px solid rgba(255,204,0,0.35);color:#FFC700;padding:12px 16px;border-radius:8px;font-size:13px;margin-bottom:16px;display:none}
.drift-warning.active{display:block}
.drift-warning a{color:#FFC700;text-decoration:underline;cursor:pointer}
.drift-warning a:hover{text-decoration:none}

.cache-status{display:flex;align-items:center;gap:12px;font-size:12px;color:#4B5563;margin:8px 0 16px}
.btn-small{background:transparent;border:1px solid #1E1E2A;color:#9CA3AF;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit;transition:all .15s}
.btn-small:hover{border-color:#00FF9F;color:#00FF9F}

.table-wrap{background:#12121A;border:1px solid #1E1E2A;border-radius:12px;overflow:auto;margin-bottom:16px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;color:#4B5563;text-transform:uppercase;letter-spacing:.8px;padding:12px 16px;border-bottom:1px solid #1E1E2A}
th.num{text-align:right}
td{padding:10px 16px;font-size:13px;border-bottom:1px solid rgba(255,255,255,0.03);font-variant-numeric:tabular-nums}
td.num{text-align:right}
td.proj{cursor:pointer;color:#00FF9F}
td.proj:hover{text-decoration:underline}
tr.footer td{border-top:2px solid #1E1E2A;border-bottom:none;font-weight:600;color:#fff}
tr.unattrib td{color:#4B5563;font-style:italic}
.src-tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:10px;background:rgba(255,255,255,0.05);color:#9CA3AF;text-transform:uppercase;letter-spacing:.5px}
.src-tag.counter{background:rgba(0,255,159,0.1);color:#00FF9F}
.src-tag.ce{background:rgba(100,150,255,0.1);color:#6496FF}

.section-header{display:flex;align-items:center;justify-content:space-between;margin:32px 0 12px}
.section-header h2{margin:0}
.export-btn{background:transparent;border:1px solid #1E1E2A;color:#9CA3AF;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;transition:all .15s}
.export-btn:hover{border-color:#00FF9F;color:#00FF9F}

.loading{color:#4B5563;font-size:13px;text-align:center;padding:40px}
.error-inline{color:#FF5050;font-size:13px;padding:16px}

@media(max-width:800px){.kpi-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1><span class="g">run402</span> admin</h1>
    <div class="user">
      <a href="/admin">Dashboard</a>
      <a href="/admin/projects">Projects</a>
      <a href="/admin/subdomains">Subdomains</a>
      <a href="/admin/finance" style="border-color:#00FF9F;color:#00FF9F">Finance</a>
      <span>${escHtml(name)}</span>
      <a href="/admin/logout">Logout</a>
    </div>
  </header>

  <div class="window-selector" id="window-selector">
    <button class="window-btn" data-window="24h">24h</button>
    <button class="window-btn" data-window="7d">7d</button>
    <button class="window-btn active" data-window="30d">30d</button>
    <button class="window-btn" data-window="90d">90d</button>
  </div>

  <div class="kpi-row" id="kpi-row">
    <div class="kpi"><div class="label">Revenue</div><div class="value" id="kpi-revenue">—</div><div class="sub" id="kpi-revenue-sub"></div></div>
    <div class="kpi"><div class="label">Cost</div><div class="value" id="kpi-cost">—</div><div class="sub" id="kpi-cost-sub"></div></div>
    <div class="kpi"><div class="label">Margin</div><div class="value" id="kpi-margin">—</div><div class="sub" id="kpi-margin-sub"></div></div>
  </div>

  <div class="cache-status" id="cache-status">
    <span id="cache-age-label">Cost Explorer cache: —</span>
    <button class="btn-small" id="refresh-costs-btn">Refresh now</button>
    <button class="btn-small" id="refresh-pricing-btn">Update pricing from AWS</button>
  </div>

  <div class="drift-warning" id="drift-warning">
    ⚠️ <strong>Counter-derived cost differs from AWS Cost Explorer by <span id="drift-pct"></span>%</strong> — pricing constants may be stale. <a id="drift-refresh-link">Click to refresh pricing from AWS.</a>
  </div>

  <div class="section-header">
    <h2>Revenue by Project</h2>
    <button class="export-btn" id="export-platform-btn">Export CSV</button>
  </div>
  <div class="table-wrap">
    <table id="revenue-table">
      <thead>
        <tr>
          <th>Project</th>
          <th class="num">Tier Fees</th>
          <th class="num">Email Packs</th>
          <th class="num">KMS Rental</th>
          <th class="num">KMS Signs</th>
          <th class="num">Per-Call</th>
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody><tr><td colspan="7" class="loading">Loading revenue…</td></tr></tbody>
    </table>
  </div>

  <div class="section-header">
    <h2>Cost by Category</h2>
  </div>
  <div class="table-wrap">
    <table id="cost-table">
      <thead>
        <tr>
          <th>Category</th>
          <th>Source</th>
          <th class="num">Cost</th>
          <th class="num">% of Total</th>
        </tr>
      </thead>
      <tbody><tr><td colspan="4" class="loading">Loading costs…</td></tr></tbody>
    </table>
  </div>
</div>

<script>
(function() {
  var currentWindow = new URLSearchParams(location.search).get("window") || "30d";

  function fmtUsd(micros) {
    if (micros === null || micros === undefined) return "—";
    var dollars = Number(micros) / 1_000_000;
    return "$" + dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtPct(n) {
    if (n === null || n === undefined) return "—";
    return Number(n).toFixed(2) + "%";
  }

  function setKpi(id, subId, micros, isMargin) {
    var el = document.getElementById(id);
    var sub = document.getElementById(subId);
    if (micros === null || micros === undefined) {
      el.textContent = "—";
      el.className = "value unknown";
    } else {
      el.textContent = fmtUsd(micros);
      if (isMargin) {
        el.className = "value " + (Number(micros) > 0 ? "positive" : Number(micros) < 0 ? "negative" : "unknown");
      } else {
        el.className = "value";
      }
    }
    if (sub) sub.textContent = "";
  }

  async function fetchJson(url) {
    var res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  async function loadSummary() {
    try {
      var data = await fetchJson("/admin/api/finance/summary?window=" + currentWindow);
      setKpi("kpi-revenue", "kpi-revenue-sub", data.revenue_usd_micros, false);
      setKpi("kpi-cost", "kpi-cost-sub", data.cost_usd_micros, false);
      setKpi("kpi-margin", "kpi-margin-sub", data.margin_usd_micros, true);
      var cacheLbl = document.getElementById("cache-age-label");
      if (data.cost_source.cache_status === "empty") {
        cacheLbl.textContent = "Cost Explorer cache: empty — click Refresh now";
      } else {
        var ageH = data.cost_source.cache_age_seconds !== null
          ? (data.cost_source.cache_age_seconds / 3600).toFixed(1) + " hours ago"
          : "unknown";
        cacheLbl.textContent = "Cost Explorer cache: refreshed " + ageH;
      }
    } catch (e) {
      document.getElementById("kpi-revenue").textContent = "error";
      document.getElementById("kpi-cost").textContent = "error";
      document.getElementById("kpi-margin").textContent = "error";
    }
  }

  async function loadRevenue() {
    var tbody = document.querySelector("#revenue-table tbody");
    try {
      var data = await fetchJson("/admin/api/finance/revenue?window=" + currentWindow);
      var rows = data.projects.map(function(p) {
        return "<tr>"
          + "<td class='proj' data-project-id='" + p.project_id + "'>" + (p.project_name || "(unnamed)") + " <span style='color:#4B5563;font-size:11px'>" + p.project_id.slice(0, 8) + "</span></td>"
          + "<td class='num'>" + fmtUsd(p.tier_fees_usd_micros) + "</td>"
          + "<td class='num'>" + fmtUsd(p.email_packs_usd_micros) + "</td>"
          + "<td class='num'>" + fmtUsd(p.kms_rental_usd_micros) + "</td>"
          + "<td class='num'>" + fmtUsd(p.kms_sign_fees_usd_micros) + "</td>"
          + "<td class='num'>" + fmtUsd(p.per_call_sku_usd_micros) + "</td>"
          + "<td class='num'>" + fmtUsd(p.total_usd_micros) + "</td>"
          + "</tr>";
      }).join("");
      if (data.unattributed_usd_micros > 0) {
        rows += "<tr class='unattrib'><td>Unattributed</td><td></td><td></td><td></td><td></td><td></td><td class='num'>" + fmtUsd(data.unattributed_usd_micros) + "</td></tr>";
      }
      rows += "<tr class='footer'><td>TOTAL</td><td></td><td></td><td></td><td></td><td></td><td class='num'>" + fmtUsd(data.total_usd_micros) + "</td></tr>";
      tbody.innerHTML = rows || "<tr><td colspan='7' class='loading'>No revenue in this window</td></tr>";
      // Attach project row click handlers
      tbody.querySelectorAll("td.proj").forEach(function(cell) {
        cell.addEventListener("click", function() {
          location.href = "/admin/project/" + cell.getAttribute("data-project-id");
        });
      });
    } catch (e) {
      tbody.innerHTML = "<tr><td colspan='7' class='error-inline'>Error: " + e.message + "</td></tr>";
    }
  }

  async function loadCosts() {
    var tbody = document.querySelector("#cost-table tbody");
    var driftEl = document.getElementById("drift-warning");
    try {
      var data = await fetchJson("/admin/api/finance/costs?window=" + currentWindow);
      tbody.innerHTML = data.categories.map(function(c) {
        var srcClass = c.source === "counter" ? "counter" : "ce";
        var srcLabel = c.source === "counter" ? "counter" : "Cost Explorer";
        return "<tr>"
          + "<td>" + c.category + "</td>"
          + "<td><span class='src-tag " + srcClass + "'>" + srcLabel + "</span></td>"
          + "<td class='num'>" + fmtUsd(c.cost_usd_micros) + "</td>"
          + "<td class='num'>" + fmtPct(c.percentage_of_total) + "</td>"
          + "</tr>";
      }).join("") || "<tr><td colspan='4' class='loading'>No cost data</td></tr>";
      if (data.reconciliation.drift_warning) {
        document.getElementById("drift-pct").textContent = data.reconciliation.drift_percentage;
        driftEl.classList.add("active");
      } else {
        driftEl.classList.remove("active");
      }
    } catch (e) {
      tbody.innerHTML = "<tr><td colspan='4' class='error-inline'>Error: " + e.message + "</td></tr>";
    }
  }

  async function loadAll() {
    await Promise.all([loadSummary(), loadRevenue(), loadCosts()]);
  }

  document.getElementById("window-selector").addEventListener("click", function(e) {
    if (e.target.tagName !== "BUTTON") return;
    var win = e.target.getAttribute("data-window");
    if (!win) return;
    currentWindow = win;
    var url = new URL(location.href);
    url.searchParams.set("window", win);
    history.replaceState(null, "", url.toString());
    document.querySelectorAll(".window-btn").forEach(function(b) {
      b.classList.toggle("active", b === e.target);
    });
    loadAll();
  });

  // Sync initial button state to URL param
  document.querySelectorAll(".window-btn").forEach(function(b) {
    b.classList.toggle("active", b.getAttribute("data-window") === currentWindow);
  });

  function explainRefreshError(err) {
    // Map backend error shapes to human-actionable messages.
    var awsMsg = (err && err.aws_error) || "";
    var code = err && err.error;
    if (/not enabled for cost explorer/i.test(awsMsg) || code === "cost_explorer_unavailable" && /not enabled/i.test(awsMsg)) {
      return "AWS Cost Explorer is not enabled on this AWS account.\\n\\n" +
        "Enable it one time at:\\n" +
        "https://console.aws.amazon.com/cost-management/home\\n\\n" +
        "After enabling, wait ~24 hours for AWS to populate initial data, then click Refresh again. " +
        "Until then, the Cost and Margin cards will stay blank — Revenue and the per-project breakdown still work.";
    }
    if (code === "rate_limited") {
      return "Rate limit: Cost Explorer refresh is limited to once per 60 seconds. " + (err.message || "");
    }
    if (code === "cost_explorer_unavailable") {
      return "AWS Cost Explorer is unavailable.\\n\\nAWS returned: " + awsMsg;
    }
    return "Refresh failed: " + (err.message || code || "unknown error");
  }

  document.getElementById("refresh-costs-btn").addEventListener("click", async function() {
    this.disabled = true;
    this.textContent = "Refreshing…";
    try {
      var res = await fetch("/admin/api/finance/refresh-costs", { method: "POST", credentials: "same-origin" });
      if (!res.ok) {
        var err = await res.json();
        alert(explainRefreshError(err));
      } else {
        await loadAll();
      }
    } catch (e) {
      alert("Refresh failed: " + e.message);
    } finally {
      this.disabled = false;
      this.textContent = "Refresh now";
    }
  });

  async function doRefreshPricing() {
    try {
      var res = await fetch("/admin/api/finance/refresh-pricing", { method: "POST", credentials: "same-origin" });
      if (!res.ok) {
        var err = await res.json();
        alert("Pricing refresh failed: " + (err.aws_error || err.error));
        return;
      }
      var result = await res.json();
      alert("Pricing refresh: " + result.updated.length + " updated, " + result.unchanged.length + " unchanged, " + result.errors.length + " errors");
      await loadAll();
    } catch (e) {
      alert("Pricing refresh failed: " + e.message);
    }
  }

  document.getElementById("refresh-pricing-btn").addEventListener("click", doRefreshPricing);
  document.getElementById("drift-refresh-link").addEventListener("click", function(e) { e.preventDefault(); doRefreshPricing(); });

  document.getElementById("export-platform-btn").addEventListener("click", function() {
    location.href = "/admin/api/finance/export?scope=platform&window=" + currentWindow + "&format=csv";
  });

  loadAll();
})();
</script>
</body>
</html>`;
}
