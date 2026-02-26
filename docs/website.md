> **SUPERSEDED** — Style guide for the DynamoDB-era site. See `supa_website.md` for the current design system.

---

# STYLE GUIDE — Visual Design System

> **Design philosophy:** The site feels like a *production terminal that graduated to a product*. Monospace roots, neon-on-dark data surfaces, but with the spatial clarity and type hierarchy of a modern SaaS. Every screen should feel like you could pipe it to `stdout` or show it to a VP. Fast. Scannable. No decoration that doesn't carry information.

---

## SG-1) Performance targets

The site **must** be fast. These are hard constraints, not aspirations.

| Metric | Target |
|---|---|
| First Contentful Paint | < 0.8s |
| Largest Contentful Paint | < 1.5s |
| Total Blocking Time | < 100ms |
| CLS | < 0.05 |
| JS bundle (gzipped) | < 50 KB total for marketing pages |
| No layout shifts from web fonts | System font stack first; swap mono only |

**Rules:**
* No client-side framework on marketing pages — static HTML + minimal JS (scroll observer, theme toggle, calculator widget only).
* Console pages may use a lightweight framework (Preact, Solid, or vanilla) — **no React on marketing.**
* Images: SVG only for icons/illustrations. No raster hero images. Use CSS gradients + grid patterns.
* Fonts: loaded via `font-display: swap` with system fallbacks. Two fonts max.
* No analytics scripts above the fold. Defer everything.

---

## SG-2) Color system

### Dark mode (default)

The site ships dark-first. Light mode is optional (v2).

```
--bg-root:          #0A0A0F        /* near-black, faint blue cast */
--bg-surface:       #111118        /* card/panel background */
--bg-surface-hover: #1A1A24        /* interactive hover state */
--bg-elevated:      #16161F        /* modals, dropdowns, tooltips */
--bg-inset:         #08080C        /* code blocks, terminal areas */

--border-subtle:    #1E1E2A        /* panel dividers */
--border-default:   #2A2A3A        /* input borders, table lines */
--border-focus:     #00FF9F        /* focus rings — terminal green */

--text-primary:     #E8E8ED        /* body text — high contrast on dark */
--text-secondary:   #8888A0        /* labels, captions, muted */
--text-tertiary:    #555566        /* disabled, placeholder */
--text-inverse:     #0A0A0F        /* text on bright backgrounds */

--accent-green:     #00FF9F        /* primary accent — terminal green */
--accent-green-dim: #00CC7F        /* hover / pressed state */
--accent-green-bg:  rgba(0,255,159,0.08) /* subtle highlight background */

--accent-cyan:      #00D4FF        /* secondary accent — data, links */
--accent-cyan-dim:  #00A8CC        /* hover state */

--accent-amber:     #FFB800        /* warnings, low-balance alerts */
--accent-red:       #FF3B5C        /* errors, destructive actions */
--accent-purple:    #A78BFA        /* v1.1 / future / deferred badges */

--receipt-green:    #00FF9F15      /* receipt ledger row tint */
--status-ok:        #00FF9F        /* health indicator — ok */
--status-warn:      #FFB800        /* health indicator — degraded */
--status-error:     #FF3B5C        /* health indicator — down */
```

### Gradient accents (used sparingly)

```
--gradient-hero:    linear-gradient(135deg, #00FF9F 0%, #00D4FF 100%)
--gradient-glow:    radial-gradient(ellipse at 50% 0%, rgba(0,255,159,0.12) 0%, transparent 60%)
--gradient-surface: linear-gradient(180deg, #111118 0%, #0A0A0F 100%)
```

### Usage rules

* **Green** (`--accent-green`) is the primary action color. CTAs, focus rings, active states, success.
* **Cyan** (`--accent-cyan`) is the data/link color. Hyperlinks, table headers, metric values.
* **Amber** only for cost warnings and approaching-cap states. Never decorative.
* **Red** only for errors and destructive confirmations. Never decorative.
* **Purple** badges mark “v1.1” or “planned” features — nothing else.
* Never use color as the sole indicator. Always pair with text labels or icons.

---

## SG-3) Typography

### Font stack

```css
/* Primary — used for headings, body, UI */
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;

/* Mono — used for code, data, terminal surfaces, prices, IDs */
--font-mono: 'JetBrains Mono', 'SF Mono', 'Cascadia Code', 'Fira Code', ui-monospace, monospace;
```

Load **Inter** (variable, 400–700) and **JetBrains Mono** (400, 700) via self-hosted WOFF2. Total: ~60 KB.

### Type scale (rem-based, 16px root)

| Token | Size | Weight | Use |
|---|---|---|---|
| `--type-display` | 3rem / 48px | 700 | Hero H1 only |
| `--type-h1` | 2.25rem / 36px | 700 | Page H1 |
| `--type-h2` | 1.5rem / 24px | 700 | Section headings |
| `--type-h3` | 1.125rem / 18px | 600 | Sub-sections, card titles |
| `--type-body` | 1rem / 16px | 400 | Body text |
| `--type-body-sm` | 0.875rem / 14px | 400 | Secondary text, table cells |
| `--type-caption` | 0.75rem / 12px | 400 | Labels, timestamps, badges |
| `--type-mono-lg` | 1.125rem / 18px | 400 | Terminal output, prices |
| `--type-mono` | 0.875rem / 14px | 400 | Code inline, IDs, hashes |
| `--type-mono-sm` | 0.75rem / 12px | 400 | Log lines, receipt entries |

### Typography rules

* **Headings:** Inter bold. All headings use `--text-primary`.
* **Body:** Inter regular. Line-height: 1.6 for prose, 1.4 for UI.
* **Any number, ID, hash, price, or machine value:** Always `--font-mono`. Prices are `--accent-cyan` in mono. Request IDs are `--text-secondary` in mono.
* **Terminal/code blocks:** JetBrains Mono on `--bg-inset` with a 1px `--border-subtle` border and `border-radius: 6px`.
* **No italic in UI text.** Reserve italic only for inline variable names in docs.
* **Letter-spacing:** -0.02em on `--type-display` and `--type-h1`. Default elsewhere.

---

## SG-4) Layout system

### Grid

```
--grid-max-width:   1200px         /* content max */
--grid-gutter:      24px           /* column gaps */
--grid-margin:      24px           /* page edge on mobile */
```

* Marketing pages: 12-column grid, collapsing to single-column below 768px.
* Console pages: Sidebar (240px fixed) + fluid main. Sidebar collapses to bottom-tab nav on mobile.
* All pages: content never wider than `--grid-max-width`. Centered.

### Spacing scale

```
--space-1:  4px
--space-2:  8px
--space-3:  12px
--space-4:  16px
--space-5:  24px
--space-6:  32px
--space-7:  48px
--space-8:  64px
--space-9:  96px
```

* Section vertical spacing: `--space-9` between major sections on marketing pages.
* Card padding: `--space-5` on desktop, `--space-4` on mobile.
* Tight UI (console tables, logs): `--space-2` to `--space-3` vertical rhythm.

### Breakpoints

```
--bp-sm:   480px    /* phone */
--bp-md:   768px    /* tablet / landscape phone */
--bp-lg:   1024px   /* small desktop / tablet landscape */
--bp-xl:   1280px   /* desktop */
```

---

## SG-5) Component styles

### Cards

```
background:    var(--bg-surface)
border:        1px solid var(--border-subtle)
border-radius: 8px
padding:       var(--space-5)
```

* On hover (interactive cards): border transitions to `--border-default`, background to `--bg-surface-hover`. Transition: 150ms ease.
* No box-shadows. Depth is communicated through border brightness and background shade only.

### The “terminal block”

Used for: code examples, agent quickstarts, discovery endpoint previews, API response examples.

```
background:    var(--bg-inset)
border:        1px solid var(--border-subtle)
border-radius: 6px
padding:       var(--space-4)
font-family:   var(--font-mono)
font-size:     var(--type-mono)
line-height:   1.5
overflow-x:    auto
```

* Top bar: 32px height, `--bg-surface` background, shows filename or endpoint path in `--text-secondary` mono, plus a copy button (icon only, right-aligned).
* Syntax highlighting palette:
  * Keywords/methods: `--accent-green`
  * Strings: `--accent-cyan`
  * Numbers/prices: `--accent-amber`
  * Comments: `--text-tertiary`
  * Punctuation: `--text-secondary`

### Buttons

**Primary (CTA):**
```
background:    var(--accent-green)
color:         var(--text-inverse)
font-family:   var(--font-mono)
font-weight:   700
font-size:     var(--type-body-sm)
text-transform: uppercase
letter-spacing: 0.05em
padding:       12px 24px
border-radius: 6px
border:        none
```
Hover: `--accent-green-dim`. Active: scale(0.98). Focus: 2px offset ring in `--accent-green`.

**Secondary:**
```
background:    transparent
color:         var(--accent-green)
border:        1px solid var(--accent-green)
/* same font/size/radius as primary */
```
Hover: `--accent-green-bg` background.

**Tertiary (text link button):**
```
color:         var(--accent-cyan)
text-decoration: underline
text-underline-offset: 3px
```

### Tables (data)

```
font-family:       var(--font-mono)
font-size:         var(--type-mono-sm)   /* tight for data-dense views */
border-collapse:   collapse
```
* Header row: `--bg-surface`, `--text-secondary`, `text-transform: uppercase`, `letter-spacing: 0.08em`, `font-size: --type-caption`.
* Body rows: `--bg-root`, alternating `--bg-surface` every other row.
* Row hover: `--bg-surface-hover`.
* Cell padding: `--space-2` vertical, `--space-3` horizontal.
* Column alignment: text left, numbers right, status indicators center.
* On mobile (< 768px): horizontal scroll with a sticky first column, or card-stack layout for ≤ 5 columns.

### Badges / pills

```
font-family:   var(--font-mono)
font-size:     var(--type-caption)
padding:       2px 8px
border-radius: 4px
```
* Status OK: `--accent-green` text on `--accent-green-bg`.
* Warning: `--accent-amber` text on `rgba(255,184,0,0.1)`.
* Error: `--accent-red` text on `rgba(255,59,92,0.1)`.
* Deferred/v1.1: `--accent-purple` text on `rgba(167,139,250,0.1)`.
* Free: `--accent-green` text, no background.

### Navigation

