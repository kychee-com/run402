# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-09T14:15:46.971915
**Completed**: 2026-03-09T14:51:21.749419
**Status**: completed

---

Short version:

- **Use “fork” as the canonical term.**
- In the UI, soften it with **“Create your own live copy”** so non-jargony users still get it.
- Make the overlay a **bottom-right floating HUD card** that **minimizes into a small pill**.
- Include rewards info only as a **muted footer line**, not as the headline.
- Use a **one-click “Copy agent prompt”** with a small editable subdomain field.

## 1. “Clone” vs “fork”
I’d use:

- **Badge / label:** `Forkable on Run402`
- **Human explanation:** `Create your own live copy`
- **Agent prompt verb:** `fork`

Why:

- **Fork** matches your platform semantics:
  - immutable published version
  - lineage
  - publisher rewards
- **Clone** sounds like:
  - local code copy
  - source checkout
  - no attribution/revenue lineage

If you want softer public-facing language later, **“Remix”** is better than “Clone” — but I would still keep the core platform term as **fork**.

---

## 2. Recommended interaction model

### Expanded state
A glassy dark card:

- small mono kicker: `FORKABLE ON RUN402`
- title: `Create your own live copy`
- subdomain field: `[krello-copy] .run402.com`
- code box with one-liner agent prompt
- primary CTA: `Copy agent prompt`
- muted footer: `Fork is free · supports the original publisher (20% hosting share).`

### Minimized state
A small pill:

- green dot
- `Forkable`
- `Run402` accent text

This should feel like a **system status chip**, not an ad.

### Dismiss / minimize
For v1, I’d make **dismiss = minimize**.
Don’t fully hide it by default. If you later add “don’t show again,” put it in a small overflow/settings menu.

---

## 3. Position
**Default: bottom-right.**

Why:
- least likely to collide with nav bars / hero copy
- familiar pattern from chat widgets / dev HUDs
- easy to ignore while using the app

### Mobile
Keep it bottom-aligned, but let the card become a **compact bottom sheet** with side margins.

### Escape hatch
If an app already uses a bottom-right FAB, allow a server-side override to **bottom-left**.

---

## 4. Animations that feel high-tech but not annoying
Use only subtle motion:

- **one-time scanline sweep** on mount
- **fast fade/slide** on open/close
- **hover glow**
- **copy success state** on the button
- **gentle pulse only on the minimized pill dot**

Avoid:
- constant looping gradients
- noisy scanlines
- perpetual floating/bobbing
- anything center-screen

Also support `prefers-reduced-motion`.

---

## 5. Should it include publisher rewards?
**Yes, but only as secondary copy.**

Good:
- signals ecosystem alignment
- makes forking feel positive, not extractive

Bad:
- if it becomes the headline, it feels like monetization UI instead of product UI

Best phrasing:
- `Fork is free · supports the original publisher (20% hosting share).`

That’s better than:
- `This app earns its creator 20% of hosting revenue`

because it feels less ad-like.

---

## 6. Copy-to-clipboard UX
Best practice here:

- copy a **plain-English one-liner**, not JSON
- use **full URLs**
- let the user edit the target subdomain before copying
- on success:
  - button changes to `Copied`
- fallback:
  - auto-select the text
  - button changes to `Press Ctrl/Cmd+C`

Recommended prompt shape:

```txt
Read https://run402.com/llms.txt, then fork the published app at https://krello.run402.com into https://krello-copy.run402.com on Run402.
```

That phrase **“published app at …”** helps disambiguate this from repo cloning.

---

## 7. Self-contained injectable snippet
This version is built for injection into arbitrary user apps:

- uses **Shadow DOM**
- styles are isolated
- stores minimize state in `localStorage`
- non-blocking overlay
- matches Run402 colors/type
- supports `bottom-right` and `bottom-left`

