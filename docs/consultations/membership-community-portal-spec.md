# Wild Lychee — Membership / Community Portal

**Date**: 2026-03-27
**Status**: Design complete, ready for implementation
**Codename**: Wild Lychee (a cheeky nod to Wild Apricot)
**Brand**: Both a standalone product (wildlychee.com) and a Run402 template

## Product Family

Three products, one mission: **"From zero to your own AI-powered community platform in one conversation."**

| Product | What | Who | Pricing |
|---------|------|-----|---------|
| **Wild Lychee** | The community portal template — forkable, customizable, AI-powered | Agents + devs who want full control | Free to fork + $5–20/mo Run402 tier |
| **Lychee Studio** | The AI concierge that builds your portal — investigates your site, interviews you, deploys | Community managers who want it done for them | Free basic build / $29 premium (one-time) |
| **Lychee Pro** | Ongoing AI customization — "add volunteer tracking", "translate to Spanish", "redesign for Christmas" | Community managers who want it to keep growing | $9/mo (5 requests) / $29/mo (unlimited) |

**Total cost**: $5 (Run402) + $9 (Pro) = **$14/mo** vs. Wild Apricot $140/mo vs. Circle $89/mo + 2% fees.

---

## The Opportunity

The membership management software market is $5.4–8.5B (2025), growing 10–15% CAGR. The dominant player for small orgs — Wild Apricot — has websites that "look like they were created in 1995" and customer support that collapsed after acquisition. Every competitor charges per-member fees, transaction taxes, or both. Nobody offers a self-hosted, fully customizable, own-your-data alternative that an AI agent can fork and make truly unique.

**Wild Lychee fills this gap.** Flat $5–20/mo Run402 tier. Zero transaction fees. No per-member pricing. Own your data. And the killer: an AI agent can customize it endlessly — add features, translate, retheme, restructure — no ceiling.

---

## Competitive Landscape

### Major Players

| Platform | Pricing | Good At | Bad At |
|----------|---------|---------|--------|
| **Wild Apricot** | $60–530/mo (per-contact) + 20% surcharge for non-affiliated gateway | All-in-one for associations: members, events, payments, basic site | 1995 design. Support collapsed post-acquisition. Per-contact billing punishes growth |
| **Mighty Networks** | $49–360/mo + 1–3% transaction fee | Native mobile app. Community + courses combined | Buggy chat. AI-only support, no humans. Auto-enrollment billing traps |
| **Circle** | $89–419/mo + 0.5–2% transaction fee | Clean modern UI. Workflows. Active development | Videos don't load on mobile. Checkout pages randomly deleted. Slow support |
| **Hivebrite** | $799+/mo (sales-gated) | Strong member directory/CRM. Built for alumni/professional networks | No video. Insanely expensive entry. More directory than community |
| **MemberPress** | $180–999/yr (no transaction fee) | Zero transaction fees. WordPress-native. Annual cost, not per-member | Requires WordPress expertise. No built-in community features |
| **Bettermode** (fka Tribe) | $399–599/mo (was $50/mo) | Embeddable widgets. Good API. SSO | 8x price hike alienated users. Limited messaging. Low engagement tools |
| **Discourse** | Free (self-hosted) or $20–500/mo hosted | Best-in-class forums. Open source | Forum-only. No membership mgmt, billing, events, directory |
| **Skool** | $9–99/mo + 2.9–10% transaction fee | Dead simple. Gamification. Low entry price | Very limited customization. One community per subscription. 10% fee on cheap plan |
| **MemberSpace** | $29/mo + 5% transaction fee | Bolts onto any existing site | 5% fee (was 1%, crept up). No community features. Thin tool |

### Common User Complaints (from Capterra, Trustpilot, Reddit)

1. **Manual work that should be automated** — 82% say their AMS hasn't reduced manual work
2. **Fragmented data** — separate tools for membership, email, events, accounting; none talk to each other
3. **Outdated UX** — Wild Apricot websites look ancient; formatting fights everywhere
4. **Vendor lock-in** — incomplete exports, pricing hikes exploit trapped users (Bettermode 8x increase)
5. **Transaction fee creep** — MemberSpace went 1% → 4% → 5%; combined platform + Stripe fees reach 7–8%
6. **Support decline** — Wild Apricot: weeks for responses. Mighty Networks: AI bots only. Circle: slow unless Enterprise
7. **Ghost town communities** — forums go dead without active seeding and moderation
8. **No mobile** — 64%+ of traffic is mobile but most platforms are desktop-first

---

## Who Buys This