**Top nav (marketing):**
* Sticky, 56px height, `--bg-root` with `backdrop-filter: blur(12px)` and `background: rgba(10,10,15,0.85)`.
* Logo: “AgentDB” in `--font-mono`, 700 weight, `--accent-green`. A blinking cursor `▌` animates after the logo text (CSS-only, `@media (prefers-reduced-motion: no-preference)`).
* Nav links: `--text-secondary`, `--font-sans`, `--type-body-sm`. Hover: `--text-primary`. Active: `--accent-green` underline (2px, offset 6px).
* CTA buttons in nav: Small primary button style.
* Mobile (< 768px): Hamburger menu → full-screen overlay, `--bg-root`, stacked links.

**Console sidebar:**
* 240px fixed width, `--bg-surface`, border-right `--border-subtle`.
* Nav items: `--font-mono`, `--type-body-sm`. Inactive: `--text-secondary`. Active: `--accent-green` with a 2px left border accent.
* Mobile (< 768px): Collapses to a fixed bottom tab bar (5 icons max: Overview, Tables, Receipts, Logs, Settings). More items behind a “...” overflow.

### Inputs

```
background:    var(--bg-inset)
border:        1px solid var(--border-default)
border-radius: 6px
padding:       10px 12px
font-family:   var(--font-mono)
font-size:     var(--type-body-sm)
color:         var(--text-primary)
```
* Focus: border `--border-focus` + `box-shadow: 0 0 0 2px rgba(0,255,159,0.15)`.
* Placeholder: `--text-tertiary`.
* Labels: `--font-sans`, `--type-caption`, `--text-secondary`, `text-transform: uppercase`, `letter-spacing: 0.06em`. Positioned above input with `--space-2` gap.

---

## SG-6) Iconography

* **Icon set:** Lucide (MIT, tree-shakeable SVG, ~0.5 KB per icon).
* **Size:** 16px (inline), 20px (nav/buttons), 24px (feature cards).
* **Color:** Inherits `currentColor`. Never multi-color icons.
* **Status dots:** 8px circles. Solid fill with status color. Pulse animation on active incidents only.

---

## SG-7) Motion & animation

**Rules:**
* All transitions: `150ms ease` unless specified.
* Respect `prefers-reduced-motion: reduce` — disable all non-essential animation.
* No page-level entrance animations. No scroll-triggered fades. Content appears instantly.

**Allowed animations:**
* Blinking cursor on logo: `opacity` toggle, 1s interval, CSS-only.
* Button press: `transform: scale(0.98)`, 100ms.
* Terminal typing effect on hero subhead: Characters appear left-to-right, 30ms/char, mono font. Plays once on load. Skippable (click to reveal all).
* Skeleton loading states in console: `--bg-surface` → `--bg-surface-hover` pulse, 1.5s ease-in-out infinite.
* Metric counters on overview: count-up from 0 over 400ms on first paint. No re-animation.

---

## SG-8) The “terminal prompt” motif

This is the signature visual. Used on:
* Hero section — the subhead types out like a terminal command
* Section dividers — a faint `$` or `>` prompt glyph before section titles (CSS `::before` pseudo-element, `--text-tertiary`, mono)
* Code/quickstart blocks — show a realistic prompt: `$ curl ...`
* Console breadcrumbs — path displayed as `~/tables/tbl_abc123` in mono
* Page transitions — a brief `> loading...` in mono before content appears (console only)

**Implementation:**
```css
.section-title::before {
  content: '>';
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  margin-right: 0.5em;
  font-weight: 400;
}
```

---

## SG-9) The “data overlay” motif

Subtle background pattern that signals “this surface shows machine data”:

* A faint dot-grid pattern (`radial-gradient`, 1px dots at 24px intervals, `rgba(255,255,255,0.03)`) on `--bg-root`.
* On console pages, the main content area has a subtle scanline overlay (`repeating-linear-gradient`, 1px lines at 2px intervals, `rgba(255,255,255,0.01)`).
* Hero section: `--gradient-glow` radial from top-center, creating a soft green/cyan light spill behind the headline.

**These must be purely CSS. No images. No performance cost.**

---

## SG-10) Mobile-specific rules

* **Touch targets:** Minimum 44px × 44px for all interactive elements.
* **No horizontal scroll** on any page at any breakpoint (except data tables with explicit scroll containers).
* **Console tables on mobile:** Switch to card-stack layout. Each row becomes a card with label: value pairs stacked vertically.
* **Bottom tab bar:** Fixed, 56px, `--bg-surface`, border-top `--border-subtle`. Icons + 10px labels in `--type-caption`.
* **Hero text on mobile:** `--type-h1` (not `--type-display`). Subhead: `--type-body`. No typing animation on mobile (respect bandwidth + reduced motion).
* **CTAs on mobile:** Full-width buttons, stacked vertically with `--space-3` gap.
* **Pricing calculator on mobile:** Single-column, inputs stacked. Output pinned to bottom of viewport as a summary bar.

---

## SG-11) Accessibility

* **Contrast:** All text meets WCAG 2.1 AA (4.5:1 for body, 3:1 for large text). `--text-primary` on `--bg-root` = 14.8:1 ✓. `--accent-green` on `--bg-root` = 10.2:1 ✓.
* **Focus indicators:** Visible on all interactive elements. Never `outline: none` without a replacement.
* **Keyboard navigation:** Full tab-order on all pages. Console sidebar navigable with arrow keys.
* **Screen readers:** All icons have `aria-label`. Status badges have `role=”status”`. Live regions for balance updates in console.
* **Reduced motion:** All animations gated behind `@media (prefers-reduced-motion: no-preference)`.

---

## SG-12) Page-specific visual treatments

### Home hero

* Full-bleed dark section. `--gradient-glow` behind headline.
* H1 in `--type-display`, `--text-primary`.
* Subhead in `--font-mono`, `--type-mono-lg`, `--accent-green`, with typing animation.
* Three bullet callouts below: each has a `▸` prefix in `--accent-green`, text in `--text-primary`.
* CTA row: Primary + Secondary buttons side by side. Below: tertiary text link.
* No illustration. No hero image. The **typography is the visual.**

### Pricing page

* Plan cards side-by-side (2 on desktop, stacked on mobile).
* Each card: `--bg-surface`, green top-border (2px `--accent-green`).
* Unit pricing table: full `--font-mono`, right-aligned numbers in `--accent-cyan`.
* Calculator: inset `--bg-inset` panel, real-time output updates, no submit button. Numbers animate on change (count-up, 200ms).

### Console overview

* KPI row: 5 metric cards in a row (3 + 2 on tablet, stacked on mobile).
* Each KPI: large number in `--font-mono` `--type-h1`, label in `--type-caption` `--text-secondary`.
* Charts: minimal line charts, `--accent-green` fill/stroke on `--bg-inset`. No chart library > 10 KB — use `<canvas>` or lightweight (uPlot, Chart.css).
* Warning cards: `--accent-amber` left-border (3px), amber-tinted background.

### Approval page (v1.1)

* Approval cards: prominent green “Approve” CTA, muted “Deny” in `--text-secondary`.
* Max spend number: `--type-h2`, `--font-mono`, `--accent-cyan`. This is the biggest number on the card.
* “Type table name to confirm” input: `--bg-inset`, mono, with a blinking cursor.

### Receipts / Logs

* Dense data table layout. `--font-mono` throughout.
* Request IDs: truncated with `...`, full value on hover tooltip or click-to-copy.
* Timestamps: relative (“2m ago”) with absolute on hover.
* Filter bar: inset panel at top, mono inputs, instant filtering (no submit).

---

## SG-13) Dos and Don'ts

### Do
* Use monospace for anything a machine produces: IDs, hashes, prices, timestamps, endpoints, status codes.
* Show costs prominently with `$` prefix and 2 decimal places.
* Truncate long values; offer copy-to-clipboard.
* Use the `>` prompt motif on section headers for terminal feel.
* Keep marketing copy short. If a section needs > 3 sentences, it's too long.

### Don't
* Don't use gradients on text (illegible, slow on mobile).
* Don't add parallax, scroll jacking, or scroll-triggered animations.
* Don't use colored backgrounds on marketing sections — dark + border-separated cards only.
* Don't put marketing fluff on agent-facing or docs pages.
* Don't use loading spinners — use skeleton placeholders.
* Don't use shadows. Depth = border brightness.
* Don't use rounded corners > 8px anywhere.

---

## SG-14) CSS custom properties — full token export

```css
:root {
  /* Colors */
  --bg-root: #0A0A0F;
  --bg-surface: #111118;
  --bg-surface-hover: #1A1A24;
  --bg-elevated: #16161F;
  --bg-inset: #08080C;
  --border-subtle: #1E1E2A;
  --border-default: #2A2A3A;
  --border-focus: #00FF9F;
  --text-primary: #E8E8ED;
  --text-secondary: #8888A0;
  --text-tertiary: #555566;
  --text-inverse: #0A0A0F;
  --accent-green: #00FF9F;
  --accent-green-dim: #00CC7F;
  --accent-green-bg: rgba(0,255,159,0.08);
  --accent-cyan: #00D4FF;
  --accent-cyan-dim: #00A8CC;
  --accent-amber: #FFB800;
  --accent-red: #FF3B5C;
  --accent-purple: #A78BFA;

  /* Typography */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', 'Cascadia Code', 'Fira Code', ui-monospace, monospace;
  --type-display: 3rem;
  --type-h1: 2.25rem;
  --type-h2: 1.5rem;
  --type-h3: 1.125rem;
  --type-body: 1rem;
  --type-body-sm: 0.875rem;
  --type-caption: 0.75rem;
  --type-mono-lg: 1.125rem;
  --type-mono: 0.875rem;
  --type-mono-sm: 0.75rem;

  /* Spacing */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;
  --space-9: 96px;

  /* Layout */
  --grid-max-width: 1200px;
  --grid-gutter: 24px;
  --grid-margin: 24px;
}
```

---

*End of Style Guide. Blueprint content follows below.*

---

Below is a **complete website blueprint** for **AgentDB** by **Run402**, an x402-powered “accountless cloud NoSQL” product. It includes:

* **Human-facing** marketing + console (costs, budgets, logs, approvals)
* **Agent-facing** machine-discoverable endpoints + agent-readable docs + MCP surface
* **Clear separation** between what’s *standard x402* vs *helpful conventions*

I’m assuming:

* You **do not reveal** DynamoDB (or AWS) anywhere in the public UI.
* You sell **QoS-backed tiers**, with an SLA and transparent status.
* You enforce “pay over time” via **lease + top-ups** (and/or prepaid balance), using x402’s 402 flow. x402 v2 defines the standard payment headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`). ([docs.x402.org][1])

---

## 1) Domain layout and “surfaces”

Use separate surfaces so agents never have to crawl marketing pages.

### Recommended hostnames

* `run402.com` → marketing + docs (human-first)
* `app.run402.com` → wallet-based console (human ops) + paid API (agent + human SDKs)
* `status.run402.com` → status page (public)

---

## 2) Global navigation

### Top nav (marketing/docs)

* Product
* Pricing
* Docs
* Security
* SLA
* Status
* Console (CTA)
* Install for Agents (CTA)

### Console nav

* Overview
* Tables
* Approvals
* Usage & Receipts
* Logs
* Budgets & Limits
* Settings

---

## 3) Sitemap

### Marketing (human-facing)

* `/` Home
* `/product`

  * `/product/agentdb`
  * `/product/agents`
  * `/product/billing`
  * `/product/observability`
  * `/product/qos`
* `/pricing`
* `/docs`

  * `/docs/quickstart/agents`
  * `/docs/quickstart/humans`
  * `/docs/api`
  * `/docs/mcp`
  * `/docs/x402`
  * `/docs/security`
  * `/docs/limits`
* `/security`
* `/sla`
* `/status` (links to status site)
* `/legal`

  * `/legal/terms`
  * `/legal/privacy`
  * `/legal/aup`
  * `/legal/dpa` (optional)
* `/support` (contact, community, etc.)

### Console (human-facing ops)

* `/` (connect wallet / resume session)
* `/overview`
* `/tables`
* `/tables/{table_id}`
* `/approvals` *(v1.1)*
* `/approvals/{approval_id}` *(v1.1)*
* `/usage`
* `/receipts`
* `/logs`
* `/budgets`
* `/settings`

### Public approval flow (human approval initiated by agent) *(v1.1)*

* `app.run402.com/approve/{approval_id}`

### Agent-facing (machine + protocol)

* `app.run402.com/.well-known/x402` (x402 discovery manifest — convention; aligns with emerging discovery patterns) ([datatracker.ietf.org][2])
* `app.run402.com/.well-known/mcp.json` (MCP “server card” pattern)
* `app.run402.com/x402/discovery` (tool + pricing catalog; convenience convention used in the ecosystem) ([agent402.dev][3])
* `app.run402.com/mcp` (MCP transport endpoint; optional) ([agent402.dev][3])
* `app.run402.com/openapi.json`
* `app.run402.com/llms.txt` (agent/doc indexing outline; highly recommended)
* `app.run402.com/meta.json` (machine-friendly endpoint map; convenience convention)

---

## 4) Home page design

### Page goal

In <20 seconds, a human should understand:

* “This is a cloud DB for agents”
* “No AWS accounts”
* “Costs are pre-approved and capped”
* “SLA + logs + receipts exist”

### Hero (above the fold)

**Headline:**
**A cloud database your agent can buy.**

**Subhead:**
Provision a production-grade table in seconds—no cloud accounts, no API keys, no billing setup.
Agents get quotes, humans approve a cap, and x402 handles payment over HTTP.

**Primary CTA:** `Install for Agents`
**Secondary CTA:** `Open Console`
**Tertiary CTA:** `Read Docs`

**Right-side hero element:** “Approval + provisioning” mini-flow animation:

1. Quote shown
2. Human approves budget
3. Table created
4. Receipts & logs visible

### Section: “How it works”

Four cards:

1. **Quote**: “Estimate cost and set a hard cap”
2. **Approve**: “One click approval, wallet payment”
3. **Use**: “Key-value + query API, agent-native”
4. **Expire**: “Auto-expire so you never pay forever”

### Section: “Built for agent workflows”

* “Works from coding agents (Claude Code, Cursor, CI bots)”
* “Machine-discoverable endpoints”
* “MCP integration available”

### Section: “Cost controls you can trust”

* Budgets & limits
* Receipts / line items
* Top-up rules
* Auto-suspend + auto-expire (prevents abandoned cost)

### Section: “QoS you can contract”

* Regional tier SLA
* Multi-region tier SLA
* Public status page
* Incident transparency

### Footer (trust anchors)

* Security summary: encryption at rest, TLS, data isolation model (without naming DynamoDB)
* Links to: Security, SLA, Status, Legal, Docs

---

## 5) Product pages

### `/product` (overview)

Split into five feature pillars, each linking deeper:

1. **Tables**

* “Create tables with a primary key (and optional sort key)”
* “TTL and retention”
* “Fast CRUD”

2. **Agents**

* “No accounts / no keys”
* “x402 payment negotiation via HTTP 402”
* “MCP-compatible tools”
* “Discovery endpoints”

3. **Billing**

* “Lease + prepaid balance”
* “Hard caps and top-ups”
* “Receipts with correlation IDs”
* “Exportable billing CSV”

4. **Observability**

* “Audit log”
* “Ops log (latency, units, errors)”
* “Request IDs”
* “User-accessible log retention tiers”

5. **QoS**

* “Tiered availability targets”
* “Backpressure and rate limiting”
* “Dedicated capacity options (later)”

---

## 6) Pricing page

### Page goal

Pricing must support *human approval* and *agent automation*.

#### Layout

1. **Simple plan cards** (what humans buy)
2. **Unit pricing** (what agents reason about)
3. **Calculator** (quote UX)
4. **Examples** (common workloads)

### Plan cards (example)

* **Dev / Ephemeral**

  * Default TTL: 7 days
  * Logs: 7 days
  * SLA: best-effort / basic
  * Designed for “agent tasks”

* **Project**

  * Longer TTL
  * Logs: 30 days
  * SLA: higher
  * Export tools

* **Production** *(planned for v2)*

  * Multi-region option
  * Higher SLA
  * Longer log retention
  * Priority support

### Unit pricing section

Present these as *AgentDB units*, not cloud-vendor units:

| Meter | Price |
|---|---:|
| Read Units | **$1.50 / million RRU** |
| Write Units | **$7.50 / million WRU** |
| Storage | **$1.50 / GB-month** |
| Egress (response data) | **$0.30 / GB** |
| Table create | **$0.02** |
| Table-day (Ephemeral) | **$0.005** |
| Table-day (Project) | **$0.01** |

### Payment model section (critical)

Explain the **lease** model clearly:

* “Tables are leased resources. You pre-fund a balance. Usage and storage draw down that balance. When it’s low, the API returns HTTP 402 with a top-up requirement.”

Tie it to x402 mechanics:

* x402 uses HTTP 402 plus standardized payment headers to negotiate payment (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`). ([docs.x402.org][1])

### “Cost visibility” promises

* Real-time usage estimates
* Receipts ledger
* Alerts: low balance, approaching cap

---

## 7) Docs design

### Docs IA (left-nav)

* **Quickstarts**

  * Agents (MCP)
  * Agents (REST/OpenAPI)
  * Humans (Console approvals + monitoring)
* **Core concepts**

  * Tables, keys, TTL
  * Budgets, caps, leases
  * Logs, receipts, request IDs
  * QoS tiers and SLAs
* **x402**

  * Payment flow (402 → pay → retry)
  * Idempotency (payment-identifier)
  * SIWX sign-in (wallet-based session)
  * Discovery (Bazaar metadata)
* **API reference**

  * OpenAPI docs
  * Examples (curl / TS / Python)
* **Limits & anti-abuse**
* **Security**
* **FAQ**

### Quickstart: Agents (MCP)

Show the exact three-step canonical discovery order (agent-readable, concise), modeled on what’s working in the ecosystem: `/.well-known/mcp.json` → `/x402/discovery` → `/mcp`. ([agent402.dev][3])

### Quickstart: Agents (REST)

* Hit `POST /v1/tables:quote`
* Create table (pay 402)
* CRUD/query
* Handle 402 top-ups
* *(v1.1: approval request + poll)*

### Quickstart: Humans

* Review quote + approve spend (via console or approval link *(v1.1)*)
* Review quote & cap
* Pay deposit/top-up
* View table in console
* Watch logs and receipts
* Delete/expire

---

## 8) Console design (human-facing ops without “accounts”)

### Authentication (no accounts)

Two modes:

1. **Wallet sign-in (recommended)**
   Use x402 SIWX to prove wallet ownership and issue a session token for the console. SIWX is explicitly designed for repeat access without repaying, by proving wallet control via a signed message. ([docs.x402.org][4])

2. **Capability link (fallback)**
   If a user doesn’t want wallet sign-in, allow “paste a Workspace Key” (capability token).
   (This is UX-friendly for devs; you can discourage it for production.)

### Console: Overview screen

Top KPIs:

* Current balance
* Spend today / week
* Tables count
* Active approvals
* Recent errors (last 24h)

Widgets:

* Usage chart (by day)
* “Top tables by cost”
* “Low balance warnings”
* “Recently created tables (auto-expiring)”

### Console: Tables list

Table-like list with:

* Table name
* TTL/expiry date
* Budget cap
* Current balance allocated
* Last activity
* Health indicator

Bulk actions:

* Extend TTL (requires top-up)
* Delete
* Export receipts

### Console: Table detail

Tabs:

**A) Overview**

* endpoints
* region/tier (but described as “Regional / Multi-region”, not vendor region names)
* TTL and expiry
* current budget settings
* last 1h/24h ops + errors

**B) Access**

* table secret (capability token) management (rotate)
* optional IP allowlist (if you add)
* “Generate agent snippet” (copy/paste)

**C) Usage**

* usage buckets
* cost estimate by unit type
* “what changed” highlights (“writes spiked at 14:32”)

**D) Receipts**

* append-only ledger
* downloadable CSV/JSON
* correlation IDs

**E) Logs**

* Audit
* Ops
* Errors
  Filters: time range, request id, operation type, status

**F) Settings**

* budgets & caps
* rate limits
* retention
* delete table

### Console: Approvals *(v1.1)*

Two subviews:

1. **Incoming approvals**

* created by an agent (local broker)
* show: requested TTL, expected ops, max spend, duration, policy reasons

2. **Approval history**

* approved/denied
* receipts attached

---

## 9) The “agent asks, human approves” UX *(v1.1 — designed, deferred from MVP)*

> **Note:** The approval flow below is designed and specified but deferred to v1.1. The MVP ships with direct x402 pay-and-go: the agent calls `POST /v1/tables:quote` (free), then `POST /v1/tables` which returns 402, the agent pays and retries, and the table is created. See D12 in the Decisions Log (spec.md).

This is the UX that makes your product feel inevitable.