```html
<script>
/*
  Optional per-app config. Replace/populate this object from your edge injector.
  If omitted, the snippet derives sane defaults from the current hostname.
*/
window.__RUN402_FORK_BADGE__ = {
  forkable: true,
  appName: "krello",
  appUrl: "https://krello.run402.com",
  rootDomain: "run402.com",
  llmsUrl: "https://run402.com/llms.txt",
  position: "bottom-right", // or "bottom-left"
  defaultTarget: "krello-copy",
  promptVerb: "fork", // recommended; can be "clone" for experiments
  showRewards: true,
  rewardsText: "Supports the original publisher (20% hosting share).",
  title: "Create your own live copy",
  bodyText: "Paste this into your coding agent.",
  initialMinimized: false
};

(() => {
  if (window.__RUN402_FORK_BADGE_MOUNTED__) return;
  window.__RUN402_FORK_BADGE_MOUNTED__ = true;

  const injected = window.__RUN402_FORK_BADGE__ || {};
  const hostname = String(injected.appHost || window.location.hostname);
  const appName = String(injected.appName || hostname.split(".")[0] || "app").toLowerCase();
  const appUrl = String(
    injected.appUrl || window.location.origin || `${window.location.protocol}//${window.location.host}`
  );
  const rootDomain = String(injected.rootDomain || "run402.com");
  const llmsUrl = String(injected.llmsUrl || "https://run402.com/llms.txt");

  const cfg = {
    forkable: injected.forkable !== false,
    position: injected.position === "bottom-left" ? "bottom-left" : "bottom-right",
    defaultTarget: String(injected.defaultTarget || `${appName}-copy`),
    promptVerb: String(injected.promptVerb || "fork").toLowerCase(),
    title: String(injected.title || "Create your own live copy"),
    bodyText: String(injected.bodyText || "Paste this into your coding agent."),
    showRewards: injected.showRewards !== false,
    rewardsText: String(injected.rewardsText || "Supports the original publisher (20% hosting share)."),
    storageKey: String(injected.storageKey || `run402:fork-badge:${hostname}`),
    initialMinimized: injected.initialMinimized === true
  };

  if (!cfg.forkable) return;

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const rootDomainPattern = new RegExp(`(?:\\.)?${escapeRegExp(rootDomain)}$`, "i");

  function sanitizeSubdomain(value, fallback) {
    let out = String(value || "").toLowerCase().trim();
    out = out.replace(/^https?:\/\//, "");
    out = out.replace(/\/.*$/, "");
    out = out.replace(rootDomainPattern, "");
    out = out.replace(/\.$/, "");
    out = out.replace(/[^a-z0-9-]/g, "-");
    out = out.replace(/--+/g, "-");
    out = out.replace(/^-+|-+$/g, "");
    out = out.slice(0, 63).replace(/^-+|-+$/g, "");
    return out || fallback;
  }

  function loadState() {
    try {
      const raw = window.localStorage.getItem(cfg.storageKey);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveState(state) {
    try {
      window.localStorage.setItem(cfg.storageKey, JSON.stringify(state));
    } catch {
      // ignore storage failures
    }
  }

  const fallbackName = sanitizeSubdomain(`${appName}-copy`, "app-copy");
  const safeDefaultTarget = sanitizeSubdomain(cfg.defaultTarget, fallbackName);
  const state = Object.assign({ minimized: cfg.initialMinimized }, loadState());

  const host = document.createElement("div");
  host.id = "run402-fork-badge-host";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.pointerEvents = "none";
  host.style.zIndex = "2147483646";
  host.style.isolation = "isolate";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const sideClass = cfg.position === "bottom-left" ? "r402-left" : "r402-right";
  const panelClass = state.minimized ? "r402-panel" : "r402-panel r402-entering";

  shadow.innerHTML = `
    <style>
      :host { color-scheme: dark; }
      *, *::before, *::after { box-sizing: border-box; }

      .r402-anchor {
        position: fixed;
        bottom: max(16px, env(safe-area-inset-bottom));
        pointer-events: none;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #E5E7EB;
      }
      .r402-right { right: max(16px, env(safe-area-inset-right)); }
      .r402-left { left: max(16px, env(safe-area-inset-left)); }

      .r402-panel,
      .r402-pill {
        position: absolute;
        bottom: 0;
        visibility: hidden;
        opacity: 0;
        transform: translateY(8px) scale(0.985);
        pointer-events: none;
        transition:
          opacity 180ms ease,
          transform 180ms ease,
          box-shadow 180ms ease,
          border-color 180ms ease,
          visibility 0s linear 180ms;
        will-change: transform, opacity;
      }

      .r402-right .r402-panel,
      .r402-right .r402-pill { right: 0; }

      .r402-left .r402-panel,
      .r402-left .r402-pill { left: 0; }

      .r402-anchor[data-state="expanded"] .r402-panel {
        visibility: visible;
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
        transition-delay: 0s;
      }

      .r402-anchor[data-state="minimized"] .r402-pill {
        visibility: visible;
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
        transition-delay: 0s;
      }

      .r402-panel {
        width: min(380px, calc(100vw - 24px));
        overflow: hidden;
        border-radius: 16px;
        border: 1px solid rgba(0, 255, 159, 0.18);
        background:
          radial-gradient(circle at top right, rgba(0, 255, 159, 0.08), transparent 34%),
          linear-gradient(180deg, rgba(18, 18, 26, 0.94), rgba(10, 10, 15, 0.96));
        box-shadow:
          0 18px 50px rgba(0, 0, 0, 0.45),
          0 0 0 1px rgba(255, 255, 255, 0.02) inset,
          0 0 24px rgba(0, 255, 159, 0.07);
        backdrop-filter: blur(18px) saturate(140%);
        -webkit-backdrop-filter: blur(18px) saturate(140%);
        transform-origin: bottom right;
      }

      .r402-left .r402-panel { transform-origin: bottom left; }

      .r402-panel.r402-entering {
        animation: r402-enter 240ms cubic-bezier(.2, .8, .2, 1);
      }

      .r402-panel::after {
        content: "";
        position: absolute;
        top: 0;
        left: -35%;
        width: 35%;
        height: 2px;
        background: linear-gradient(90deg, transparent, rgba(0, 255, 159, 0.9), transparent);
        opacity: 0;
        animation: r402-scan 1400ms ease-out 120ms 1 both;
        pointer-events: none;
      }

      .r402-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      }

      .r402-kicker {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #00FF9F;
      }

      .r402-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 999px;
        background: #00FF9F;
      }

      .r402-kicker .r402-dot {
        box-shadow: 0 0 0 4px rgba(0, 255, 159, 0.10);
      }

      .r402-pill .r402-dot {
        box-shadow: 0 0 0 0 rgba(0, 255, 159, 0.35);
        animation: r402-pulse 3.2s ease-in-out infinite;
      }

      .r402-icon {
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
        color: #9CA3AF;
        width: 30px;
        height: 30px;
        border-radius: 9px;
        cursor: pointer;
        font: 700 18px/1 "JetBrains Mono", ui-monospace, monospace;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }

      .r402-icon:hover {
        border-color: rgba(0, 255, 159, 0.22);
        background: rgba(0, 255, 159, 0.08);
        color: #E5E7EB;
        transform: translateY(-1px);
      }

      .r402-body {
        padding: 14px 16px 0;
      }

      .r402-title {
        margin: 0 0 6px;
        font-size: 16px;
        line-height: 1.3;
        font-weight: 700;
        color: #F3F4F6;
      }

      .r402-text {
        margin: 0 0 14px;
        font-size: 13px;
        line-height: 1.5;
        color: #9CA3AF;
      }

      .r402-label {
        display: block;
        margin: 0 0 8px;
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #6B7280;
      }

      .r402-inputShell {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 42px;
        padding: 0 12px;
        margin-bottom: 12px;
        border-radius: 12px;
        border: 1px solid rgba(0, 255, 159, 0.14);
        background: #101018;
      }

      .r402-inputShell:focus-within {
        border-color: rgba(0, 255, 159, 0.34);
        box-shadow: 0 0 0 3px rgba(0, 255, 159, 0.08);
      }

      .r402-input {
        flex: 1 1 auto;
        min-width: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: #E5E7EB;
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
        font-weight: 600;
        caret-color: #00FF9F;
      }

      .r402-input::placeholder { color: #4B5563; }

      .r402-suffix {
        flex: 0 0 auto;
        color: #6B7280;
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        font-weight: 600;
      }

      .r402-codeShell {
        overflow: hidden;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.06);
        background: #0F1016;
      }

      .r402-codeHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #6B7280;
      }

      .r402-inlineLink {
        color: #00FF9F;
        text-decoration: none;
      }

      .r402-inlineLink:hover { text-decoration: underline; }

      .r402-prompt {
        display: block;
        width: 100%;
        min-height: 88px;
        padding: 12px 14px 14px;
        margin: 0;
        border: 0;
        outline: 0;
        resize: none;
        background: linear-gradient(180deg, rgba(26, 26, 36, 0.94), rgba(13, 13, 19, 0.98));
        color: #FBBF24;
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        line-height: 1.55;
        cursor: text;
      }

      .r402-actions {
        padding: 14px 16px 12px;
      }

      .r402-copy {
        appearance: none;
        width: 100%;
        height: 44px;
        border-radius: 12px;
        border: 1px solid rgba(0, 255, 159, 0.32);
        background: linear-gradient(180deg, rgba(0, 255, 159, 0.14), rgba(0, 255, 159, 0.08));
        color: #00FF9F;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }

      .r402-copy:hover {
        border-color: rgba(0, 255, 159, 0.46);
        box-shadow: 0 10px 24px rgba(0, 255, 159, 0.08);
        transform: translateY(-1px);
      }

      .r402-copy[data-state="success"] {
        border-color: transparent;
        background: linear-gradient(180deg, rgba(0, 255, 159, 0.95), rgba(0, 255, 159, 0.8));
        color: #04110B;
      }

      .r402-copy[data-state="fallback"] {
        border-color: rgba(251, 191, 36, 0.28);
        background: linear-gradient(180deg, rgba(251, 191, 36, 0.12), rgba(251, 191, 36, 0.08));
        color: #FBBF24;
      }

      .r402-meta {
        padding: 0 16px 16px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        font-size: 12px;
        line-height: 1.5;
        color: #6B7280;
      }

      .r402-sep { color: #4B5563; }

      .r402-pill {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        height: 40px;
        max-width: calc(100vw - 24px);
        padding: 0 14px;
        border-radius: 999px;
        border: 1px solid rgba(0, 255, 159, 0.22);
        background: rgba(10, 10, 15, 0.92);
        color: #E5E7EB;
        backdrop-filter: blur(14px) saturate(140%);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        box-shadow:
          0 10px 28px rgba(0, 0, 0, 0.38),
          0 0 0 1px rgba(255, 255, 255, 0.02) inset,
          0 0 20px rgba(0, 255, 159, 0.07);
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        cursor: pointer;
      }

      .r402-pill:hover {
        border-color: rgba(0, 255, 159, 0.42);
        box-shadow:
          0 12px 32px rgba(0, 0, 0, 0.42),
          0 0 0 1px rgba(255, 255, 255, 0.02) inset,
          0 0 26px rgba(0, 255, 159, 0.12);
        transform: translateY(-1px);
      }

      .r402-pillBrand { color: #00FF9F; }

      .r402-live {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      .r402-input::selection,
      .r402-prompt::selection {
        background: rgba(0, 255, 159, 0.22);
        color: #FFFFFF;
      }

      .r402-icon:focus-visible,
      .r402-copy:focus-visible,
      .r402-pill:focus-visible,
      .r402-inlineLink:focus-visible,
      .r402-prompt:focus-visible {
        outline: 2px solid rgba(0, 255, 159, 0.42);
        outline-offset: 2px;
      }

      @keyframes r402-enter {
        from { opacity: 0; transform: translateY(10px) scale(0.985); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes r402-scan {
        0%   { opacity: 0; transform: translateX(0); }
        20%  { opacity: 1; }
        100% { opacity: 0; transform: translateX(420%); }
      }

      @keyframes r402-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(0, 255, 159, 0.34); }
        50%      { box-shadow: 0 0 0 6px rgba(0, 255, 159, 0); }
      }

      @media (max-width: 640px) {
        .r402-anchor {
          left: max(12px, env(safe-area-inset-left));
          right: max(12px, env(safe-area-inset-right));
          bottom: max(12px, env(safe-area-inset-bottom));
        }

        .r402-panel {
          left: 0 !important;
          right: 0 !important;
          width: auto;
          transform-origin: bottom center;
        }

        .r402-pill {
          right: 0 !important;
          left: auto !important;
        }
      }

      @media (max-width: 420px) {
        .r402-pillBrand { display: none; }
      }

      @media (prefers-reduced-motion: reduce) {
        .r402-panel,
        .r402-pill,
        .r402-copy,
        .r402-icon {
          transition: none !important;
          animation: none !important;
        }

        .r402-panel::after,
        .r402-pill .r402-dot {
          animation: none !important;
        }
      }
    </style>

    <div class="r402-anchor ${sideClass}" data-state="${state.minimized ? "minimized" : "expanded"}">
      <button class="r402-pill" id="r402-open" type="button" aria-label="Show Run402 fork prompt">
        <span class="r402-dot" aria-hidden="true"></span>
        <span>Forkable <span class="r402-pillBrand">Run402</span></span>
      </button>

      <section class="${panelClass}" id="r402-panel" aria-label="Fork this app on Run402">
        <div class="r402-header">
          <div class="r402-kicker">
            <span class="r402-dot" aria-hidden="true"></span>
            <span>Forkable on Run402</span>
          </div>
          <button class="r402-icon" id="r402-minimize" type="button" aria-label="Minimize Run402 fork prompt">–</button>
        </div>

        <div class="r402-body">
          <h2 class="r402-title" id="r402-title"></h2>
          <p class="r402-text" id="r402-text"></p>

          <label class="r402-label" for="r402-target">New subdomain</label>
          <div class="r402-inputShell">
            <input
              id="r402-target"
              class="r402-input"
              type="text"
              inputmode="url"
              spellcheck="false"
              autocomplete="off"
              autocapitalize="off"
              placeholder="${safeDefaultTarget}"
            />
            <span class="r402-suffix">.${rootDomain}</span>
          </div>

          <div class="r402-codeShell">
            <div class="r402-codeHeader">
              <span>Agent prompt</span>
              <a class="r402-inlineLink" id="r402-docs" href="${llmsUrl}" target="_blank" rel="noopener">llms.txt</a>
            </div>
            <textarea id="r402-prompt" class="r402-prompt" readonly rows="3"></textarea>
          </div>
        </div>

        <div class="r402-actions">
          <button class="r402-copy" id="r402-copy" type="button" data-state="idle">Copy agent prompt</button>
        </div>

        <div class="r402-meta" id="r402-meta">
          <span>Fork is free; normal hosting applies.</span>
          <span class="r402-sep" id="r402-sep">·</span>
          <span id="r402-rewards"></span>
        </div>

        <div class="r402-live" id="r402-live" aria-live="polite" aria-atomic="true"></div>
      </section>
    </div>
  `;

  const anchor = shadow.querySelector(".r402-anchor");
  const panel = shadow.getElementById("r402-panel");
  const openBtn = shadow.getElementById("r402-open");
  const minimizeBtn = shadow.getElementById("r402-minimize");
  const targetInput = shadow.getElementById("r402-target");
  const promptArea = shadow.getElementById("r402-prompt");
  const copyBtn = shadow.getElementById("r402-copy");
  const titleEl = shadow.getElementById("r402-title");
  const textEl = shadow.getElementById("r402-text");
  const rewardsEl = shadow.getElementById("r402-rewards");
  const sepEl = shadow.getElementById("r402-sep");
  const liveEl = shadow.getElementById("r402-live");

  titleEl.textContent = cfg.title;
  textEl.textContent = cfg.bodyText;
  rewardsEl.textContent = cfg.rewardsText;

  if (!cfg.showRewards) {
    rewardsEl.hidden = true;
    sepEl.hidden = true;
  }

  targetInput.value = safeDefaultTarget;

  function buildPrompt() {
    const targetName = sanitizeSubdomain(targetInput.value, safeDefaultTarget);
    const targetUrl = `https://${targetName}.${rootDomain}`;
    return `Read ${llmsUrl}, then ${cfg.promptVerb} the published app at ${appUrl} into ${targetUrl} on Run402.`;
  }

  function updatePrompt() {
    promptArea.value = buildPrompt();
  }

  function announce(message) {
    liveEl.textContent = "";
    window.requestAnimationFrame(() => {
      liveEl.textContent = message;
    });
  }

  function setMinimized(minimized, options = {}) {
    const moveFocus = options.moveFocus === true;
    state.minimized = minimized;
    saveState(state);

    anchor.dataset.state = minimized ? "minimized" : "expanded";
    panel.setAttribute("aria-hidden", String(minimized));
    openBtn.setAttribute("aria-hidden", String(!minimized));
    openBtn.setAttribute("aria-expanded", String(!minimized));
    openBtn.tabIndex = minimized ? 0 : -1;

    if (minimized) {
      panel.setAttribute("inert", "");
      if (moveFocus) openBtn.focus({ preventScroll: true });
    } else {
      panel.removeAttribute("inert");
      if (moveFocus) copyBtn.focus({ preventScroll: true });
    }
  }

  let resetTimer = 0;
  function setCopyState(label, mode, duration = 1600) {
    window.clearTimeout(resetTimer);
    copyBtn.textContent = label;
    copyBtn.dataset.state = mode;

    resetTimer = window.setTimeout(() => {
      copyBtn.textContent = "Copy agent prompt";
      copyBtn.dataset.state = "idle";
    }, duration);
  }

  async function copyPrompt() {
    const text = promptArea.value;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        promptArea.focus();
        promptArea.select();
        const ok = document.execCommand("copy");
        if (!ok) throw new Error("execCommand copy failed");
      }

      announce("Agent prompt copied to clipboard.");
      setCopyState("Copied", "success");
    } catch {
      promptArea.focus();
      promptArea.select();
      announce("Prompt selected. Press Command C or Control C to copy.");
      setCopyState("Press Ctrl/Cmd+C", "fallback", 2200);
    }
  }

  targetInput.addEventListener("input", updatePrompt);

  targetInput.addEventListener("blur", () => {
    targetInput.value = sanitizeSubdomain(targetInput.value, safeDefaultTarget);
    updatePrompt();
  });

  promptArea.addEventListener("focus", () => promptArea.select());
  promptArea.addEventListener("click", () => {
    window.setTimeout(() => promptArea.select(), 0);
  });

  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setMinimized(true, { moveFocus: true });
    }
  });

  copyBtn.addEventListener("click", copyPrompt);
  openBtn.addEventListener("click", () => setMinimized(false, { moveFocus: true }));
  minimizeBtn.addEventListener("click", () => setMinimized(true, { moveFocus: true }));

  updatePrompt();
  setMinimized(!!state.minimized, { moveFocus: false });
})();
</script>
```

---

## Final recommendations, distilled

### Best term
**Fork**  
Use **“Create your own live copy”** as the explanatory subtitle.

### Minimized state
A **40px mono pill**:
- green status dot
- `Forkable`
- `Run402` accent text

### Animations
- one-time scanline on mount
- quick slide/fade expand-collapse
- subtle hover glow
- copy button success state
- pulse only on the minimized pill dot

### Rewards info
**Include it, but quietly**
- footer only
- not in minimized state
- not in the headline

### Position
- **desktop:** bottom-right
- **mobile:** bottom compact sheet
- **fallback override:** bottom-left for apps with a FAB

---

If you want, I can also give you:
1. a **tighter “more premium / less developer-y” copy variant**, or  
2. a **more minimal version** with **no subdomain field**, just a straight copy button.

---
**Wall time**: 35m 34s
**Tokens**: 1,520 input, 55,403 output (47,893 reasoning), 56,923 total
**Estimated cost**: $10.0181