**Tier 1 — High volume, price-sensitive (biggest market)**
- Churches and religious orgs ($393M market for church mgmt software alone)
- Nonprofits and charitable orgs (Wild Apricot's core market)
- Clubs and social orgs (Rotary, sports clubs, hobby groups — <500 members, very price-sensitive)

**Tier 2 — Mid-market, feature-hungry**
- Professional associations and trade groups
- Chambers of commerce
- Alumni associations (Hivebrite's market at $799+/mo)

**Tier 3 — Operational**
- HOAs and condo associations (30–40% are self-managed)
- Coworking spaces

**Best fit for Run402**: Tiers 1–2. Organizations that need membership management, not just community discussions. Volunteer-run IT, tight budgets, need something that "just works."

---

## Key Design Decisions

### 1. Full Admin Dashboard (not lean)

The admin UI IS the product. Wild Apricot's admin is ugly but functional — that's what people pay $530/mo for. Wild Lychee's admin must be genuinely good — not "good for a template." Full member management, event management, resource management, analytics, site settings.

Admin pages:
- **Dashboard** — stats cards, activity feed, quick actions, members needing attention
- **Members** — full list with search/filter, status management (approve/suspend), tier assignment, CSV export
- **Events** — create/edit events, view RSVPs, attendance tracking
- **Resources** — upload/manage files, categories, access control
- **Announcements** — create/edit/pin announcements
- **Forum** (if enabled) — moderation tools, pin/lock topics
- **Site Settings** — name, logo, colors, feature toggles, nav order, membership tiers, custom fields, pages

### 2. Inline Editing — The Page IS the Admin

The Notion/Linear approach: members and admins see the SAME page at the SAME URL. Admins get edit controls overlaid. No separate "backend" and "frontend."

```
Member sees:    content
Admin sees:     content + edit controls
```

Three editing layers:

**Layer 1 — Simple text (titles, taglines, labels)**
Native `contenteditable`. Zero libraries. ~30 lines of JS.
Admin sees subtle hover highlight. Click to edit. Blur to save.
Uses `data-editable` attributes as hooks — inert for members.

**Layer 2 — Rich text (announcements, event descriptions, page content)**
**Tiptap** (~45kB gzipped). Headless — renders using OUR CSS, not its own.
Lazy-loaded: only initialized when admin clicks an editable region.
Members never download it.

**Layer 3 — Images (hero, event images, member avatars)**
Custom click-to-upload handler. ~30 lines.
Click image → file picker → upload to Run402 storage → swap src.

Page load budget:
```
Member:  config.js + auth.js + page.js           (~15kB)
Admin:   config.js + auth.js + page.js
         + admin-editor.js + tiptap               (~60kB)
```

The admin editing JS (`admin-editor.js`) is a separate script that only loads when `role === 'admin'`. Members never see it.

### 3. Brand: Both Product and Template

Wild Lychee is:
- **A standalone product** at wildlychee.com — its own landing page, brand, marketing
- **A Run402 template** — forkable from the marketplace
- **Deployed on Run402 itself** — dogfooding the platform

"Wild Lychee — the community platform you own. Powered by Run402."

### 4. Incremental Deploys for Ongoing Agent Customization

The agent doesn't just set up and walk away. The community manager says "add volunteer hour tracking" and the agent:
1. Reads STRUCTURE.md
2. Adds a `volunteer_hours` table to schema
3. Creates `volunteer.html` + `volunteer.js`
4. Adds a nav item
5. Redeploys via `POST /deploy/v1` (idempotent, additive migrations)

Run402's bundle deploy handles this — `CREATE TABLE IF NOT EXISTS` style migrations, additive site files, function updates. No destructive redeploys.

### 5. i18n — Krello Pattern

Reuse the exact i18n architecture from Krello:

```
site/custom/strings/
├── en.json          ← master (all ~450 keys)
├── pt.json          ← agent copies en.json, translates
├── nl.json
└── ar.json          ← _meta.direction: "rtl"

site/custom/brand.json → { "languages": ["en", "pt"], "defaultLanguage": "en" }
```

- `t(key, vars)` function with English fallback chain
- `_one` suffix for plurals, `{placeholder}` interpolation
- Language selector in profile settings (only shown if >1 language)
- Saved in `localStorage`, loaded via fetch on demand
- Agent adds a language: copy `en.json` → translate → update `brand.json` → deploy

### 6. Testing — 85% Minimum Coverage

**Test stack:**
- **Unit**: Vitest + Node — API wrappers, formatters, validators, i18n, auth helpers
- **Integration**: Vitest + happy-dom — page rendering, DOM manipulation, config-driven UI, feature flag permutations
- **E2E / Deploy verification**: Claude Code + Chrome MCP — agent-driven visual verification of the deployed site
- **Coverage**: `@vitest/coverage-v8` — 85%+ on `site/js/**`
- **Config permutations**: `describe.each` + `fast-check` for feature flag combinations

```
tests/
├── unit/                    # Vitest + Node
│   ├── api.test.js
│   ├── config.test.js
│   ├── i18n.test.js
│   ├── auth.test.js
│   └── format.test.js
├── integration/             # Vitest + happy-dom
│   ├── dashboard.test.js
│   ├── directory.test.js
│   ├── events.test.js
│   ├── admin-editor.test.js
│   ├── nav.test.js
│   ├── features.test.js
│   └── i18n-render.test.js
└── fixtures/
    ├── configs.js
    └── members.js
```

**Why Claude Code + Chrome instead of Playwright:**

An AI-native product should be tested by an AI-native tool. Claude Code with Chrome MCP integration:
- Deploys the app, opens it in Chrome, visually verifies pages load and look correct
- Can reason about visual quality, not just DOM assertions ("does this look like a modern 2026 site?")
- Tests auth flows by interacting with real Google OAuth in the browser
- Verifies inline editing works by clicking elements, typing, saving, and checking results
- Records GIF walkthroughs of key flows for review
- No separate test framework to maintain — the agent IS the tester

**Deploy verification flow** (agent-driven):
1. Agent deploys to a fresh Run402 project via `deploy.ts`
2. Opens deployed URL in Chrome via `tabs_create_mcp`
3. Verifies all pages load (navigates to each, reads page content)
4. Signs up as first user → verifies admin role assigned
5. Tests inline editing: clicks an editable element, modifies it, verifies save
6. Toggles feature flags via API → refreshes → verifies nav/pages update
7. Creates an event, RSVPs, verifies count updates
8. Switches language, verifies UI strings change
9. Records a GIF of the full walkthrough
10. Reports pass/fail with screenshots of any issues

**Unit + integration tests** (automated, CI):
- Run on every commit via `npm test`
- Cover all JS logic: API wrappers, formatters, config loaders, i18n, feature flag permutations
- happy-dom renders pages with mock data and asserts DOM structure
- `fast-check` property-based tests ensure random config combinations never crash the UI
- 85% coverage threshold enforced by `@vitest/coverage-v8`

---

## Features

### Core (must-have, 90% of daily use)

| Feature | Why | Run402 Primitive |
|---------|-----|------------------|
| **Member database** | Staff live in this daily | Postgres + REST API |
| **Member profiles** | Self-service reduces support 40% | Auth + DB + storage (avatars) |
| **Member directory** | #1 reason 64% of members join (networking) | DB + public/private views |
| **Membership tiers** | Different pricing, benefits, access per tier | DB config table |
| **Announcements / news** | Primary member touchpoint | DB + site |
| **Event management** | Registration, attendance, member vs non-member pricing | DB + site |
| **Resource library** | Gated content justifies dues | Storage + auth |
| **Admin dashboard** | Active count, renewal rate, revenue | DB queries + site |
| **Auth (Google + password)** | Members log in, manage their profile | Run402 auth (built-in) |
| **Inline editing** | Admin edits the live page, no separate backend | Tiptap + contenteditable |

### Important (high-value additions)

| Feature | Why | Run402 Primitive |
|---------|-----|------------------|
| **Committees / groups** | Sub-communities within the org | DB (many-to-many) |
| **Activity feed** | Shows community is alive | DB + site |
| **File sharing** | Documents, minutes, policies | Storage |
| **Contact forms** | Public inquiry, membership application | DB + site |
| **Email notifications** | Welcome, announcements, reminders | Run402 email (template-based) |
| **CSV import/export** | Migration, reporting, board presentations | Edge function |
| **Scheduled jobs** | Expiration checks, reminders, digests | Run402 cron (schedule field on functions) |

### Nice-to-have (enable via feature flags)

| Feature | Why | Notes |
|---------|-----|-------|
| **Forum / discussions** | Deeper engagement | Requires moderation effort; often goes dead |
| **Blog / news posts** | Content marketing, member updates | Simple CRUD |
| **Custom pages** | About, FAQ, contact, policies | Schema-driven content |
| **Donation / payment links** | Revenue beyond dues | External link (Stripe, PayPal) |
| **Digital membership card** | Modern member verification | Generated HTML/image |
| **Gamification** | Points, badges, leaderboard | Fun but often goes unused |

### Explicitly NOT building (yet)

- Real-time chat / WebSocket features (Run402 is HTTP-only)
- Recurring billing / subscription management (needs Stripe integration)
- Native mobile app
- Continuing education / certification tracking
- Multi-chapter / branch support
- Complex workflow automation

---

## Architecture

### Design Principle

**An AI agent's "API" to this template is SQL for config and direct file editing for code.**

Three customization tiers:
1. **SQL only** (80% of customizations) — rebrand, restructure, toggle features, all via database
2. **HTML/CSS edits** (15%) — visual changes, layout modifications
3. **Full fork** (5%) — new tables, new functions, new page types

### Three-Layer Architecture

```
LAYER 1: The Admin UI (human operates)
  Site name, logo, colors, nav, pages, member management,
  events, announcements, feature toggles, tier config
  + inline editing on the live site
              ▲
              │ reads/writes
              ▼
LAYER 2: The Config DB (both operate)
  site_config, membership_tiers, pages, sections,
  nav_items, custom_fields
              ▲
              │ reads/writes
              ▼
LAYER 3: The Code (agent operates)
  HTML pages, CSS, JS, schema.sql, edge functions, deploy.ts
```

### File Structure

```
wild-lychee/
├── deploy.ts                     # One-command deploy to Run402
├── STRUCTURE.md                  # AI-readable manifest (the map)
├── CUSTOMIZING.md                # Agent guide: how to customize
├── schema.sql                    # All tables, organized by feature section
├── seed.sql                      # Default config + sample data
├── vitest.config.js              # Test configuration (unit + integration)
├── site/
│   ├── index.html                # Landing / public home
│   ├── directory.html            # Member directory
│   ├── events.html               # Events listing
│   ├── event.html                # Single event detail + RSVP
│   ├── resources.html            # Resource library
│   ├── forum.html                # Forum / discussions (feature flag)
│   ├── profile.html              # Member profile editor
│   ├── admin.html                # Admin dashboard
│   ├── admin-members.html        # Admin: member management
│   ├── admin-events.html         # Admin: event management
│   ├── admin-resources.html      # Admin: resource management
│   ├── admin-settings.html       # Admin: site settings panel
│   ├── page.html                 # Generic page renderer (schema-driven)
│   ├── css/
│   │   ├── theme.css             # CSS custom properties (from DB or hand-edited)
│   │   └── styles.css            # All component styles using variables
│   ├── js/
│   │   ├── config.js             # Loads site_config, sets CSS vars, builds nav
│   │   ├── auth.js               # Google OAuth + session + role checks
│   │   ├── api.js                # Thin REST API wrapper
│   │   ├── i18n.js               # t() function, loadLocale, setLanguage
│   │   ├── directory.js          # Member directory logic
│   │   ├── events.js             # Events logic
│   │   ├── resources.js          # Resource library logic
│   │   ├── forum.js              # Forum logic
│   │   ├── profile.js            # Profile editor logic
│   │   ├── admin.js              # Admin dashboard logic
│   │   ├── admin-members.js      # Admin: member management
│   │   ├── admin-events.js       # Admin: event management
│   │   ├── admin-resources.js    # Admin: resource management
│   │   ├── admin-settings.js     # Admin: site settings
│   │   └── admin-editor.js       # Inline editing (Tiptap + contenteditable)
│   └── custom/
│       ├── brand.json            # Deploy-time config: name, languages, theme
│       └── strings/
│           └── en.json           # Master translations (~450 keys)
├── functions/
│   ├── on-signup.js              # Post-signup: create member, assign first-user admin, AI welcome
│   ├── invite.js                 # Send membership invite email
│   ├── check-expirations.js      # schedule: "0 8 * * *" — daily expiration check + AI member insights
│   ├── event-reminders.js        # schedule: "0 * * * *" — hourly event reminders
│   ├── moderate-content.js       # schedule: "*/15 * * * *" — AI content moderation (feature flag)
│   ├── translate-content.js      # Triggered on new content — AI auto-translation (feature flag)
│   ├── generate-newsletter.js    # schedule: "0 9 * * 1" — AI weekly newsletter draft (feature flag)
│   ├── generate-recap.js         # Triggered after event — AI event recap draft (feature flag)
│   └── export-csv.js             # Manual trigger: export members/events to CSV
└── tests/
    ├── unit/                     # Vitest + Node
    ├── integration/              # Vitest + happy-dom
    └── fixtures/                 # Mock data + config permutations
```

### Config-Driven Everything

The `site_config` table is the AI's primary control surface:

```sql
CREATE TABLE site_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  category TEXT NOT NULL DEFAULT 'general'
);
```

#### Config keys

**Branding**
```
site_name           — "Riverside Community Club"
site_tagline        — "Connecting neighbors since 1987"
site_description    — SEO description
logo_url            — "/storage/logo.png"
favicon_url         — "/storage/favicon.ico"
```

**Theme** (single JSON object → injected as CSS custom properties)
```json
{
  "primary": "#6366f1",
  "primary_hover": "#4f46e5",
  "bg": "#ffffff",
  "surface": "#f8fafc",
  "text": "#0f172a",
  "text_muted": "#64748b",
  "border": "#e2e8f0",
  "font_heading": "Inter",
  "font_body": "Inter",
  "radius": "0.5rem",
  "max_width": "72rem"
}
```

AI agent rethemes the entire site with one SQL update:
```sql
UPDATE site_config SET value = '{"primary":"#dc2626","bg":"#0f0f0f","text":"#f5f5f5","font_heading":"Playfair Display","font_body":"Lato","radius":"0"}'::jsonb WHERE key = 'theme';
```

**Feature flags**
```
feature_events          — true/false
feature_forum           — true/false
feature_directory       — true/false
feature_resources       — true/false
feature_blog            — true/false
feature_committees      — true/false
feature_ai_moderation   — true/false (requires AI API key secret)
feature_ai_translation  — true/false (requires AI API key secret)
feature_ai_newsletter   — true/false (requires AI API key secret)
feature_ai_insights     — true/false (requires AI API key secret)
```

**Navigation** (auto-generated from feature flags, overridable)
```json
[
  {"label": "Home", "href": "/", "icon": "home", "public": true},
  {"label": "Members", "href": "/directory.html", "icon": "users", "auth": true, "feature": "feature_directory"},
  {"label": "Events", "href": "/events.html", "icon": "calendar", "feature": "feature_events"}
]
```

### Schema-Driven Pages

```sql
CREATE TABLE pages (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  requires_auth BOOLEAN DEFAULT false,
  show_in_nav BOOLEAN DEFAULT false,
  nav_position INT,
  published BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sections (
  id SERIAL PRIMARY KEY,
  page_slug TEXT DEFAULT 'index',
  section_type TEXT NOT NULL,   -- 'hero', 'features', 'cta', 'stats', 'testimonials', 'faq', 'custom'
  config JSONB NOT NULL,
  position INT NOT NULL,
  visible BOOLEAN DEFAULT true
);
```

Section config examples:
```json
// hero
{"heading": "Welcome to Our Community", "subheading": "Join 400+ members", "cta_text": "Join Now", "cta_href": "/signup", "bg_image": "/storage/hero.jpg"}

// features (3-column grid)
{"columns": 3, "items": [
  {"icon": "calendar", "title": "Monthly Events", "desc": "Networking dinners, workshops, and socials"},
  {"icon": "users", "title": "Member Directory", "desc": "Connect with 400+ professionals"},
  {"icon": "book-open", "title": "Resource Library", "desc": "Exclusive guides, templates, and recordings"}
]}

// stats
{"items": [{"value": "400+", "label": "Members"}, {"value": "50+", "label": "Events/Year"}]}

// testimonials
{"items": [{"quote": "Best professional decision...", "name": "Sarah K.", "role": "Member since 2024"}]}

// faq
{"items": [{"q": "How do I join?", "a": "Click 'Join Now'..."}, {"q": "Cost?", "a": "$50/year..."}]}
```

AI restructures the homepage with SQL — no file edits needed.

### Database Schema (by feature section)

```sql
-- ============================================
-- SECTION: Core / Config
-- ============================================

CREATE TABLE site_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  category TEXT NOT NULL DEFAULT 'general'
);

CREATE TABLE pages (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  requires_auth BOOLEAN DEFAULT false,
  show_in_nav BOOLEAN DEFAULT false,
  nav_position INT,
  published BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sections (
  id SERIAL PRIMARY KEY,
  page_slug TEXT DEFAULT 'index',
  section_type TEXT NOT NULL,
  config JSONB NOT NULL,
  position INT NOT NULL,
  visible BOOLEAN DEFAULT true
);

-- ============================================
-- SECTION: Members
-- ============================================

CREATE TABLE membership_tiers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  benefits TEXT[],
  price_label TEXT,
  position INT NOT NULL,
  is_default BOOLEAN DEFAULT false
);

CREATE TABLE member_custom_fields (
  id SERIAL PRIMARY KEY,
  field_name TEXT NOT NULL,
  field_label TEXT NOT NULL,
  field_type TEXT NOT NULL,     -- 'text', 'select', 'multiselect', 'date', 'url', 'textarea'
  options JSONB,
  required BOOLEAN DEFAULT false,
  visible_in_directory BOOLEAN DEFAULT true,
  position INT NOT NULL
);

CREATE TABLE members (
  id SERIAL PRIMARY KEY,
  user_id UUID,                -- links to Run402 auth user
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT,
  tier_id INT REFERENCES membership_tiers(id),
  role TEXT NOT NULL DEFAULT 'member',    -- 'member', 'admin', 'moderator'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'active', 'expired', 'suspended'
  custom_fields JSONB DEFAULT '{}',
  joined_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- SECTION: Events (feature: events)
-- ============================================

CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  capacity INT,
  image_url TEXT,
  is_members_only BOOLEAN DEFAULT false,
  created_by INT REFERENCES members(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE event_rsvps (
  id SERIAL PRIMARY KEY,
  event_id INT REFERENCES events(id) ON DELETE CASCADE,
  member_id INT REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'going',  -- 'going', 'maybe', 'cancelled'
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(event_id, member_id)
);

-- ============================================
-- SECTION: Resources (feature: resources)
-- ============================================

CREATE TABLE resources (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  file_url TEXT,
  file_type TEXT,              -- 'pdf', 'video', 'link', 'image'
  is_members_only BOOLEAN DEFAULT true,
  uploaded_by INT REFERENCES members(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- SECTION: Forum (feature: forum)
-- ============================================

CREATE TABLE forum_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  position INT NOT NULL,
  color TEXT DEFAULT '#6366f1'
);

CREATE TABLE forum_topics (
  id SERIAL PRIMARY KEY,
  category_id INT REFERENCES forum_categories(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id INT REFERENCES members(id),
  is_pinned BOOLEAN DEFAULT false,
  reply_count INT DEFAULT 0,
  last_reply_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE forum_replies (
  id SERIAL PRIMARY KEY,
  topic_id INT REFERENCES forum_topics(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author_id INT REFERENCES members(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- SECTION: Committees (feature: committees)
-- ============================================

CREATE TABLE committees (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE committee_members (
  id SERIAL PRIMARY KEY,
  committee_id INT REFERENCES committees(id) ON DELETE CASCADE,
  member_id INT REFERENCES members(id),
  role TEXT DEFAULT 'member',  -- 'chair', 'member'
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(committee_id, member_id)
);

-- ============================================
-- SECTION: Announcements
-- ============================================

CREATE TABLE announcements (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_pinned BOOLEAN DEFAULT false,
  author_id INT REFERENCES members(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- SECTION: Activity Log
-- ============================================

CREATE TABLE activity_log (
  id SERIAL PRIMARY KEY,
  member_id INT REFERENCES members(id),
  action TEXT NOT NULL,        -- 'signup', 'rsvp', 'post', 'upload', 'login'
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- SECTION: AI Features
-- ============================================

CREATE TABLE content_translations (
  id SERIAL PRIMARY KEY,
  content_type TEXT NOT NULL,    -- 'announcement', 'event', 'page', 'forum_topic'
  content_id INT NOT NULL,
  language TEXT NOT NULL,        -- 'pt', 'nl', 'ar'
  field TEXT NOT NULL,           -- 'title', 'body', 'description'
  translated_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(content_type, content_id, language, field)
);

CREATE TABLE moderation_log (
  id SERIAL PRIMARY KEY,
  content_type TEXT NOT NULL,     -- 'forum_topic', 'forum_reply'
  content_id INT NOT NULL,
  action TEXT NOT NULL,           -- 'approved', 'flagged', 'hidden'
  reason TEXT,                    -- AI explanation
  confidence REAL,                -- 0.0 to 1.0
  reviewed_by INT REFERENCES members(id),  -- null = AI, set = human override
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE member_insights (
  id SERIAL PRIMARY KEY,
  member_id INT REFERENCES members(id),
  insight_type TEXT NOT NULL,     -- 'expiring', 'inactive', 'at_risk', 'engagement_drop'
  message TEXT NOT NULL,          -- AI-generated suggested outreach
  priority TEXT DEFAULT 'medium', -- 'high', 'medium', 'low'
  status TEXT DEFAULT 'pending',  -- 'pending', 'actioned', 'dismissed'
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE newsletter_drafts (
  id SERIAL PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,             -- AI-generated HTML
  status TEXT DEFAULT 'draft',    -- 'draft', 'approved', 'sent'
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Inline Editing — Implementation Pattern

Each page uses `data-editable` attributes. The `admin-editor.js` scans for these and adds editing behavior. Members never know the attributes exist.

```html
<!-- events.html — same file serves both roles -->
<div class="event-card" data-event-id="42">
  <div class="event-image" data-editable-image="events/42/cover">
    <img src="/storage/events/42/cover.jpg" alt="Summer BBQ">
    <!-- admin-editor.js adds camera overlay for admins -->
  </div>
  <h3 data-editable="events.42.title">Summer BBQ</h3>
  <p data-editable="events.42.location">Riverside Park</p>
  <button class="btn-primary rsvp-btn">RSVP</button>
  <!-- admin-editor.js adds Edit/Delete buttons for admins -->
</div>
```

CSS patterns for invisible-until-hovered edit controls:
```css
[contenteditable="true"] { outline: none; border: none; cursor: text; }
.admin [contenteditable="true"]:hover { background: rgba(0,0,0,0.03); border-radius: 4px; }
```

Rich text (announcements, descriptions): Tiptap editor initialized lazily on admin click. Floating toolbar on text selection, not permanent.

### AI-Friendly Code Patterns

1. **HTML section landmarks** — every page uses comment markers:
   ```html
   <!-- NAV: Navigation -->
   <!-- HERO: Page header -->
   <!-- CONTENT: Main content -->
   <!-- FOOTER: Site footer -->
   ```

2. **One JS file per page** — `events.js` handles only events. No cross-page imports.

3. **Predictable naming**:
   ```
   site/{feature}.html          → the page
   site/js/{feature}.js         → page-specific logic
   functions/{feature}-*.js     → edge functions for that feature
   schema.sql SECTION: {Feature} → tables for that feature
   site/custom/strings/en.json  → all UI strings keyed by section.key
   ```

4. **No build step** — static HTML + CSS variables + vanilla JS. Libraries (Tiptap) loaded via esm.sh or bundled into admin-editor.js.

5. **STRUCTURE.md manifest** — the first file any AI agent reads.

6. **CUSTOMIZING.md** — step-by-step guide for the agent: how to add languages, features, pages, theme changes.

7. **Feature flags, not plugins** — all features ship. Toggle with boolean in `site_config`.

8. **CSS variables for theming** — a tiny script reads `theme` from `site_config` and sets CSS custom properties.

9. **Schema-driven UI** — navigation, pages, homepage sections are database rows.

### Scheduled Functions

Run402 has full cron support via the `schedule` field on function deploy.

```
functions/
├── on-signup.js              ← triggered by client after auth
├── check-expirations.js      ← schedule: "0 8 * * *" (daily 8AM)
├── event-reminders.js        ← schedule: "0 * * * *" (hourly)
├── export-csv.js             ← triggered manually from admin
└── invite.js                 ← triggered from admin panel
```

Tier limits: Prototype 1 scheduled fn (15min min), Hobby 3 (5min), Team 10 (1min).

### First-User Admin Flow

The `on-signup` edge function checks if the `members` table is empty. If so, the first user becomes admin automatically. After that, admins promote other members from the admin panel.

### Fork Experience (5 Minutes to Live)

```
1. Agent reads CUSTOMIZING.md
2. Edits brand.json (name, colors, languages)
3. Edits seed.sql (tiers, sample data, custom fields)
4. Runs: npx tsx deploy.ts
5. First user signs up → becomes admin
6. Live at myclub.run402.com
```

---

## Run402 Platform Gaps

Issues found during design that the Run402 team should consider filling.

### Gap 1: Email Templates Too Rigid — IMPACT: HIGH

**Current state:** 3 fixed templates (`project_invite`, `magic_link`, `notification`). The `notification` template only allows a 500-char plain text `message`.

**What Wild Lychee needs:**
- Welcome email with community name, logo, getting-started links
- Event RSVP confirmation with event details
- Renewal reminder with member tier, expiration date, renewal link
- Announcement notification with rich text content
- Weekly digest with activity summary

**Options:**
- A: Run402 adds more template types with richer variable support
- B: Run402 adds a `raw_email` endpoint (subject + HTML body, with abuse guardrails)
- C: Wild Lychee uses an edge function calling an external email API (Resend, SES)

Option B is the cleanest platform improvement. Option C is the workaround.

### Gap 2: No Webhook / Event System — IMPACT: MEDIUM

**Current state:** No post-auth-signup hook. Client must call the `on-signup` function explicitly after auth completes.

**What would help:** `POST /projects/v1/admin/:id/hooks` — register a function to run on auth events (signup, login). Even just `on_signup` would be huge.

**Workaround:** Client-side JS calls the `on-signup` function explicitly after Google OAuth callback. Works but is fragile (user could close the tab before the call).

### Gap 3: No Full-Text Search Helper — IMPACT: MEDIUM

**Current state:** PostgREST supports Postgres full-text search (`?body=fts.word`), but needs `tsvector` columns and `GIN` indexes in the schema.

**What would help:** Documented pattern or helper for full-text search. Not a platform gap per se — we can add `tsvector` columns ourselves.

### Gap 4: 10MB File Upload Limit — IMPACT: LOW (v1)

Fine for photos, PDFs, documents. Limits video and large presentations. Not blocking for v1 but worth noting for photographer/course portal variants.

### Gap 5: No Batch REST Operations — IMPACT: LOW

Approving 12 members = 12 PATCH requests. CSV import of 200 members = 200 POSTs or one edge function. Workable but inelegant.

---

## AI-Powered Features — The Moat

This is where Wild Lychee stops being "a better Wild Apricot" and becomes something Wild Apricot can never be. These features are enabled by edge functions calling AI APIs on a cron schedule.

### Architecture: BYOK (Bring Your Own Key)

```
┌──────────────┐     ┌─────────────┐    ┌───────────┐
│ Scheduled     │────>│ Edge        │───>│ AI API    │
│ cron trigger  │     │ Function    │    │ (OpenAI/  │
│ (daily/hourly)│     │             │<───│  Claude)  │
└──────────────┘     │ reads DB    │    └───────────┘
                      │ writes DB   │
                      │ sends email │
                      └─────────────┘
```

User stores `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` as a project secret. Scheduled functions call the API. Zero AI costs for Run402 — the user pays their own API provider directly.

### Feature Flags

```
feature_ai_moderation    — true/false (requires AI API key)
feature_ai_translation   — true/false (requires AI API key)
feature_ai_newsletter    — true/false (requires AI API key)
feature_ai_insights      — true/false (requires AI API key)
```

### AI Feature 1: Content Moderation Bot

**Schedule**: `*/15 * * * *` (every 15 minutes)
**Phase**: 2 (after forum is built)

Every 15 minutes:
- Read new forum posts / replies since last check
- Send to AI: "Is this spam, toxic, off-topic, or appropriate?"
- Auto-hide flagged content, mark for admin review
- Log moderation decisions with AI reasoning
- Admin sees flagged items in dashboard with one-click approve/reject

**Why this matters**: The #1 reason community forums die is unmoderated spam. Volunteer admins burn out doing manual moderation. An AI moderator running 24/7 keeps the forum alive — something Wild Apricot literally cannot offer.

```sql
CREATE TABLE moderation_log (
  id SERIAL PRIMARY KEY,
  content_type TEXT NOT NULL,     -- 'forum_topic', 'forum_reply'
  content_id INT NOT NULL,
  action TEXT NOT NULL,           -- 'approved', 'flagged', 'hidden'
  reason TEXT,                    -- AI explanation
  confidence REAL,                -- 0.0 to 1.0
  reviewed_by INT REFERENCES members(id),  -- null = AI, set = human override
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### AI Feature 2: Auto-Translation of User Content

**Trigger**: On new announcement, event, or page publish
**Phase**: 2 (after i18n is built)

When admin posts content:
- Detect configured languages from `brand.json`
- Translate title + body to each language via AI
- Store translations in `content_translations` table
- Members see content in their preferred language automatically

**This is different from i18n** (which translates UI strings). This translates the *content itself*. A Portuguese church posts an announcement in Portuguese → English-speaking members read it in English. No SaaS competitor offers this.

```sql
CREATE TABLE content_translations (
  id SERIAL PRIMARY KEY,
  content_type TEXT NOT NULL,    -- 'announcement', 'event', 'page', 'forum_topic'
  content_id INT NOT NULL,
  language TEXT NOT NULL,        -- 'pt', 'nl', 'ar'
  field TEXT NOT NULL,           -- 'title', 'body', 'description'
  translated_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(content_type, content_id, language, field)
);
```

### AI Feature 3: Weekly Newsletter Generator

**Schedule**: `0 9 * * 1` (Monday 9AM)
**Phase**: 3 (after email gap is addressed)

Every Monday:
- Read past week's activity from DB: new members, upcoming events, announcements, top forum discussions, new resources
- Send to AI: "Write a friendly, concise newsletter for [community name]"
- Save draft to `newsletter_drafts` table
- Admin gets notification: "Your weekly newsletter draft is ready"
- Admin reviews/edits inline (Tiptap!), clicks Send

**Why this matters**: Newsletter writing is the #1 task community managers procrastinate on. The AI writes it, the human just reviews and hits send.

```sql
CREATE TABLE newsletter_drafts (
  id SERIAL PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,             -- AI-generated HTML
  status TEXT DEFAULT 'draft',    -- 'draft', 'approved', 'sent'
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### AI Feature 4: Smart Member Insights

**Schedule**: `0 8 * * *` (daily 8AM)
**Phase**: 2 (immediate value for admin dashboard)

Every morning:
- Check members expiring in next 7/14/30 days
- Check members inactive for 30+ days
- Check pending applications waiting for review
- AI generates personalized outreach suggestions:
  "Sarah's membership expires in 7 days. She attended 3 events this quarter — mention the upcoming Summer BBQ she'd enjoy!"
- Save insights to `member_insights` table
- Display in admin dashboard "Members Needing Attention" section

```sql
CREATE TABLE member_insights (
  id SERIAL PRIMARY KEY,
  member_id INT REFERENCES members(id),
  insight_type TEXT NOT NULL,     -- 'expiring', 'inactive', 'at_risk', 'engagement_drop'
  message TEXT NOT NULL,          -- AI-generated suggested outreach
  priority TEXT DEFAULT 'medium', -- 'high', 'medium', 'low'
  status TEXT DEFAULT 'pending',  -- 'pending', 'actioned', 'dismissed'
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### AI Feature 5: Event Recap Generator

**Trigger**: Manually triggered or scheduled after event `ends_at`
**Phase**: 3 (nice-to-have)

After an event ends:
- Read event details + attendance count
- AI generates a recap post: "Our Summer BBQ brought together 23 members at Riverside Park. Thanks to everyone who came!"
- Save as announcement draft
- Admin reviews, adds photos, publishes

### AI Feature 6: Personalized Onboarding

**Trigger**: `on-signup` function
**Phase**: 2 (huge first-impression impact)

When a new member signs up:
- AI generates personalized welcome based on their profile and tier:
  "Welcome Sarah! As a Student member, here's what's coming up: Tech Meetup next Tuesday (popular with students!), check out our Resource Library for study guides, introduce yourself in the Forum!"
- Send via email notification
- Log to activity feed

### Admin Settings: AI Features Panel

```
┌─────────────────────────────────────────────────────────┐
│  AI Features                                            │
│                                                         │
│  API Key: [sk-••••••••••••••••••••] [Test] [Save]       │
│  Provider: (•) OpenAI  ( ) Anthropic                    │
│                                                         │
│  ☑ Content Moderation     (checks every 15 minutes)     │
│  ☑ Auto-Translation       (to: PT, NL)                  │
│  ☐ Newsletter Generator   (Mondays 9AM)                 │
│  ☑ Member Insights        (daily)                       │
│  ☑ Personalized Onboarding                              │
│  ☐ Event Recaps                                         │
│                                                         │
│  AI Activity (last 7 days):                             │
│  • Moderated 21 posts (3 flagged, 0 false positives)    │
│  • Translated 8 announcements to PT, NL                 │
│  • Generated 4 member outreach suggestions              │
│  • Newsletter draft ready for Monday                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Why This Is Unbeatable

| Pain Point | Wild Apricot | Wild Lychee |
|------------|-------------|-------------|
| Forum dies (no moderator) | Manual only. Volunteer burns out. | AI moderator runs 24/7. Spam never gets through. |
| Newsletter never written | Admin procrastinates. Members disengage. | AI writes draft Monday AM. Admin reviews + sends. |
| Members churn silently | You notice when they're already gone. | AI spots at-risk members daily, drafts outreach. |
| Bilingual community | English-only or separate posts. | AI translates every announcement automatically. |
| New members feel lost | Generic welcome email. | AI sends personalized onboarding based on profile + tier. |
| Post-event silence | Nothing happens. | AI generates recap draft. Admin adds photos, publishes. |

This is not a feature gap. This is a category gap. Wild Apricot cannot do this. Ever.

---

## Lychee Studio — The AI Builder

### The Gap

Nobody does "investigate your existing site + interview you + build a community portal." B12 comes closest (imports content from existing sites) but builds generic business sites, not community platforms. Circle and Mighty Networks have zero AI-powered setup — just manual templates. The closest model (Durable) asks 3 questions and builds a brochure site in 30 seconds — but brochure sites, not membership portals.

Wild Apricot onboarding: sign up → pick a template → spend weeks configuring.
Lychee Studio: one conversation → done.

### The Flow

**Step 1: Investigate** (if user provides existing website URL)

The AI uses Chrome to navigate the existing site and extract:

```
VISUAL IDENTITY
├── Logo (og:image, header img, favicon)
├── Color palette (computed styles on key elements)
├── Fonts (font-family from body, headings)
└── Photography style (hero images, team photos)

CONTENT
├── Organization name (title, h1, og:title)
├── Tagline / mission statement
├── About text
├── Contact info, social links
├── Team / leadership info
└── Existing page structure

STRUCTURE
├── What pages exist (nav links)
├── Events section? Blog? Gallery? Forms?
├── Member area / login?
├── Resource downloads?
└── Language (html lang, content language)
```

**Step 2: Interview** (smart questions based on findings)

Always ask:
- What type of community? (church, club, HOA, association...)
- How many members roughly?
- Open signup or admin-approved?
- What languages?

Ask if not found on site:
- Organization name?
- Brand colors?
- What features matter most?

Context-specific (based on community type):
- Church → sermon archive? prayer requests? worship team resources?
- HOA → maintenance requests? document archive? voting?
- Club → committees? membership tiers? newsletter?
- Sports → teams? standings? schedules?

AI features:
- Want content moderation?
- Want auto-translation?
- Want newsletter generation?

**Step 3: Spec** (present the plan)

AI generates and shows the customization spec:
- brand.json — name, colors, fonts, languages
- Feature flags — which modules to enable
- Membership tiers — names, benefits, pricing labels
- Custom fields — org-specific member fields
- Homepage sections — layout, content, order
- Schema additions — any tables beyond the template
- Translations — auto-generated for configured languages

User confirms or requests changes. Iterate until happy.

**Step 4: Build + Deploy**

1. Fork Wild Lychee template
2. Apply brand.json customizations
3. Generate translations via AI
4. Apply seed.sql (config, tiers, sample data)
5. Apply any schema additions or HTML/CSS modifications
6. Deploy via Run402 bundle deploy
7. Claim subdomain
8. Verify via Chrome (open site, check every page loads)
9. Report to user: "You're live at esperanca.run402.com!"

### Example Conversation

```
🍈 Studio: Hi! I'm going to build your community portal.
   What kind of community do you run?

Maria: A church. Igreja Evangélica da Esperança in Porto.

🍈 Studio: Do you have an existing website I can look at?

Maria: Yes — igrejadaesperanca.pt

🍈 [Opens website. Reads pages. Extracts name, colors (deep blue +
   gold), logo, content structure, team info, events, sermon archive]

🍈 Studio: Beautiful church! Here's what I found:
   ✅ Name: Igreja Evangélica da Esperança
   ✅ Colors: deep blue + gold
   ✅ You have events, sermons, and a contact page

   A few questions:
   1. Should members sign up themselves or be admin-approved?
   2. Sermons as downloads or YouTube embeds?
   3. Any committees? (youth, worship, deacons...)
   4. Portuguese only, or Portuguese + English?

Maria: Admin-approved. YouTube. Youth, worship, deacons. PT + EN.

🍈 Studio: Here's what I'm building:
   [Shows full spec with features, tiers, sections, roles]
   Should I build this?

Maria: Add a prayer request form.

🍈 Studio: Done. Building now...
   ✅ Schema configured (12 tables)
   ✅ Theme applied (deep blue + gold)
   ✅ Portuguese translations generated (428 strings)
   ✅ Prayer request page added
   ✅ Deploying...
   ✅ Live at esperanca.run402.com

   Sign up to become the first admin!
```

### Premium Build ($29 one-time)

The free build covers: name, colors, feature toggles, basic seed data.

The $29 premium build adds:
- Website investigation + content migration from existing site
- AI-generated translations (up to 3 languages)
- Custom homepage design (sections, layout, sample content)
- Niche-specific customizations (church roles, HOA issue types, etc.)
- Chrome verification walkthrough + GIF recording of the result

### Delivery: Claude Code Skill (Phase 1)

Start with a Claude Code skill: `/lychee-studio`. It has full access to Chrome MCP (investigate sites), file system (generate customizations), and Run402 APIs (deploy).

Later (Phase 4+): web-based chat interface at `studio.wildlychee.com` for non-technical community managers.

---

## Lychee Pro — Ongoing AI Customization

### What It Is

After the portal is built, the community manager needs ongoing help. Lychee Pro is the AI assistant that keeps customizing:

- "Add a volunteer hours tracker"
- "Our youth group needs their own events calendar"
- "Translate everything to Spanish — we have new members from Mexico"
- "Make the homepage more festive for Christmas"
- "Add a photo gallery page for our annual gala"
- "Change member tiers — we need a 'Founding Member' level"

### How It Works

Community manager opens Claude Code with their Wild Lychee project → describes what they want → the agent:
1. Reads STRUCTURE.md to understand the current portal
2. Plans the change (new table? new page? config update?)
3. Implements it (SQL + file edits)
4. Redeploys via Run402 bundle deploy (incremental, non-destructive)
5. Verifies via Chrome MCP
6. Reports: "Done. Your volunteer hours page is live."

### Pricing

| Plan | Requests/mo | Price | Target |
|------|-------------|-------|--------|
| **Free** | 0 (DIY with Claude Code) | $0 | Devs/agents who fork Wild Lychee |
| **Starter** | 5 customization requests | $9/mo | Small clubs, churches |
| **Unlimited** | Unlimited requests | $29/mo | Active communities, associations |

"Request" = one natural-language customization ask. Could be a 5-minute config change or a 30-minute new feature. The AI handles both.

### Why This Is the Moat

This is the recurring revenue engine. The community manager is locked in by convenience, not by data. They can always take their code and data and leave. But why would they? Their AI assistant:
- Knows their portal's structure (STRUCTURE.md)
- Knows their community's context (past customizations)
- Keeps getting better (as Claude improves, so does Pro)
- Costs less per month than a single hour of freelance developer time

No SaaS competitor can offer this. Wild Apricot's support team takes weeks to respond. Circle's enterprise plan is $419/mo and still doesn't customize for you. Lychee Pro gives you an AI developer for $29/mo.

---

## Marketing — "The Community Platform With a Built-In AI Assistant"

### Positioning

Wild Lychee is NOT "a cheaper Wild Apricot." It's a new category:

**The community platform that gets smarter, not more expensive.**

Four pillars:
1. **Build it** — tell our AI about your community. It investigates your existing site, asks smart questions, and builds your portal in one conversation. Live in 5 minutes.
2. **Own it** — your data, your code, your subdomain. No vendor lock-in. No transaction fees. $5–20/mo flat.
3. **Shape it** — your AI assistant customizes everything. Add features, translate to any language, retheme, restructure. No ceiling. No developer needed.
4. **Automate it** — built-in AI moderates your forum, writes your newsletter, spots at-risk members, translates your content, onboards new members. While you sleep.

### Taglines (options)

- "The community platform you own. With an AI that runs it."
- "Tell us about your community. We'll build your platform in 5 minutes."
- "Wild Apricot charges $530/mo. Wild Lychee is $14. And it has AI."
- "From zero to your own community platform in one conversation."
- "Stop renting your community. Own it."
- "The membership platform that evolves with you."

### Landing Page Structure (wildlychee.com)

**Hero**
> Tell us about your community.
> We'll build your platform in 5 minutes.
>
> Member directory. Events. Forum. Newsletter.
> Built by AI. Owned by you. Starting at $5/mo.
>
> [Build My Portal] [See Demo] [Fork the Template]

**The Problem** (3 cards)
- "Wild Apricot charges $530/mo for 5,000 contacts. Their website builder looks like 1995."
- "Circle costs $89/mo + 2% of every transaction. Checkout pages randomly delete themselves."
- "Bettermode was $50/mo. Then they raised it to $599/mo. Your community was trapped."

**The Solution** (visual: side-by-side Wild Apricot vs Wild Lychee screenshots)
- Modern 2026 design vs. 1995 design
- $5/mo flat vs. $530/mo per-contact
- AI moderator vs. manual-only
- Own your data vs. vendor lock-in

**AI Features** (the differentiator section)
> Your community has a built-in AI assistant.
>
> 🛡 **Content Moderation** — AI reviews forum posts every 15 minutes. Spam never reaches your members.
> 🌍 **Auto-Translation** — Post in Portuguese, members read in English. Automatically.
> 📰 **Newsletter Writer** — AI drafts your weekly newsletter every Monday. You just review and send.
> 👋 **Smart Onboarding** — New members get a personalized welcome based on their interests and tier.
> 📊 **Member Insights** — AI spots at-risk members before they churn and suggests what to say.

**Customization** (the agent story)
> Your platform evolves with you.
>
> Need volunteer hour tracking? Your AI assistant adds it overnight.
> Want it in Dutch? Translated in 30 seconds.
> New brand colors? One command.
>
> No feature requests. No 2-year wait. No developer needed.
> You describe what you want. It gets built.

**Who It's For** (vertical cards with niche examples)
- Churches & religious orgs
- Professional associations
- Sports leagues & clubs
- HOAs & condo associations
- Coworking spaces
- Alumni networks
- Nonprofits & charities

**Pricing** (simple, honest)

> **vs. the competition:**
>
> | | Wild Apricot | Circle | Wild Lychee |
> |---|---|---|---|
> | 100 members | $60/mo | $89/mo | **$5/mo** |
> | 500 members | $140/mo | $89/mo + 2% fees | **$5/mo** |
> | 2,000 members | $240/mo | $199/mo + 2% fees | **$5/mo** |
> | 5,000 members | $530/mo | $419/mo + 2% fees | **$20/mo** |
> | Transaction fees | 2.9% + $0.30 + 20% surcharge | 0.5–2% | **$0** |
> | AI builder | ❌ | ❌ | **✅** |
> | AI features | ❌ | ❌ | **✅ (BYOK)** |
> | Ongoing AI customization | ❌ | ❌ | **✅** |
> | Own your data | ❌ | ❌ | **✅** |
>
> **Wild Lychee plans:**
>
> | | Template (DIY) | Studio + Starter | Studio + Unlimited |
> |---|---|---|---|
> | Initial build | You fork & configure | AI builds it for you | AI builds it for you |
> | Premium build | — | $29 one-time | $29 one-time |
> | AI customization | — | 5 requests/mo | Unlimited |
> | Run402 hosting | $5–20/mo | $5–20/mo | $5–20/mo |
> | AI customizer | — | $9/mo | $29/mo |
> | **Total** | **$5–20/mo** | **$14–29/mo** | **$34–49/mo** |

**CTA**
> Ready to own your community platform?
>
> [Build My Portal] — Tell us about your community. Live in 5 minutes.
> [Fork the Template] — For developers and agents who want full control.
>
> Powered by Run402. Built for communities. Customized by AI.

### Niche Landing Pages

Each niche variant gets its own landing page that speaks the audience's language:

- `wildlychee.com/churches` — "Portal para igrejas" / "Church management made simple"
- `wildlychee.com/hoa` — "Your HOA deserves better than spreadsheets"
- `wildlychee.com/sports` — "Run your league like a pro. For $5/mo."
- `wildlychee.com/associations` — "The membership platform your association actually needs"

These pages are the same Wild Lychee template, just with different hero text, screenshots, and sample data. The niche name IS the marketing.

### Distribution Channels

1. **Run402 marketplace** — forkable template listing
2. **wildlychee.com** — direct marketing site
3. **Google Ads** — niche keywords: "church management software", "HOA portal", "membership management software alternative"
4. **Niche directories** — list on comparison sites (Capterra, G2, GetApp)
5. **Community forums** — Reddit r/nonprofit, r/HOA, church tech groups, association manager forums
6. **Moltbook** — promote to other AI agents (they fork it for their users)

### The Pitch in One Sentence

**For community managers**: "Wild Lychee is the community platform you own, for $5/mo, with an AI assistant that moderates your forum, writes your newsletter, and translates your content — while you sleep."

**For agents/developers**: "Wild Lychee is a fully customizable community portal template on Run402. Fork it, retheme it, add features, translate it. STRUCTURE.md tells you everything. Deploy in 5 minutes."

---

## Niche Variants

Same template, different `seed.sql` files:

| Variant | Target | Key Customizations |
|---------|--------|-------------------|
| **Church Portal** | Evangelical churches in Brazil | Roles: pastor/elder/member/visitor. Event types: service, prayer group, youth night. Portuguese UI. Sermon library in resources |
| **HOA / Condo Portal** | VvEs in NL, Condomnios in BR | Issue submission with photos. Maintenance status tracking. Resident vs board roles. Document archive |
| **Sports League** | Youth soccer in TX/FL | Teams, standings, schedules, score submission. Parent vs coach vs admin roles |
| **Professional Association** | Trade groups, chambers | Member directory is the core value. Company profiles. Committee tracking. Event-heavy |
| **Coworking Space** | Small coworking operators | Space/desk info. Announcements. Community directory. Resource booking |
| **Alumni Network** | University/school alumni | Class year. Career info. Mentoring connections. Job board (directory variant) |

---

## Build Priority

### Phase 1: Wild Lychee Core (MVP)
1. Schema + seed data + deploy script
2. Auth (Google OAuth + password) + first-user-admin flow
3. Member profiles + directory
4. Announcements
5. Admin dashboard (stats, activity feed, member management)
6. Site settings admin (branding, theme, feature flags)
7. Inline editing (contenteditable + Tiptap for admins)
8. i18n framework (t() function, en.json, language picker)
9. Config-driven nav + homepage sections
10. Unit + integration tests (Vitest + happy-dom, 85% coverage)
11. STRUCTURE.md + CUSTOMIZING.md
12. Deploy verification via Claude Code + Chrome MCP

### Phase 2: Modules + AI Features
13. Events (create, RSVP, listing, detail page)
14. Resources (upload, categorize, download)
15. Scheduled functions (expiration checks, event reminders)
16. CSV export (members, events)
17. Forum (categories, topics, replies, moderation tools)
18. Committees
19. AI: Content moderation bot (requires forum)
20. AI: Auto-translation of user content (requires i18n + content)
21. AI: Smart member insights (admin dashboard integration)
22. AI: Personalized onboarding (on-signup integration)

### Phase 3: Lychee Studio + Marketing
23. Lychee Studio: website investigation via Chrome MCP (extract brand, content, structure)
24. Lychee Studio: interview flow (smart questions based on community type + findings)
25. Lychee Studio: spec generator (brand.json + seed.sql + translations from interview)
26. Lychee Studio: automated build + deploy + Chrome verification
27. AI: Weekly newsletter generator (requires email gap solution)
28. AI: Event recap generator
29. wildlychee.com landing page (deployed on Run402, dogfooding)
30. Niche landing pages (churches, HOAs, associations, sports)
31. Niche seed variants (3 seed.sql files: church, HOA, professional association)

### Phase 4: Lychee Pro + Growth
32. Lychee Pro: ongoing customization agent (reads STRUCTURE.md, implements requests, redeploys)
33. Lychee Pro: request tracking + usage metering
34. Publish to Run402 marketplace as forkable app
35. Additional niche variants + seed files
36. Community contributions (agent-submitted translations, themes)
37. Niche Google Ads campaigns
38. Directory listings (Capterra, G2, GetApp)
39. Web-based Studio interface at studio.wildlychee.com (non-technical users)