### Step-by-step

1. Agent creates approval request:

* `POST /v1/approvals` with quote + proposed cap + TTL + justification string
* Server returns:

  * `approval_id`
  * `approval_url` (human)
  * `agent_poll_url`

2. Human opens approval URL:

* sees quote breakdown
* sees “max spend” prominently
* sees TTL/auto-expire
* clicks **Approve & Fund**

3. Payment happens via x402:

* if funding required, server returns `402 Payment Required` with `PAYMENT-REQUIRED` header, per x402 v2. ([docs.x402.org][1])
* browser wallet (or broker) signs payment and retries with `PAYMENT-SIGNATURE`
* server responds success with `PAYMENT-RESPONSE` ([docs.x402.org][1])

4. Agent polls until approval is `APPROVED`, then provisions table automatically.

### Approval page UI (what to show)

* **Summary**

  * Purpose: “Requested by local coding agent”
  * Requested cap: **$X maximum**
  * Expected range: $a–$b
  * Auto-expire: date/time
* **Breakdown**

  * Read/Write units estimate
  * Storage estimate
  * Log retention (if enabled)
* **Controls**

  * Approve
  * Deny
  * Edit cap (increase/decrease)
  * Shorten TTL (recommended safe default)
* **Safety text**

  * “If usage hits the cap, requests will pause until you top up.”

---

## 10) Agent-facing “website”: stable machine endpoints

This is the part most teams miss. Make it boring, stable, cacheable.

### A) `/.well-known/x402` (x402 discovery manifest)

There’s an emerging discovery pattern using a manifest at `/.well-known/x402` and even DNS TXT discovery records pointing to it. ([datatracker.ietf.org][2])
You don’t need the DNS record day 1, but you should structure the manifest so crawlers and agents can find payable resources.

**Recommended contents** (practical superset):

* api base url
* OpenAPI url
* MCP endpoints (if present)
* supported x402 schemes/networks
* list of “resources” with price models and schemas

### B) Bazaar metadata (x402-native discovery)

x402 v2 codifies “Bazaar” as an extension where you declare discoverability metadata (schemas/tags/category) in route config so facilitators can index your endpoints and clients can query `/discovery/resources`. ([docs.cdp.coinbase.com][5])

Action for your site/docs:

* Add a docs page: “Discover AgentDB via Bazaar”
* Make sure your routes include `extensions.bazaar.discoverable: true`

### C) `/.well-known/mcp.json` + `/mcp` (agent tool surface)

In the agent ecosystem, a stable MCP card at `/.well-known/mcp.json` plus a discovery endpoint is proving useful and agent-friendly. ([agent402.dev][3])

If you ship an MCP server:

* `GET /.well-known/mcp.json` → machine metadata
* `GET /x402/discovery` → tools + schema + prices
* `POST /mcp` → MCP transport

### D) `llms.txt`

Publish a concise, structured outline of your docs at `/llms.txt` so agents can ingest without crawling everything.

---

## 11) Agent-facing content pages (human-readable, agent-readable)

### `/agents` page (write it like a protocol doc, not marketing)

Structure:

* “Core endpoints” (3–5)
* “Discovery order”
* “402 retry rule”
* “Idempotency rule”
* “Cost safety rule”
* “Examples”

Example content (what the page should say, roughly):

* **Discovery order:** `/.well-known/mcp.json` → `/x402/discovery` → `/mcp`
* **If HTTP 402 returned:** read `PAYMENT-REQUIRED`, pay, retry same call with `PAYMENT-SIGNATURE` (do not mutate args)
* **Idempotency:** include payment-identifier for write-like operations
* **Budget safety:** set `max_spend_usd` on approval / table creation

(That aligns with x402’s standard header flow. ([docs.x402.org][1]))

---

## 12) Security, SLA, and Status pages

### `/security`

Content blocks:

* encryption at rest + in transit
* key management posture (don’t mention AWS)
* isolation model: “table-level isolation”
* data retention & deletion guarantees
* incident response: “how we handle”
* vulnerability disclosure email

### `/sla`

Define tiers:

* Regional
* Multi-region

Explain:

* what counts as downtime
* how credits work (your policy)
* support response time by tier

### Status site

* current status banner
* incident history
* uptime chart
* API latency chart (p50/p95)
* subscribe to updates (RSS/email/webhook)

---

## 13) Legal pages

Minimal set:

* Terms
* Privacy
* Acceptable Use Policy (AUP)

Optional (if you sell to companies):

* Data Processing Addendum (DPA)

Add an explicit clause about:

* payment finality (stablecoin settlement)
* dispute resolution for service credits

---

## 14) Concrete “agent-facing endpoints” spec you can hand to engineers

Here’s a minimal set you can implement that makes agents happy immediately (paths only; domains are placeholders):

```txt
# Agent discovery
GET  https://app.run402.com/.well-known/x402
GET  https://app.run402.com/openapi.json
GET  https://app.run402.com/llms.txt
GET  https://app.run402.com/meta.json

# Optional MCP surface
GET  https://app.run402.com/.well-known/mcp.json
GET  https://app.run402.com/x402/discovery
POST https://app.run402.com/mcp

# Core API (REST)
POST /v1/tables:quote
POST /v1/approvals                        # v1.1
GET  /v1/approvals/{approval_id}           # v1.1
POST /v1/tables
GET  /v1/tables
GET  /v1/tables/{table_id}
PUT   /v1/tables/{table_id}/items/{pk}
PATCH /v1/tables/{table_id}/items/{pk}
GET   /v1/tables/{table_id}/items/{pk}
DELETE /v1/tables/{table_id}/items/{pk}
POST  /v1/tables/{table_id}:query
POST  /v1/tables/{table_id}:scan
POST  /v1/tables/{table_id}:batch-get
POST  /v1/tables/{table_id}:batch-write
GET   /v1/usage
GET  /v1/receipts
GET  /v1/tables/{table_id}/logs
DELETE /v1/tables/{table_id}
```

And **payment behavior** for any route that can require funding:

* return `402` with `PAYMENT-REQUIRED`
* accept retry with `PAYMENT-SIGNATURE`
* return `PAYMENT-RESPONSE` on success ([docs.x402.org][1])

---

## 15) Copy you can reuse verbatim

### Header CTA

**Install for Agents**
**Open Console**

### Home hero

**A cloud database your agent can buy.**
No cloud accounts. No API keys. Hard cost caps, receipts, and logs built in.

### Pricing model explainer

**Lease-based billing:** Tables are pre-funded resources. Usage and storage draw down your balance. When balance is low, requests pause with a standardized HTTP 402 paywall until you top up.

### Trust line

**Transparent costs, predictable behavior:** Every request carries a request ID, metering headers, and is reflected in an exportable receipts ledger.

---

## 16) Implementation notes (what to build first)

If you want the website to be “complete” *and* shippable fast, prioritize:

1. Marketing home + pricing + docs skeleton
2. Agent quickstart page (`/agents`)
3. `api` discovery endpoints: `/.well-known/x402`, `openapi.json`, `llms.txt`
4. Console MVP: Overview, Tables, Receipts, Logs
5. Status page

*Post-MVP (v1.1):* Console Approvals page, public approval link flow.

Everything else (SEO polish, case studies, enterprise pages) can come later without breaking the core.

---

If you want, I can produce the **actual first-pass content** for every page (final copy + headings + example screenshots/wireframes in text), and the **exact JSON schemas** for:

* `/.well-known/x402`
* `/.well-known/mcp.json`
* `/x402/discovery`
* `/meta.json`
* `/llms.txt`

…so your engineers can implement it directly.

[1]: https://docs.x402.org/core-concepts/http-402 "HTTP 402 - x402"
[2]: https://datatracker.ietf.org/doc/draft-jeftovic-x402-dns-discovery/ "
            
    
        draft-jeftovic-x402-dns-discovery-00 - Discovering x402 Resources via DNS TXT Records
    

        "
[3]: https://agent402.dev/ "agent402.dev | MCP Gateway Documentation"
[4]: https://docs.x402.org/extensions/sign-in-with-x?utm_source=chatgpt.com "Sign-In-With-X (SIWX)"
[5]: https://docs.cdp.coinbase.com/x402/bazaar "x402 Bazaar (Discovery Layer) - Coinbase Developer Documentation"





---





Below is a **copy‑pasteable “website content pack”** for **AgentDB** by **Run402** with:

* Human-facing marketing + console UX copy (wallet sign-in, approvals, budgets, receipts, logs)
* Agent-facing docs (MCP + REST) written in “agent‑readable” style
* A **Learning** section explaining **x402** (what it is, how it works, why it matters, vision)
* A **Comparison** page vs common alternatives
* **Exact JSON Schemas + example instances** for:

  * `/.well-known/mcp.json`
  * `/x402/discovery`
  * `/meta.json`
  * `/llms.txt` (template)
  * `/.well-known/x402` (manifest used for discovery; aligns with the DNS discovery draft’s well-known path convention) ([IETF Datatracker][1])

Factual grounding for x402 details:

* x402 uses **HTTP 402 Payment Required** and includes payment requirements in a `PAYMENT-REQUIRED` header; clients retry with `PAYMENT-SIGNATURE`. ([Coinbase Developer Docs][2])
* x402 supports using a **facilitator** to verify/settle payments via `/verify` and `/settle`. ([x402][3])
* x402 V2 adds wallet-based identity and discovery improvements. ([x402][4])
* SIWX is CAIP-122 wallet auth to access previously purchased resources without repaying. ([x402][5])
* Payment-Identifier provides idempotency for safe retries. ([x402][6])
* Bazaar is a machine-readable discovery layer for payable APIs. ([Coinbase Developer Docs][7])

Competitive comparisons grounded by vendor docs:

* Upstash pricing examples ($0.20 / 100K commands; storage/bandwidth). ([Upstash: Serverless Data Platform][8])
* Upstash uses endpoint + token for REST and API keys for their developer API. ([Upstash: Serverless Data Platform][9])
* Turso pricing uses “monthly active databases”, storage/rows read/written line items. ([turso.tech][10])
* Turso authenticates via API tokens (CLI/API). ([docs.turso.tech][11])
* Cloudflare KV pricing appears in platform pricing; KV billing is op-based and typically managed via Cloudflare tokens. ([cloudflare.com][12])
* Firestore has free quota but requires enabling billing to exceed it. ([Google Cloud][13])

---

# 0) Brand + site-wide UX rules

## Brand placeholders

* Product: **AgentDB**
* Tagline: **“A cloud database your agent can buy.”**
* Primary CTA: **Install for Agents**
* Secondary CTA: **Open Console**
* Tone: technical, compact, no fluff; default to concrete behaviors (caps, TTLs, receipts).

## Site-wide UX rules

* Always show a **Max Spend** number wherever money appears.
* Always show **Expiry / TTL** wherever a table is shown.
* Every cost number has a companion link: “How this is calculated”.
* Every operational surface shows:

  * `Request ID`
  * `Table ID`
  * `Metered Units`
  * `Estimated Cost`
* Every destructive action has a “Type the table name to confirm” pattern.

---

# 1) File tree / route map

Use this as a Next.js / Remix / SSG content layout.

```
/marketing
  /index
  /product
  /product/agentdb
  /product/agents
  /product/billing
  /product/observability
  /product/qos
  /pricing
  /docs
  /security
  /sla
  /status (redirect)
  /compare
  /support
  /legal/terms
  /legal/privacy
  /legal/aup

/learn
  /index
  /what-is-x402
  /how-x402-works
  /x402-for-agents
  /vision
  /safety-and-trust
  /glossary
  /faq

/console
  /index (connect wallet / resume)
  /overview
  /tables
  /tables/[table_id]
  /approvals
  /usage
  /receipts
  /logs
  /budgets
  /settings

/api (machine-facing)
  /.well-known/mcp.json
  /.well-known/x402
  /x402/discovery
  /meta.json
  /llms.txt
  /openapi.json
```

---

# 2) Marketing pages (final first-pass copy + wireframes)

## 2.1 `/` Home

**Meta title:** AgentDB — A cloud database your agent can buy
**Meta description:** Provision a production-grade table in seconds with explicit cost caps, receipts, and logs. No cloud accounts. x402 payments over HTTP.

### Above the fold (Hero)

**H1:** A cloud database your agent can buy.
**Subhead:** Spin up durable cloud state in seconds—without creating a cloud account, copying API keys, or setting up billing. Agents request a quote. Humans approve a cap. AgentDB provisions automatically.

**Primary CTA button:** Install for Agents
**Secondary CTA button:** Open Console
**Tertiary link:** Read the Agent Quickstart

**Hero callouts (3 bullets):**

* **Hard caps**: “Never spend more than $X unless you approve it.”
* **Receipts + logs**: “Every operation has a request ID and a line item.”
* **Auto-expire**: “No abandoned resources billing you forever.”

### Section: How it works (4-step)

**Title:** Built for “agent asks → human approves → done”
**Cards:**

1. **Quote**
   “AgentDB returns an estimate range + a maximum spend cap proposal.”
2. **Approve**
   “One click approval. Optional wallet sign-in. Fund a lease.”
3. **Provision**
   “Table is created and ready. No vendor console needed.”
4. **Use + Monitor**
   “CRUD + query, with receipts and logs you can export.”

### Section: What you get

**Title:** Production behaviors, agent-native interface
**Grid (6 items):**

* Tables with keys + TTL
* Query by key/range
* Budget caps + rate limits
* Usage dashboard + receipts
* Audit + ops logs
* SLA tiers + status page

### Section: “Works where your agents run”

**Title:** Use from local coding agents, CI bots, or agent runtimes
**Copy:** Use AgentDB via REST, OpenAPI, or MCP. For local agents, install the AgentDB Broker so the agent can request approval and proceed safely.

### Section: Trust

**Title:** Safe by default
**Bullets:**

* Default TTL on every table
* Default max spend cap
* Read-only suspension on low balance (configurable)
* Explicit top-ups, never silent overages

### Footer

Links: Product, Pricing, Docs, Learn x402, Compare, Security, SLA, Status, Legal.

#### Wireframe (ASCII)

```
┌────────────────────────────────────────────────────────────┐
│ AgentDB  Product  Pricing  Docs  Learn  Compare  Console    │
├────────────────────────────────────────────────────────────┤
│ H1: A cloud database your agent can buy.                    │
│ Subhead: ...                                                │
│ [Install for Agents] [Open Console] [Agent Quickstart]      │
│  • Hard caps  • Receipts+logs  • Auto-expire                │
├────────────────────────────────────────────────────────────┤
│  Quote → Approve → Provision → Use + Monitor                │
├────────────────────────────────────────────────────────────┤
│ Feature grid (Tables, TTL, Budgets, Receipts, Logs, SLA...) │
├────────────────────────────────────────────────────────────┤
│ Trust + Footer links                                        │
└────────────────────────────────────────────────────────────┘
```

---

## 2.2 `/product` Product overview

**H1:** AgentDB is cloud state you can procure at runtime.
**Intro:** Most managed databases assume a human will sign up, create projects, and manage credentials. AgentDB assumes an agent needs a database *now*—and a human wants explicit cost control.

### Sections

1. **Tables**
   “Create tables with a primary key (optional sort key), TTL, and predictable query patterns.”
   CTA: Explore Tables

2. **Agents**
   “MCP + REST. Discovery endpoints. Standardized payment negotiation via x402.”
   CTA: Explore Agents

3. **Billing**
   “Lease-based resources with top-ups and hard caps.”
   CTA: Explore Billing

4. **Observability**
   “Receipts ledger, audit log, ops logs, export.”
   CTA: Explore Observability

5. **Quality of Service**
   “Tiered SLA, status transparency, predictable throttling behavior.”
   CTA: Explore QoS

---

## 2.3 `/product/agentdb`

**H1:** Tables: simple, durable, key-based state
**Subhead:** Enough database to build real software. Small enough for agents to use correctly.

### What tables support (v1)

* Create/delete tables
* Primary key (string), optional sort key (string)
* Put/get/update/delete items
* Query by partition key; optional sort key range/prefix
* Scan (guarded, with explicit opt-in + hard limits)
* Batch get/write operations
* TTL at table level
* Pagination

### What tables don’t support (v1)

* Multi-item transactions
* Secondary indexes (GSI/LSI)
* Change streams / triggers

### “Design for agent predictability”

**Copy:** Every request returns:

* Request ID
* Metered units
* Estimated cost
* Remaining balance (if applicable)

CTA: “See API reference”

---

## 2.4 `/product/agents`

**H1:** Designed for coding agents and tool brokers
**Subhead:** Agents discover capabilities and prices, request approval, and proceed without manual setup.

### Integration options

1. **MCP (recommended for agent tooling)**

* Stable discovery endpoints
* `tools/list` + `tools/call`
* 402-aware retries

2. **REST / OpenAPI**

* `POST /tables:quote`
* `POST /approvals` *(v1.1)*
* `POST /tables`
* data-plane CRUD/query

### The approval primitive *(v1.1)*

**Copy:** Agents should never spend money without an explicit policy. AgentDB supports an “approval request” object so your local broker can ask the human once, then execute safely.

CTA: “Agent Quickstart (MCP)” and “Agent Quickstart (REST)”

---

## 2.5 `/product/billing`

**H1:** Pay over time without subscriptions or accounts
**Subhead:** Tables are leased resources. You pre-fund, spend down, and renew when needed.

### Billing behaviors

* **Deposit / top-up**: Fund a table or workspace balance.
* **Spend caps**: Hard daily and lifetime caps (configurable).
* **Low-balance handling**: Return 402 for top-up; optionally suspend writes first.
* **Expiry**: Default TTL; explicit extension requires approval.

### Why leases

**Copy:** Storage costs exist even when you aren’t sending requests. The lease model ensures you never keep paying for resources you forgot.

CTA: “See receipts & usage demo”

---

## 2.6 `/product/observability`

**H1:** Cost visibility and logs are first-class
**Subhead:** If an agent can create infrastructure, you need receipts and logs you can trust.

### Observability surfaces

* **Usage**: time-bucketed units + estimated cost
* **Receipts**: append-only ledger entries, exportable
* **Audit log**: creation, deletion, approvals, budget changes
* **Ops log**: request IDs, latency, errors, units

### Export options

* CSV export for receipts
* JSONL export for logs
* Webhook (optional / roadmap)

CTA: “Open Console → Logs”

---

## 2.7 `/product/qos`

**H1:** Quality of service you can contract
**Subhead:** Tiered availability targets, predictable behavior under load, and transparent status.

### QoS guarantees (what you can safely claim in copy)

* Availability targets by tier (Regional / Multi-region)
* Rate limiting behavior documented
* Error taxonomy documented
* Incident transparency + postmortems

CTA: “Read SLA”

---

## 2.8 `/pricing`

**Meta title:** Pricing — AgentDB
**H1:** Usage-based pricing with hard caps

### Pricing philosophy

**Copy:** Pricing must be machine-readable and human-approvable. Agents get quotes. Humans approve max spend. Usage draws down funded balance.

### Plan cards (example)

**Ephemeral (Dev)**

* Default TTL: 7 days
* Logs: 7 days
* Best-effort support

**Project**

* TTL: configurable
* Logs: 30 days
* Higher SLA target

*Production tier (multi-region, longer log retention, priority support) is planned for v2.*

### Unit pricing table

| Meter | Price |
|---|---:|
| Read Units | **$1.50 / million RRU** |
| Write Units | **$7.50 / million WRU** |
| Storage | **$1.50 / GB-month** |
| Egress (response data) | **$0.30 / GB** |
| Table create | **$0.02** |
| Table-day (Ephemeral) | **$0.005** |
| Table-day (Project) | **$0.01** |

### Calculator (UI spec)

Inputs:

* items avg size (KB)
* writes/day
* reads/day
* retention days
* max spend cap

Outputs:

* estimated daily / monthly
* recommended deposit for N days
* “worst-case” bound = cap

CTA: “Try Quote API”

---

## 2.9 `/docs` (Docs landing)

**H1:** Documentation
**Tiles:**

* Agent Quickstart (MCP)
* Agent Quickstart (REST)
* Human Quickstart (Approvals + Console)
* Core Concepts (Tables, Budgets, Leases, Logs)
* API Reference (OpenAPI)
* Security + Limits

---

## 2.10 `/security`

**H1:** Security
**Sections (copy placeholders—do not claim certifications you don’t have):**

* Data encryption (in transit / at rest)
* Table isolation model (shared multi-tenant table with PK-prefixed logical isolation)
* Access model (capability tokens + wallet sign-in)
* Logging and audit
* Responsible disclosure (security@…)
* Data deletion and retention

---

## 2.11 `/sla`

**H1:** Service Level Agreement (SLA)
**Sections:**

* Definitions (availability, downtime)
* Measurement window
* Tier targets
* Credits schedule
* Exclusions
* How to claim credits
* Status page as the source of truth

---

## 2.12 `/status`

Redirect to `status.run402.com`

**Copy:** “Live status and incident history.”

---

## 2.13 `/support`

**H1:** Support

* Email support
* Community link (Discord/Slack)
* “Report an incident”
* “Request quota increase”
* “Enterprise contact”

---

## 2.14 Legal stubs

* `/legal/terms` (Terms of service)
* `/legal/privacy`
* `/legal/aup` (Acceptable use)

---

# 3) Learning section (humans): x402, what it enables, vision

This Learning section is grounded in x402’s public docs and ecosystem material, including: “x402 is an open payment standard built around HTTP 402,” the 402/headers handshake, facilitator verify/settle, SIWX, and discovery/Bazaar. ([x402][3])

## 3.1 `/learn` (landing)

**H1:** Learn: x402 and agent-native procurement
**Subhead:** A practical guide for humans: what x402 is, how it works, and what it unlocks.

**Cards:**

* What is x402?
* How x402 works (402 → pay → retry)
* x402 for agents
* Vision: payments as a native web primitive
* Safety & trust (caps, receipts, fraud)
* Glossary + FAQ

---

## 3.2 `/learn/what-is-x402`

**H1:** What is x402?
**Lead:** x402 is a payment standard that revives HTTP 402 (“Payment Required”) so services can charge for resources over plain HTTP.

### The core idea

* Client requests a resource
* Server replies “Payment Required” with machine-readable payment instructions
* Client pays programmatically and retries with proof

### What this replaces

* API key onboarding
* account creation
* credit card forms
* monthly subscriptions for small, metered usage

### Why stablecoins / fast settlement matters (human-friendly)

* Small payments without card fees
* Programmatic spend by software
* Global compatibility (wallet-based)

> In AgentDB, x402 is the “checkout” step that an agent can complete safely after you approve a cap.

---

## 3.3 `/learn/how-x402-works`

**H1:** How x402 works (the handshake)
**Subhead:** If you understand HTTP, you understand x402.

### Step-by-step

1. **Attempt**
   Client sends a normal HTTP request.

2. **402 Challenge**
   Server responds with `402 Payment Required` and includes payment requirements in a `PAYMENT-REQUIRED` header.

3. **Payment payload**
   Client chooses a supported scheme/network and creates a payment payload.

4. **Retry with proof**
   Client retries the *same request* with `PAYMENT-SIGNATURE`.

5. **Verification/settlement**
   Server verifies and settles directly or via a facilitator (`/verify` and `/settle`).

6. **Response**
   Server returns the requested resource, often with a payment receipt header.

### Reliability primitives for real systems

* **Idempotency**: use Payment-Identifier so retries don’t double charge.
* **Wallet identity**: SIWX allows repeat access without repaying for the same entitlement.

---

## 3.4 `/learn/x402-for-agents`

**H1:** x402 for agents: why this is different from “normal billing”
**Subhead:** x402 separates payment from identity.

### The agent problem

Agents are great at calling APIs, but terrible at:

* Creating accounts
* Managing credentials securely
* Navigating billing portals
* Predicting and controlling spend

### What x402 enables

* Agents can **discover payable services**
* Agents can **present explicit prices**
* Humans can **approve caps**
* Agents can **pay and proceed** without additional onboarding steps

### Discovery: Bazaar + manifests

* Bazaar is a discovery layer for payable services.
* Well-known endpoints and metadata make services machine-discoverable.

---

## 3.5 `/learn/vision`

**H1:** Vision: “Payment Required” as a first-class web primitive
**Subhead:** The web made information frictionless; payments remained a bolt-on. x402 aims to make payments as native as HTTP.

### What changes if this works

* Any service can be “paywallable” at the protocol layer
* Agents can autonomously buy compute/data/tools under policy
* “Procurement” becomes an API call, not a contract negotiation

### What AgentDB adds on top

x402 is the payment primitive. AgentDB adds:

* budgets/caps
* receipts
* logs
* leases for time-based costs
* SLAs for QoS

---

## 3.6 `/learn/safety-and-trust`

**H1:** Safety & trust: how to avoid “agents spending money” problems
**Sections:**

* Default caps + TTL everywhere
* Pre-approval flow (human in the loop)
* Receipts ledger and export
* Rate limits and anomaly detection
* Recovery playbooks (suspend, freeze, export, delete)

---

## 3.7 `/learn/glossary`

Terms:

* Table
* Lease
* Cap / Budget
* Receipt
* Audit log
* Ops log
* x402
* Facilitator
* SIWX
* Payment-Identifier
* Discovery / manifest

---

## 3.8 `/learn/faq`

Examples:

* “Do I need an account?” (No; wallet/capabilities)
* “Can I cap spend?” (Yes; hard caps)
* “What happens if I stop paying?” (Suspend → expire → delete)
* “Can agents create infinite tables?” (No; policy + caps + TTL)

---

# 4) Comparison page vs competition

This page is grounded in vendor pricing/auth docs to keep it factual, not vibes. ([Upstash: Serverless Data Platform][8])

## 4.1 `/compare` (single-page comparison)

**H1:** AgentDB vs common alternatives
**Lead:** Many products are excellent databases. This comparison focuses on one specific workflow: **an agent provisioning state safely without a human creating vendor accounts**.

### Quick matrix (copy)

| Capability                               | AgentDB | Upstash                                | Turso | Cloudflare KV | Firestore |
| ---------------------------------------- | ------- | -------------------------------------- | ----- | ------------- | --------- |
| No signup / no vendor billing setup      | ✅       | ❌                                      | ❌     | ❌             | ❌         |
| Standardized paywall protocol (HTTP 402) | ✅       | ❌                                      | ❌     | ❌             | ❌         |
| Human approval + hard spend cap          | ✅       | ⚠️ (budgeting exists, not agent-first) | ⚠️    | ⚠️            | ⚠️        |
| Receipts ledger (per-request line items) | ✅       | ⚠️                                     | ⚠️    | ⚠️            | ⚠️        |
| Agent-discoverable pricing endpoint      | ✅       | ❌                                      | ❌     | ❌             | ❌         |
| Default TTL / auto-expire for safety     | ✅       | ⚠️                                     | ⚠️    | ⚠️            | ⚠️        |

### “What others do well”

**Upstash**

* Very clear pay‑as‑you‑go model (e.g., $0.20 / 100K commands; bandwidth/storage line items). ([Upstash: Serverless Data Platform][8])
* Access patterns commonly use tokens/endpoints. ([Upstash: Serverless Data Platform][9])

**Turso**

* Pricing aligned to “monthly active databases” and read/write/storage line items. ([turso.tech][10])
* Platform API and auth tokens for programmatic management. ([docs.turso.tech][11])

**Cloudflare KV**

* Strong edge ecosystem; usage-based KV pricing and platform integration. ([cloudflare.com][12])
* Token-managed operational model. ([Cloudflare Docs][14])

**Firestore**

* Large ecosystem; free tier quotas, but billing must be enabled for more. ([Google Cloud][13])

### “What AgentDB is optimized for”

* **Agent procurement** as a primitive: Quote → Approve → Provision
* **Caps + TTL by default**
* **Protocol-level payment negotiation** (x402 / HTTP 402)
* **No keys copied from dashboards**
* **Receipts and logs first-class**

### CTA section

* “Install for Agents”
* “Read the approval flow”
* “Try quote API”

---

# 5) Console (human-facing) page copy + wireframes

## 5.1 `/console` Connect / Resume

**H1:** Open Console
**Subhead:** View tables, approvals, spend caps, receipts, and logs.

Buttons:

* **Connect Wallet**
* **Paste Workspace Key** (advanced)
* “What is x402?” link → `/learn/what-is-x402`

**Callout:** “Console access does not grant agents spending authority. Spending requires explicit approval caps.”

Wireframe:

```
┌─────────────── AgentDB Console ────────────────┐
│ [Connect Wallet]                               │
│ [Paste Workspace Key]                          │
│                                                │
│ Learn: What is x402?  How approvals work       │
└────────────────────────────────────────────────┘
```

---

## 5.2 `/console/overview`

Widgets:

* Balance (workspace)
* Spend today / last 7 days
* Active tables count
* Approvals pending
* Errors last 24h

Lists:

* “Top tables by cost (7d)”
* “Recently created tables”
* “Low balance warnings”

---

## 5.3 `/console/tables` Tables list

Table columns:

* Table Name
* Table ID
* Tier (Regional / Multi-region)
* Expiry
* Cap (daily / lifetime)
* Last activity
* Health

Actions:

* Extend TTL (requires approval/top-up)
* Delete
* Export receipts (CSV)

---

## 5.4 `/console/tables/{table_id}` Table details (tabs)

**Tab: Overview**

* Table endpoint
* Current balance allocated
* TTL and expiry
* Caps and limits
* p50/p95 latency (last 1h)
* Errors (last 1h/24h)

**Tab: Usage**

* Chart: units over time
* “Cost drivers” breakdown
* “Set alert thresholds”

**Tab: Receipts**

* Ledger list:

  * timestamp
  * op type
  * metered units
  * estimated cost
  * request ID

**Tab: Logs**

* Audit / Ops / Errors
* Filter by request ID

**Tab: Access**

* Rotate table secret / capability token
* Allowed origins / IP allowlist (optional)

**Tab: Settings**

* Update TTL
* Update caps
* Delete table

---

## 5.5 `/console/approvals` *(v1.1)*

Two panes:

* Pending approvals (needs action)
* History

Approval card contents:

* Requested by: “Local Agent Broker”
* Purpose string
* Proposed cap + TTL
* Estimated range
* Buttons: Approve & Fund / Deny / Edit cap / Shorten TTL

---

## 5.6 `/console/receipts`

Global receipts ledger:

* filters: table, date range, op type
* export CSV/JSON

---

## 5.7 `/console/logs`

Global logs explorer:

* filters: table, time range, severity, request ID

---

## 5.8 `/console/budgets`

Workspace-level policies:

* Default TTL for new tables
* Default max spend
* Auto-approve thresholds (for the broker)
* Rate limit defaults

---

# 6) Agent-facing docs (human-readable, agent-readable)

## 6.1 `/docs/quickstart/agents` (landing)

**H1:** Agent Quickstart
Choose:

* MCP (recommended)
* REST/OpenAPI

---

## 6.2 `/docs/quickstart/agents-mcp`

**Title:** Agent Quickstart (MCP)
**This page is intentionally agent-readable.**

### Canonical discovery order

1. `GET https://app.run402.com/.well-known/mcp.json`
2. `GET https://app.run402.com/x402/discovery`
3. Connect MCP transport at `https://app.run402.com/mcp`

### 402 retry rule

* If a call returns `402 Payment Required`, complete payment and retry **without changing arguments**.

### Tools you’ll use (example)

* `agentdb.quote_table`
* `agentdb.request_approval` *(v1.1)*
* `agentdb.create_table`
* `agentdb.put`
* `agentdb.get`
* `agentdb.query`
* `agentdb.logs`
* `agentdb.receipts`

---

## 6.3 `/docs/quickstart/agents-rest`

**Title:** Agent Quickstart (REST)

### Flow

1. Quote:

```bash
curl -sS https://app.run402.com/v1/tables:quote \
  -H 'content-type: application/json' \
  -d '{"ttl_days":7,"expected_ops_per_day":{"read":2000,"write":200},"max_spend_usd":3.00}'
```

2. Create table (will return 402; pay and retry):

```bash
curl -sS https://app.run402.com/v1/tables \
  -H 'content-type: application/json' \
  -d '{"table_name":"my-table","key_schema":[{"attribute_name":"id","key_type":"HASH"}],"ttl_days":7,"max_spend_usd":3.00}'
```

> *v1.1 will add an approval step here: `POST /v1/approvals` → human approves via URL → agent polls and then provisions.*

4. Create table (may return 402 if funding required)

* On 402: pay and retry with `PAYMENT-SIGNATURE` (x402)

---

## 6.4 `/docs/x402` (how AgentDB uses x402)

Sections:

* When AgentDB returns 402
* How to top up
* Idempotency requirements for writes
* SIWX vs capability tokens

---

# 7) Machine-facing endpoints: JSON Schemas + example instances

The shapes below intentionally mirror the **de facto** “agent gateway” patterns used in the ecosystem (e.g., `/.well-known/mcp.json`, `/x402/discovery`, `/meta.json`, `/llms.txt`). ([agent402][15])

## 7.1 `/.well-known/mcp.json`

### JSON Schema: `McpServerCard.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://app.run402.com/schemas/McpServerCard.schema.json",
  "title": "MCP Server Card",
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "description", "url", "transport", "version", "tools", "payment"],
  "properties": {
    "name": { "type": "string", "minLength": 1 },
    "description": { "type": "string", "minLength": 1 },
    "url": { "type": "string", "format": "uri" },
    "transport": {
      "type": "string",
      "enum": ["streamable-http", "stdio", "sse", "websocket"]
    },
    "version": { "type": "string", "minLength": 1 },
    "tools": {
      "type": "array",
      "minItems": 0,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "description"],
        "properties": {
          "name": { "type": "string", "pattern": "^[a-zA-Z0-9._-]+$" },
          "description": { "type": "string" },
          "tags": {
            "type": "array",
            "items": { "type": "string" }
          }
        }
      }
    },
    "payment": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocol", "network", "asset", "payTo"],
      "properties": {
        "protocol": { "type": "string", "const": "x402" },
        "network": { "type": "string", "minLength": 1 },
        "asset": { "type": "string", "minLength": 1 },
        "payTo": { "type": "string", "minLength": 1 },
        "schemes": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Optional list of supported x402 payment schemes (e.g., exact, credit)."
        }
      }
    }
  }
}
```

### Example instance: `/.well-known/mcp.json`

```json
{
  "name": "agentdb-mcp",
  "description": "AgentDB MCP: create and use durable tables with x402 billing and human approvals.",
  "url": "https://app.run402.com/mcp",
  "transport": "streamable-http",
  "version": "0.2.0",
  "tools": [
    { "name": "agentdb.quote_table", "description": "Estimate cost range and propose a max spend cap." },
    { "name": "agentdb.request_approval", "description": "Create a human approval request for a table." },
    { "name": "agentdb.create_table", "description": "Provision a table after approval/funding." },
    { "name": "agentdb.put", "description": "Put an item by key." },
    { "name": "agentdb.get", "description": "Get an item by key." },
    { "name": "agentdb.query", "description": "Query items by partition key (and sort key conditions, if enabled)." },
    { "name": "agentdb.receipts", "description": "Fetch receipts (line items) for cost visibility." },
    { "name": "agentdb.logs", "description": "Fetch audit/ops/error logs for debugging and governance." }
  ],
  "payment": {
    "protocol": "x402",
    "network": "eip155:8453",
    "asset": "USDC",
    "payTo": "0x0000000000000000000000000000000000000000",
    "schemes": ["exact", "credit"]
  }
}
```

---

## 7.2 `/x402/discovery`

### JSON Schema: `X402Discovery.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://app.run402.com/schemas/X402Discovery.schema.json",
  "title": "x402 Discovery (Tool Catalog)",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "server", "policy", "tools"],
  "properties": {
    "version": { "type": "string", "minLength": 1 },
    "server": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "description", "url"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "url": { "type": "string", "format": "uri" }
      }
    },
    "policy": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "billingMode": { "type": "string" },
        "byokSupported": { "type": "boolean" },
        "networkPolicy": { "type": "object", "additionalProperties": true }
      }
    },
    "tools": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "description", "network", "payTo", "inputSchema", "outputSchema"],
        "properties": {
          "name": { "type": "string", "pattern": "^[a-zA-Z0-9._-]+$" },
          "description": { "type": "string" },

          "price": {
            "type": "string",
            "description": "Human-readable starting price (e.g., '$0.002') or 'dynamic'."
          },
          "priceModel": {
            "type": "object",
            "description": "Optional structured price model for non-flat pricing.",
            "additionalProperties": true
          },

          "network": { "type": "string" },
          "payTo": { "type": "string" },

          "billingMode": { "type": "string" },
          "byokRequired": { "type": "boolean" },
          "testnetAccess": { "type": "string" },

          "inputSchema": {
            "type": "object",
            "description": "JSON Schema for tool input.",
            "additionalProperties": true
          },
          "outputSchema": {
            "type": "object",
            "description": "JSON Schema for tool output.",
            "additionalProperties": true
          }
        }
      }
    }
  }
}
```

### Example instance: `/x402/discovery`

```json
{
  "version": "2",
  "server": {
    "name": "agentdb-mcp",
    "description": "Pay-per-use durable tables for agents with approvals, caps, receipts, and logs.",
    "url": "https://app.run402.com/mcp"
  },
  "policy": {
    "billingMode": "lease_and_usage",
    "byokSupported": false,
    "networkPolicy": { "default": "mainnet_only" }
  },
  "tools": [
    {
      "name": "agentdb.quote_table",
      "description": "Estimate cost range and propose a max spend cap.",
      "price": "free",
      "network": "eip155:8453",
      "payTo": "0x0000000000000000000000000000000000000000",
      "billingMode": "n/a",
      "byokRequired": false,
      "testnetAccess": "open",
      "inputSchema": {
        "type": "object",
        "properties": {
          "ttl_days": { "type": "integer", "minimum": 1, "maximum": 365 },
          "expected_ops_per_day": {
            "type": "object",
            "properties": {
              "read": { "type": "integer", "minimum": 0 },
              "write": { "type": "integer", "minimum": 0 }
            },
            "required": ["read", "write"]
          },
          "max_spend_usd": { "type": "number", "minimum": 0 }
        },
        "required": ["ttl_days", "expected_ops_per_day", "max_spend_usd"]
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "quote_id": { "type": "string" },
          "estimated_cost_range_usd": {
            "type": "object",
            "properties": {
              "low": { "type": "number" },
              "high": { "type": "number" }
            },
            "required": ["low", "high"]
          },
          "recommended_deposit_usd": { "type": "number" }
        },
        "required": ["quote_id", "estimated_cost_range_usd", "recommended_deposit_usd"]
      }
    },
    {
      "name": "agentdb.create_table",
      "description": "Provision a table after approval/funding.",
      "price": "dynamic",
      "priceModel": {
        "type": "lease_deposit_plus_usage",
        "depositMinimumUsd": 1.0,
        "usage": {
          "readUnitUsd": 0.0000005,
          "writeUnitUsd": 0.000002,
          "storageGbDayUsd": 0.02
        }
      },
      "network": "eip155:8453",
      "payTo": "0x0000000000000000000000000000000000000000",
      "billingMode": "lease_and_usage",
      "byokRequired": false,
      "testnetAccess": "allowlisted_project_wallets_only",
      "inputSchema": {
        "type": "object",
        "properties": {
          "approval_id": { "type": "string" },
          "table_name": { "type": "string", "minLength": 1 },
          "key_schema": {
            "type": "object",
            "properties": {
              "partitionKey": { "type": "string", "minLength": 1 },
              "sortKey": { "type": "string", "minLength": 1 }
            },
            "required": ["partitionKey"]
          }
        },
        "required": ["approval_id", "table_name", "key_schema"]
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "table_id": { "type": "string" },
          "endpoint": { "type": "string", "format": "uri" },
          "expires_at": { "type": "string" }
        },
        "required": ["table_id", "endpoint", "expires_at"]
      }
    }
  ]
}
```

---

## 7.3 `/meta.json`

### JSON Schema: `Meta.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://app.run402.com/schemas/Meta.schema.json",
  "title": "Machine-friendly Site Metadata",
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "description", "endpoints", "endpointDetails", "tools", "robots"],
  "properties": {
    "name": { "type": "string" },
    "description": { "type": "string" },
    "endpoints": {
      "type": "object",
      "additionalProperties": { "type": "string", "format": "uri" }
    },
    "endpointDetails": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["path", "methods", "url", "role"],
        "properties": {
          "path": { "type": "string" },
          "methods": { "type": "string" },
          "url": { "type": "string", "format": "uri" },
          "role": { "type": "string" }
        }
      }
    },
    "tools": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "description"],
        "properties": {
          "name": { "type": "string" },
          "description": { "type": "string" },
          "price": { "type": "string" }
        }
      }
    },
    "robots": {
      "type": "object",
      "additionalProperties": false,
      "required": ["llms", "robotsTxt"],
      "properties": {
        "llms": { "type": "string", "format": "uri" },
        "robotsTxt": { "type": "string", "format": "uri" }
      }
    }
  }
}
```

### Example instance: `/meta.json`

```json
{
  "name": "agentdb-mcp",
  "description": "AgentDB: durable tables for agents with x402 billing, approvals, caps, receipts, and logs.",
  "endpoints": {
    "homepage": "https://run402.com/",
    "console": "https://app.run402.com/",
    "mcp": "https://app.run402.com/mcp",
    "mcpCard": "https://app.run402.com/.well-known/mcp.json",
    "x402Discovery": "https://app.run402.com/x402/discovery",
    "x402Manifest": "https://app.run402.com/.well-known/x402",
    "openapi": "https://app.run402.com/openapi.json",
    "meta": "https://app.run402.com/meta.json",
    "llms": "https://app.run402.com/llms.txt",
    "robotsTxt": "https://app.run402.com/robots.txt",
    "sitemap": "https://run402.com/sitemap.xml",
    "health": "https://app.run402.com/health"
  },
  "endpointDetails": [
    {
      "path": "/mcp",
      "methods": "POST, GET, DELETE",
      "url": "https://app.run402.com/mcp",
      "role": "Primary Streamable HTTP MCP transport."
    },
    {
      "path": "/.well-known/mcp.json",
      "methods": "GET",
      "url": "https://app.run402.com/.well-known/mcp.json",
      "role": "Canonical MCP server card for discovery."
    },
    {
      "path": "/x402/discovery",
      "methods": "GET",
      "url": "https://app.run402.com/x402/discovery",
      "role": "Tool list, schemas, and pricing."
    },
    {
      "path": "/.well-known/x402",
      "methods": "GET",
      "url": "https://app.run402.com/.well-known/x402",
      "role": "x402 manifest for discovery tooling and DNS-based discovery."
    }
  ],
  "tools": [
    { "name": "agentdb.quote_table", "description": "Estimate costs and propose caps.", "price": "free" },
    { "name": "agentdb.create_table", "description": "Provision a table after approval.", "price": "dynamic" }
  ],
  "robots": {
    "llms": "https://app.run402.com/llms.txt",
    "robotsTxt": "https://app.run402.com/robots.txt"
  }
}
```

---

## 7.4 `/llms.txt` template

This is not standardized, but the ecosystem pattern is: a concise outline of canonical discovery endpoints + docs entry points (see agent402). ([agent402][16])

**Example `llms.txt`:**

```txt
# AgentDB — accountless cloud tables for AI agents with x402 billing.

## Canonical Discovery
- MCP card: https://app.run402.com/.well-known/mcp.json
- MCP transport: https://app.run402.com/mcp
- x402 discovery: https://app.run402.com/x402/discovery
- x402 manifest: https://app.run402.com/.well-known/x402
- OpenAPI: https://app.run402.com/openapi.json
- Meta: https://app.run402.com/meta.json

## Agent Quickstarts
- MCP quickstart: https://run402.com/docs/quickstart/agents-mcp
- REST quickstart: https://run402.com/docs/quickstart/agents-rest

## Human Docs
- Overview: https://run402.com/product
- Pricing: https://run402.com/pricing
- Learn x402: https://run402.com/learn/what-is-x402
- Compare: https://run402.com/compare

## Console
- Console: https://app.run402.com/

## Health
- API health: https://app.run402.com/health
- Status: https://status.run402.com/
```

---

## 7.5 `/.well-known/x402` manifest (discovery manifest)

This is the manifest URL pattern referenced by the DNS discovery draft (operators may host at `/.well-known/x402`), with JSON format required for manifests. ([IETF Datatracker][1])
The draft doesn’t prescribe a concrete field schema; so you should publish a **stable, versioned manifest**.

### JSON Schema: `X402Manifest.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://app.run402.com/schemas/X402Manifest.schema.json",
  "title": "x402 Discovery Manifest",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "service", "x402", "resources", "links"],
  "properties": {
    "version": {
      "type": "string",
      "description": "Manifest schema version.",
      "pattern": "^x402-manifest\\/\\d+$"
    },
    "service": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "description"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" }
      }
    },
    "x402": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocolVersion", "schemes", "networks", "assets"],
      "properties": {
        "protocolVersion": { "type": "string", "description": "e.g., '2'" },
        "schemes": { "type": "array", "items": { "type": "string" } },
        "networks": { "type": "array", "items": { "type": "string" } },
        "assets": { "type": "array", "items": { "type": "string" } },
        "facilitator": {
          "type": "object",
          "additionalProperties": false,
          "required": ["verifyUrl", "settleUrl"],
          "properties": {
            "verifyUrl": { "type": "string", "format": "uri" },
            "settleUrl": { "type": "string", "format": "uri" }
          }
        }
      }
    },
    "resources": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["path", "methods", "description", "payment"],
        "properties": {
          "path": { "type": "string" },
          "methods": {
            "type": "array",
            "items": { "type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"] }
          },
          "description": { "type": "string" },
          "payment": {
            "type": "object",
            "additionalProperties": false,
            "required": ["mode"],
            "properties": {
              "mode": {
                "type": "string",
                "enum": ["none", "exact", "dynamic", "quote_then_pay", "lease_and_usage"]
              },
              "priceHint": { "type": "string" },
              "currency": { "type": "string", "default": "USD" }
            }
          }
        }
      }
    },
    "links": {
      "type": "object",
      "additionalProperties": false,
      "required": ["x402Discovery", "mcpCard", "mcp", "openapi", "meta", "llms"],
      "properties": {
        "x402Discovery": { "type": "string", "format": "uri" },
        "mcpCard": { "type": "string", "format": "uri" },
        "mcp": { "type": "string", "format": "uri" },
        "openapi": { "type": "string", "format": "uri" },
        "meta": { "type": "string", "format": "uri" },
        "llms": { "type": "string", "format": "uri" }
      }
    }
  }
}
```

### Example instance: `/.well-known/x402`

```json
{
  "version": "x402-manifest/1",
  "service": {
    "name": "AgentDB API",
    "description": "Accountless durable tables for agents with x402 billing and human approvals."
  },
  "x402": {
    "protocolVersion": "2",
    "schemes": ["exact", "credit"],
    "networks": ["eip155:8453"],
    "assets": ["USDC"],
    "facilitator": {
      "verifyUrl": "https://facilitator.example/verify",
      "settleUrl": "https://facilitator.example/settle"
    }
  },
  "resources": [
    {
      "path": "/v1/tables:quote",
      "methods": ["POST"],
      "description": "Return cost estimate range and recommended deposit.",
      "payment": { "mode": "none" }
    },
    {
      "path": "/v1/approvals",
      "methods": ["POST"],
      "description": "Create human approval request (may require payment depending on policy).",
      "payment": { "mode": "dynamic", "priceHint": "Typically free" }
    },
    {
      "path": "/v1/tables",
      "methods": ["POST"],
      "description": "Create table after approval; funds lease and provisions table.",
      "payment": { "mode": "lease_and_usage", "priceHint": "Deposit + usage", "currency": "USD" }
    }
  ],
  "links": {
    "x402Discovery": "https://app.run402.com/x402/discovery",
    "mcpCard": "https://app.run402.com/.well-known/mcp.json",
    "mcp": "https://app.run402.com/mcp",
    "openapi": "https://app.run402.com/openapi.json",
    "meta": "https://app.run402.com/meta.json",
    "llms": "https://app.run402.com/llms.txt"
  }
}
```

---

# 8) Optional: DNS discovery note (for your Learning + Docs)

If you want to support DNS-based discovery, add a “For operators” note in docs and publish:

```
_x402.app.run402.com TXT "v=x4021;descriptor=api;url=https://app.run402.com/.well-known/x402"
```

The DNS discovery draft describes `_x402` TXT records pointing to an HTTPS manifest URL (often `/.well-known/x402`) and emphasizes TLS validation requirements. ([IETF Datatracker][1])

---

# 9) What I would implement first (so the website matches reality)

To avoid a “pretty website / missing product” mismatch, the minimum implementation that makes every page honest:

1. `/v1/tables:quote` returns real estimates
2. `/v1/approvals` + approval URL page
3. `/v1/tables` create + TTL + caps
4. Receipts ledger endpoint
5. Logs endpoint (audit + ops at least)
6. `/.well-known/mcp.json`, `/x402/discovery`, `/meta.json`, `/llms.txt`
7. Console pages: Tables, Approvals, Receipts, Logs

---

If you want, I can also generate:

* a **full OpenAPI 3.1 spec** for the REST surface (quote/approval/table CRUD/receipts/logs),
* a matching **MCP tool schema** set (tools/list + tools/call payloads),
* and a **pixel-level component spec** (design tokens, layout, and concrete UI states for approval flows and low-balance top-ups).

[1]: https://datatracker.ietf.org/doc/draft-jeftovic-x402-dns-discovery/ "
            
    
        draft-jeftovic-x402-dns-discovery-00 - Discovering x402 Resources via DNS TXT Records
    

        "
[2]: https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works?utm_source=chatgpt.com "How x402 Works - Coinbase Developer Documentation"
[3]: https://docs.x402.org/?utm_source=chatgpt.com "Welcome to x402 - x402"
[4]: https://www.x402.org/writing/x402-v2-launch?utm_source=chatgpt.com "Introducing x402 V2: Evolving the Standard for Internet- ..."
[5]: https://docs.x402.org/extensions/sign-in-with-x?utm_source=chatgpt.com "Sign-In-With-X (SIWX)"
[6]: https://docs.x402.org/extensions/payment-identifier?utm_source=chatgpt.com "Payment-Identifier (Idempotency)"
[7]: https://docs.cdp.coinbase.com/x402/bazaar?utm_source=chatgpt.com "x402 Bazaar (Discovery Layer)"
[8]: https://upstash.com/docs/redis/overall/pricing?utm_source=chatgpt.com "Pricing & Limits - Upstash Documentation"
[9]: https://upstash.com/docs/redis/features/restapi?utm_source=chatgpt.com "REST API - Upstash Documentation"
[10]: https://turso.tech/pricing?utm_source=chatgpt.com "Turso Database Pricing"
[11]: https://docs.turso.tech/api-reference/authentication?utm_source=chatgpt.com "Authentication"
[12]: https://www.cloudflare.com/plans/developer-platform-pricing/?utm_source=chatgpt.com "Workers & Pages Pricing"
[13]: https://cloud.google.com/firestore/pricing?utm_source=chatgpt.com "Firestore pricing"
[14]: https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/?utm_source=chatgpt.com "Account API tokens · Cloudflare Fundamentals docs"
[15]: https://agent402.dev/.well-known/mcp.json "agent402.dev"
[16]: https://agent402.dev/llms.txt "agent402.dev"
