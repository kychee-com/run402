# SaaS-Killing Segments: Ranked

Free MIT-licensed repos, designed to run on run402, that kill SaaS subscriptions. Each repo is a trojan horse for run402 infrastructure adoption.

Ranked on market disruption potential, not current run402 capabilities. We build what we need to win the best niche.

## Scoring criteria

1. **Pricing outrage** — documented, citable, visceral complaints against incumbents. The Cloudflare "WordPress plugins are insecure" equivalent.
2. **Niche sharpness** — can we name a specific, findable, reachable segment that self-identifies instantly?
3. **Product simplicity** — does a non-technical person understand what it replaces in 5 seconds?
4. **Pain frequency** — daily/weekly pain or occasional annoyance?
5. **Switching cost** — how trapped are current users? Low = easier to pull.
6. **Viral potential** — will users share this with peers? Does usage make run402 visible?
7. **TAM** — how big is the market being attacked?

---

## Tier 1 — Best Crossing the Chasm swings

These have the strongest combination of angry customers, sharp niches, simple products, and low switching costs.

### 1. Privacy-First Web Analytics (Google Analytics killer)

**Kill target:** Google Analytics, Plausible ($9/mo), Fathom ($15/mo)

**Top SaaS leaders:** Google Analytics (55% of all websites, ~$3.6B market), Plausible (15K paying subscribers), Fathom, Matomo (20K top-1M sites), Simple Analytics

**TAM:** Web analytics ~$5.4B (2025), projected $45B by 2032. Privacy analytics is the fastest-growing sub-segment.

**Pricing outrage:** This isn't a pricing play — it's a **fear play**, which is stronger. GA4 has been ruled illegal by data protection authorities in Austria, France, and Italy. A Cologne court confirmed this in August 2025. GDPR fines hit €1.2B across Europe in 2024, total penalties exceeding €5.88B since GDPR started. France's CNIL doubled enforcement actions to 87 in 2024. Multiple privacy orgs (noyb) filed 101 complaints against Google Analytics specifically. 40-50% of web traffic is invisible to GA due to ad blockers. One agency found a cookieless tool reported more than double the visitors compared to GA on the same site.

**Attack angle:** "Your website is breaking the law." This is the closest parallel to Cloudflare's WordPress security play. The wedge is fear and compliance, not price. Every web agency in Germany, France, and Netherlands needs a compliant analytics solution for every client site they manage.

**Niche targets:** EU web agencies (findable via agency directories), EU e-commerce businesses (findable via Shopify/WooCommerce communities), any EU business with a website that uses GA (nearly all of them).

**Why #1:** This is the only segment where the incumbent has a *legal vulnerability that cannot be fixed*. Google can't solve the core problem because US surveillance law is the issue. Plausible/Fathom prove paying demand exists. A free MIT repo undercuts even the privacy-first paid tools. And every installation makes run402 the invisible backend processing analytics data for a live website — persistent, ongoing infrastructure usage, not a one-time deploy.

---

### 2. Digital Product Sales (Gumroad killer)

**Kill target:** Gumroad, Lemon Squeezy, Payhip, Sellfy

**Top SaaS leaders:** Gumroad ($21M revenue 2023, 10% + $0.50/sale), Lemon Squeezy (acquired by Stripe), Payhip (5% free tier), Podia, Ko-fi

**TAM:** Digital goods platform market $5-10B. Creator economy platforms $100B+ total.

**Pricing outrage:** Nuclear. Gumroad takes a flat 10% + $0.50 per sale on top of payment processing fees (2.9% + $0.30). Marketplace sales through Gumroad Discover take 30%. Reddit: "Gumroad fees are insane." At $10K/month revenue, a creator loses ~$1,300 in fees. Recurring subscriptions don't transfer if you leave — you lose all your subscribers. Multiple users report delayed payouts and opaque account suspensions. The fee structure punishes success: the more you sell, the more Gumroad takes.

**Attack angle:** "Keep 100% of your sales. Gumroad takes 10% of every dollar you earn — this takes 0%." Every creator doing the math on their Gumroad dashboard feels this pain on every single sale.

**Niche targets:** Indie creators selling Notion templates on Twitter/X (extremely findable, extremely vocal about fees). UI kit designers. Ebook authors. Course creators. The entire "build in public" community on Twitter.

**Why #2:** The niche (indie creators on Twitter) is the most viral audience possible. They share tools publicly, write threads about their revenue, and compare platforms constantly. A free Gumroad alternative would spread through creator Twitter organically. The pain is felt on every transaction, not monthly. And the x402 payment angle is a natural extension — creators selling digital products via micropayments is philosophically aligned with run402's entire thesis.

---

### 3. Form Builder + Submissions (Typeform / Jotform killer)

**Kill target:** Typeform ($141M revenue), Jotform, Formstack, SurveyMonkey

**Top SaaS leaders:** Typeform ($141M revenue 2024, 130K customers), JotForm, SurveyMonkey, Formstack, Google Forms, Zoho Forms

**TAM:** Online form builder software ~$4.1B (2024), projected $9.5B by 2031 at 11.2% CAGR. Broader online survey software ~$4.7B (2025), projected $18B by 2035.

**Pricing outrage:** Typeform's free plan allows 10 responses per month — widely mocked as a "cruel joke." Basic plan ($29/mo) gives 100 responses across all forms. Removing the Typeform watermark requires the $59/mo plan. A basic redirect at the end of a form costs $700+/year. A Hacker News post titled "Typeform was too expensive so I built my own" (July 2025). Capterra reviews consistently: "love the product, hate the price tag." Community forums: "outrageously expensive." One reviewer: "buying a Ferrari to drive to the grocery store."

**Attack angle:** "Typeform gives you 10 free responses. This gives you unlimited." The pricing-per-response model is uniquely offensive because it charges for the most basic unit of value — someone filling out your form.

**Niche targets:** Freelancers collecting client intake forms (findable on r/freelance, r/webdev). Nonprofits collecting applications/donations (findable via nonprofit directories). Agencies building client sites that need forms (findable via agency directories). Event organizers collecting RSVPs. The niche skins write themselves: intake forms for cleaning companies, lead capture for contractors, application forms for nonprofits, RSVP forms for event planners.

**Why #3:** Broadest market of any segment. Every business, freelancer, nonprofit, and organization needs forms. Product concept is instantly understood. Near-zero switching cost — you're collecting responses, not migrating years of data. Pain is frequent (every lead, every survey, every intake). And the vertical skin strategy works perfectly: one form builder engine, dozens of niche-specific templates.

---

### 4. Scheduling / Booking (Calendly / Booksy killer)

**Kill target:** Calendly ($276M revenue), Booksy, Acuity Scheduling, Cal.com

**Top SaaS leaders:** Calendly ($276M revenue 2023, ~53% US market share, $3B valuation), Acuity Scheduling (Squarespace), Cal.com (open source), Doodle, Booksy, Fresha

**TAM:** Appointment scheduling software $546M (2025), projected $1.9B by 2034 at 14.7% CAGR. Broader estimates including healthcare/enterprise range to $16B.

**Pricing outrage:** Per-seat pricing that punishes team growth. A 10-person team on Calendly Teams pays $1,920/year. Essential features (automated reminders, team scheduling, CRM integrations) locked behind paid tiers. Reddit: "nickel-and-diming approach to core features." Calendly initially downgraded all existing users to a freemium plan without offering upgrades — customer backlash. Booksy charges €25/month per barber — 3 chairs = €900/year for a booking page. Google and Microsoft are bundling scheduling free, proving how commoditized the core product is.

**Attack angle:** Two angles depending on niche. For professionals/consultants: "Calendly charges per seat. This is free for your whole team." For barbershops/salons: "Booksy takes €25/month per chair. This is yours forever."

**Niche targets:** Barbershops (findable on Google Maps, massive market, zero loyalty to tools — the marketplace doc's #1 pick). Salons and spas. Coaches and consultants (live on Twitter/LinkedIn, share tools). Personal trainers. Cleaning services.

**Why #4:** Product concept is universally understood. Pain is daily — every appointment, every client interaction. The barbershop niche specifically is sharp, findable, and perfectly suited for localized versions ("App para barbearias" beats every English-only SaaS in Portuguese markets). Per-seat pricing creates mathematically obvious savings that are easy to communicate.

---

### 5. CRM / Sales Pipeline (HubSpot / Pipedrive killer)

**Kill target:** HubSpot, Pipedrive, HoneyBook, Dubsado

**Top SaaS leaders:** Salesforce (23.9% market share, ~$38B revenue), HubSpot (3.4% share, $2.6B revenue, 248K customers), Pipedrive, Zoho CRM, Freshworks, Monday CRM

**TAM:** CRM software ~$90-100B (2025), projected $260-300B by 2032-2035 at 12-13% CAGR. Largest TAM on this entire list.

**Pricing outrage:** HubSpot's free CRM is genuinely useful, but the jump to Professional is $800+/month for Marketing Hub. Users report feeling "locked in" — migrating CRM data is painful. HoneyBook/Dubsado charge $40+/month for solos. 20-70% of CRM projects fail, primarily due to poor user adoption and complexity. For a solo freelancer, paying $50-100+/month for what amounts to contacts + notes + deal stages is hard to justify.

**Attack angle:** "HubSpot Free is great until you need one more feature — then it's $800/month. This is free forever." For solos: "You don't need Salesforce. You need a contacts table with a pipeline view."

**Niche targets:** The vertical skin strategy is the weapon here. One codebase, many repos: Contractor CRM. Wedding Vendor CRM. Agency Client Tracker. Realtor Pipeline. Freelancer CRM. Each targets a Google search ("free CRM for contractors") and a findable community (contractor Facebook groups, wedding vendor directories, agency Slack communities). The marketplace doc's scoring validates: wedding vendors, cleaning companies, home services contractors all score ★★★ on niche-ability.

**Why #5:** Largest TAM on the list by far. The vertical skin strategy multiplies SEO surface area without multiplying engineering effort. CRM is "boring software people are tired of renting" — the exact category where self-hosted free alternatives win. Pain is daily (every lead, every client interaction). But ranked below forms/scheduling because switching cost is higher (existing pipeline data) and the product is inherently more complex to build.

---

## Tier 2 — Strong disruption potential, slightly weaker on one dimension

### 6. Feedback Board / Feature Voting (Canny killer)

**Kill target:** Canny ($79/mo), UserVoice, Nolt, Feature Upvote

**Top SaaS leaders:** Canny, UserVoice, Productboard, Nolt, Fider (open source)

**TAM:** Product feedback tools ~$1-2B, growing as part of product management software (~$20B by 2030).

**Pricing outrage:** Canny charges $79/month for what is architecturally a voting widget. Users submit ideas, others vote, you see what's popular. The product's simplicity makes the pricing feel particularly extractive.

**Attack angle:** "$79/month for a voting board. Really?"

**Niche targets:** SaaS founders and product managers — the exact demographic on Twitter, ProductHunt, Indie Hackers, and HN. They talk about their tools constantly. They are potential run402 customers for other products.

**Why Tier 2:** Smaller TAM. But the niche (SaaS founders/PMs) is the highest-value audience for run402's broader adoption. A free Canny alternative that gets 2,000 GitHub stars puts run402 in front of exactly the right people. It's a trojan horse for awareness, not just revenue.

---

### 7. Status Page (Statuspage / Instatus killer)

**Kill target:** Statuspage (Atlassian, $79/mo), Instatus, BetterStack

**Top SaaS leaders:** Statuspage (Atlassian), Instatus, BetterStack (formerly BetterUptime), Sorry

**TAM:** Status page specifically ~$500M-1B, subset of IT monitoring market ($40B+).

**Pricing outrage:** Atlassian charges $79/month for a page that shows colored dots. The product is so architecturally simple it's almost insulting.

**Attack angle:** "$79/month for a page with green dots. Deploy your own in 60 seconds."

**Niche targets:** Every YC startup, every SaaS company, every developer tool provider. Findable on ProductHunt, HN, SaaS directories. The exact demographic that discovers tools on GitHub.

**Why Tier 2:** Small TAM. But like the feedback board, the audience is developers and SaaS builders — run402's core awareness target. A free status page repo that deploys in one command is the kind of thing that gets shared on HN and generates organic GitHub stars. High viral potential, low market size.

---

### 8. Helpdesk / Support Ticketing (Freshdesk / Zendesk killer)

**Kill target:** Zendesk ($2.1B revenue), Freshdesk (Freshworks), Help Scout, Zoho Desk

**Top SaaS leaders:** Zendesk, Freshdesk, Help Scout, Zoho Desk, HubSpot Service Hub

**TAM:** Help desk software ~$12-15B (2025), projected $30B+ by 2032.

**Pricing outrage:** Zendesk starts at $19/agent/month and escalates to $115+/agent for enterprise. For a 5-person support team, that's $1,140-6,900/year for basic ticketing. Freshdesk has a free tier (up to 10 agents) which proves demand for cheaper alternatives.

**Attack angle:** "Zendesk charges per agent. Your support team shouldn't cost per head to help customers."

**Niche targets:** From the marketplace doc: IT support for schools, agency client request portals, internal helpdesk for small companies. The board/Trello app that already exists on run402 is structurally identical — tickets are cards, statuses are columns.

**Why Tier 2:** Large TAM, clear complaint pattern. But the product is more complex than forms or booking (needs email integration, assignment logic, SLA tracking to feel complete), and Freshdesk's free tier for 10 agents is hard to beat on pure price. The wedge has to be "own your data" and "no per-agent fees at scale."

---

### 9. Event Registration (Eventbrite killer)

**Kill target:** Eventbrite ($352M revenue), Luma, Splash

**Top SaaS leaders:** Eventbrite ($352M revenue 2024), Luma, Splash, Hopin

**TAM:** Event management software ~$6-8B (2025), projected $18B by 2032.

**Pricing outrage:** Eventbrite's fee structure: 3.7% + $1.79 per ticket for paid events. They started charging for free events too — betrayal of community organizers. For a 200-person paid event at $50/ticket, Eventbrite takes $1,098. For free events, organizers who used to pay nothing now pay.

**Attack angle:** "Eventbrite takes $5+ per ticket. Your community events shouldn't have a middleman."

**Niche targets:** Tech meetup organizers (findable on Meetup.com, Twitter). Workshop and conference hosts. The marketplace doc's mosque/cultural center angle: underserved, findable via directories, localization is a moat ("Moschee-Verwaltung" / "Event registration for mosques").

**Why Tier 2:** Strong complaint angle, clear niche. But events are inherently intermittent — people need this tool once a month or quarter, not daily. Lower pain frequency than forms or scheduling.

---

### 10. Invoice / Estimates Tracker (FreshBooks killer)

**Kill target:** FreshBooks ($180M+ revenue), QuickBooks, Wave (acquired), Zoho Invoice

**Top SaaS leaders:** FreshBooks, QuickBooks (Intuit), Wave (H&R Block), Zoho Invoice, Invoice Ninja (open source)

**TAM:** Invoicing software ~$6-8B (2025), part of broader accounting software (~$20B).

**Pricing outrage:** FreshBooks charges $17-55/month for basic invoicing. Wave was free but got acquired by H&R Block and is shifting model. QuickBooks starts at $30/month. For a freelancer sending 5-10 invoices a month, paying $200-660/year for what is essentially a PDF generator with a payment link feels steep.

**Attack angle:** "FreshBooks charges $17/month to send invoices. This is free."

**Niche targets:** Freelancers (r/freelance, freelancer communities). Contractors and trades (overlaps with CRM vertical skins). Consultants. The marketplace doc recommends folding this into "Business OS" variants rather than standalone — "Cleaning Company OS" includes invoicing alongside scheduling and job tracking.

**Why Tier 2:** Clear pain, large market. But invoicing is commoditized (Wave was free for years, Invoice Ninja is open source). The standalone wedge is weaker than bundling invoicing into vertical business apps. Best as a feature within CRM/Business OS skins, not a standalone repo.

---

### 11. Live Chat Widget (Intercom killer)

**Kill target:** Intercom ($300M+ revenue), Crisp, Drift (Salesloft), LiveChat

**Top SaaS leaders:** Intercom, Zendesk Chat, Crisp, Drift, LiveChat, Tawk.to (free)

**TAM:** Live chat software ~$1.1-1.5B (2025), projected $3B by 2032.

**Pricing outrage:** Intercom's pricing is infamously opaque. Starts at $39/seat/month, escalates quickly with add-ons. Known for aggressive upselling. Small businesses report bills jumping from $50 to $200+ without adding features. Tawk.to proved massive demand for a free alternative.

**Attack angle:** "Intercom's pricing page doesn't even show prices. That tells you everything. This is free, forever, on your own infrastructure."

**Niche targets:** E-commerce stores (Shopify apps directory). SaaS startups (HN, ProductHunt). Small business websites.

**Why Tier 2:** Strong anger at Intercom specifically, but Tawk.to already offers free live chat. The differentiation has to be "self-hosted, own your data, no Tawk.to branding." Needs real-time/websocket capability which is an infrastructure build.

---

### 12. Course / Cohort Portal (Teachable killer)

**Kill target:** Teachable ($40/mo + 5%), Thinkific, Kajabi ($200M+ ARR)

**Top SaaS leaders:** Teachable (Hotmart), Thinkific, Kajabi, Podia, LearnDash

**TAM:** Online education platforms ~$30-40B (2025), projected $100B+ by 2030.

**Pricing outrage:** Teachable charges $39/month on the basic plan PLUS a 5% transaction fee on every sale. Kajabi starts at $149/month. For a yoga teacher selling a $50 course to 20 students, Teachable takes $39 + $50 = $89/month in fees/subscription. The niche doc identifies yoga/pilates teachers, coaches, bootcamp runners as sharp targets.

**Attack angle:** "Teachable takes 5% of every course sale plus $39/month. Keep your earnings."

**Niche targets:** Yoga teachers (findable via Yoga Alliance directory, Instagram #yogateacher). Fitness coaches. Language tutors. The marketplace doc scores "Course / Cohort Portal for yoga/pilates teachers" as Tier 2 (★★☆ on Run402 fit due to video hosting concerns, ★★★ on marketing sharpness).

**Why Tier 2:** Large TAM, clear pricing complaint, sharp niches. But video hosting/streaming is a meaningful infrastructure challenge, and the product is more complex than forms or booking. The pain frequency is moderate — course creators set up once and maintain, rather than interacting daily.

---

### 13. Client Portal (Dubsado / HoneyBook killer)

**Kill target:** Dubsado, HoneyBook ($40/mo), Moxie, Plutio, SuiteDash

**Top SaaS leaders:** Dubsado, HoneyBook, Moxie (formerly Hectic), Plutio, SuiteDash, Copilot

**TAM:** Client portal software ~$1.5-2B, part of professional services automation (~$14B by 2028).

**Pricing outrage:** HoneyBook charges $40/month (or $400/year). Dubsado similarly priced. For freelancers and small agencies, this is the "project management + file sharing + invoicing" combo they need but resent paying for monthly.

**Attack angle:** "HoneyBook charges $40/month for a client portal. Fork this and own it."

**Niche targets:** Agencies sharing deliverables with clients. Freelance designers/developers. Accountants. Consultants. The marketplace doc scores "Client Portal" ★★★ on run402 fit (files = storage, projects = DB, client login = auth, status page = site).

**Why Tier 2:** Clear niche, good fit. But "client portal" is a compound product (file sharing + project tracking + invoicing + messaging) — harder to nail than a single-purpose tool. Best as a vertical variant: "Agency Client Portal" or "Freelancer Client Portal."

---

### 14. Newsletter / Mailing List (Mailchimp killer)

**Kill target:** Mailchimp ($800M+ revenue), ConvertKit (~$40M ARR), Beehiiv, Buttondown

**Top SaaS leaders:** Mailchimp (Intuit), ConvertKit, Substack, Buttondown, Beehiiv, Ghost, ActiveCampaign

**TAM:** Email marketing software ~$14-16B (2025), projected $35-40B by 2032 at ~13% CAGR.

**Pricing outrage:** Mailchimp eliminated its generous free tier after Intuit acquisition (was 2,000 contacts, now 500). Users on legacy plans were force-migrated to expensive new tiers. Many reported 2-3x price increases overnight. Interface bloated with features most small senders don't need.

**Attack angle:** "Mailchimp cut your free plan and doubled your price. Own your mailing list."

**Niche targets:** Small business owners sending basic newsletters. Bloggers. Community organizers. Indie creators who already have a list but hate Mailchimp's pricing trajectory.

**Why Tier 2:** Massive TAM, clear anger. But email deliverability is a deep infrastructure problem (IP reputation, SPF/DKIM/DMARC, bounce handling, ISP relationships). Building a form builder is a weekend; building email infrastructure that doesn't land in spam is months. The differentiation can't just be "free Mailchimp" — it has to solve deliverability, which is the actual hard problem.

---

### 15. Link-in-Bio Page (Linktree killer)

**Kill target:** Linktree ($37M revenue est., 50M users, $1.3B valuation), Beacons, Stan

**Top SaaS leaders:** Linktree, Beacons ($29M raised), Koji ($36M raised), Snipfeed, Stan

**TAM:** Subset of creator economy tools. Linktree's $37M from 50M users means most are free tier.

**Pricing outrage:** Mild. Linktree charges $5-24/month for features like analytics, custom branding, and link scheduling. Users report account locking for content they don't approve of. One user: "They spent weeks making my old client jump through hoops and STILL WILL NOT CLOSE THEIR ACCOUNT." 40+ competitors exist, showing low moat.

**Attack angle:** "A link-in-bio page is a single HTML file. Why are you paying monthly for it?"

**Niche targets:** Creators, influencers, small businesses. Findable everywhere on Instagram/TikTok (anyone with "linktr.ee" in their bio).

**Why Tier 2:** The product is so simple it barely needs a backend. An HTML page with some links is a static site. The attack angle is valid (why pay for HTML?) but the market is saturated with 40+ free/cheap alternatives. Low switching cost helps us but also helps every other competitor. Differentiation is hard.

---

## Tier 3 — Viable markets, weaker disruption angle

### 16. Blog / CMS (WordPress / Ghost killer)

**Top SaaS leaders:** WordPress.com (Automattic, ~$700M revenue), Ghost, Squarespace ($991M revenue), Wix ($1.7B revenue), Medium

**TAM:** CMS market ~$22-25B (2025), projected $50B+ by 2032. WordPress powers 43% of all websites.

**Pricing outrage:** WordPress plugin security — 97% of WP vulnerabilities come from plugins and themes. FBI/CISA advisories. This is the actual Cloudflare playbook.

**Why Tier 3:** Cloudflare is already executing this play with their own infrastructure advantage (CDN, edge compute, Workers). Competing with Cloudflare on their chosen battleground is a poor strategic choice. The market is enormous but the CMS problem is deep (rendering engine, theme system, rich text editing, media management, plugin ecosystem). Better to let Cloudflare fight WordPress and pick battles where nobody is attacking yet.

---

### 17. Waitlist + Referral System

**Top SaaS leaders:** LaunchList, Viral Loops, Prefinery, GetWaitlist

**TAM:** Niche, ~$200-500M as part of growth tools market.

**Pricing outrage:** Minimal documented outrage. These tools are cheap or have free tiers.

**Why Tier 3:** The marketplace doc correctly calls this: "great as a feature within other apps, weak standalone." It's a growth tool, not a business tool. Hard to niche by audience. Better as a module inside the form builder or event registration repos.

---

### 18. URL Shortener + Analytics (Bitly killer)

**Top SaaS leaders:** Bitly ($100M+ revenue est.), Rebrandly, Short.io, TinyURL, Dub.co

**TAM:** ~$500M-1B.

**Pricing outrage:** Bitly's free plan limits: 10 links/month, 2 QR codes. Paid plans start at $8/month.

**Why Tier 3:** Small TAM. The product is simple but the market is saturated. Dub.co is already an open-source Bitly alternative with traction. Not enough anger or market size to justify as a priority.

---

### 19. Testimonial Collector + Widget

**Top SaaS leaders:** Testimonial.to, Senja, TrustPilot, Yotpo

**TAM:** Online reputation management ~$5B.

**Pricing outrage:** Testimonial.to charges $50+/month for embedding customer quotes on your site.

**Why Tier 3:** Niche product, moderate pricing anger. Could work as a feature within the local business website template rather than a standalone repo.

---

### 20. Contact Form Backend (Formspree killer)

**Top SaaS leaders:** Formspree, FormSubmit, Basin, Getform, Web3Forms

**TAM:** Small, ~$500M-1B.

**Pricing outrage:** Formspree charges $8-40/month for what is essentially an HTTP endpoint that sends emails.

**Why Tier 3:** Architecturally trivial but also tiny market. Better absorbed into the form builder repo as a feature (form submissions that notify via email). Not worth a standalone repo.

---

### 21. Cookie Consent Manager

**Top SaaS leaders:** Cookiebot, OneTrust, CookieYes, Osano

**TAM:** Consent management platforms ~$500M-1B, growing fast due to GDPR.

**Pricing outrage:** $10-40/month for a JavaScript snippet that shows a banner. GDPR-driven captive market.

**Why Tier 3:** Interesting angle (compliance-driven, like analytics). But the product is a JS snippet with a preferences UI — barely needs a backend. Could be a companion to the analytics repo rather than standalone.

---

### 22. Webhook Inspector (RequestBin killer)

**Top SaaS leaders:** Pipedream (RequestBin), Webhook.site, Hookdeck

**TAM:** Niche, ~$200-500M.

**Pricing outrage:** Minimal. Webhook.site has a free tier. This is developer tooling, not business SaaS.

**Why Tier 3:** Tiny market, low pricing anger, developer-only audience. Could be useful as a run402 feature (debug webhooks in your project) rather than a standalone product.

---

### 23. Feature Flag Service (LaunchDarkly killer)

**Top SaaS leaders:** LaunchDarkly ($150M+ ARR est.), Split.io, Flagsmith (open source), Unleash (open source)

**TAM:** Feature management ~$1.5-2B (2025), projected $5B+ by 2030.

**Pricing outrage:** LaunchDarkly starts at $10/seat/month and scales aggressively. Many teams feel feature flags shouldn't be expensive SaaS.

**Why Tier 3:** Developer tooling, not business SaaS. Open-source alternatives already exist (Flagsmith, Unleash). The market isn't angry enough — LaunchDarkly's pricing is accepted as reasonable by most teams.

---

### 24. Membership / Gated Content — 🔨 IN PROCESS ([kychon](https://github.com/kychee-com/kychon))

**Top SaaS leaders:** Memberful ($49/mo + 4.9%), MemberSpace, Patreon, Ghost memberships

**TAM:** Membership management software ~$2-3B.

**Pricing outrage:** Memberful charges $49/month plus 4.9% transaction fee on Pro. Double-dipping.

**Why Tier 3:** Better as a vertical skin of other apps than standalone. The marketplace doc's "Church / Community Portal" and "Membership / Community Portal" are stronger framings. "Membership software" is too generic; "portal para igrejas evangélicas" is a real product.

---

### 25. Applicant Tracking / Hiring (Greenhouse killer)

**Top SaaS leaders:** Greenhouse, Lever, BambooHR, Workable, Recruitee

**TAM:** ATS market ~$3-4B (2025).

**Pricing outrage:** ATS pricing typically $400+/month. Way beyond what a 10-person company needs for occasional hiring.

**Why Tier 3:** The marketplace doc flags this correctly: "hiring is inherently seasonal/bursty — hard to retain." Users need it intensely for 2 months, then not at all for 6 months. Low pain frequency kills retention.

---

### 26. Time Tracker (Toggl killer)

**Top SaaS leaders:** Toggl ($20M+ ARR), Clockify (free), Harvest, Hubstaff

**TAM:** Time tracking software ~$1.5-2B.

**Pricing outrage:** Minimal. Clockify is already free and dominant. Toggl's paid features are nice-to-have, not must-have.

**Why Tier 3:** Clockify already killed this market from a pricing standpoint. A free alternative to a free product isn't a disruption play.

---

### 27. Landing Page Builder (Unbounce killer)

**Top SaaS leaders:** Unbounce ($70M+ revenue), Leadpages, Instapage, Carrd ($19/year)

**TAM:** Landing page builder ~$1-2B.

**Pricing outrage:** Unbounce charges $99+/month for landing pages. But Carrd already disrupted this at $19/year. The price anchor has been reset.

**Why Tier 3:** Carrd proved the market wants cheap landing pages — and delivered at $19/year. Competing with Carrd on price is a race to zero. The product is also essentially static HTML, barely needing a backend.

---

### 28. Donation / Tip Jar Page

**Top SaaS leaders:** Ko-fi (0% basic), Buy Me a Coffee (5%), PayPal.me, Stripe Payment Links

**TAM:** Creator monetization subset.

**Pricing outrage:** Mild. Ko-fi's free tier is genuinely free (0% on donations). Buy Me a Coffee takes 5%.

**Why Tier 3:** Ko-fi already offers 0% on basic donations. Hard to undercut free. Better as a feature within the digital product sales repo.

---

### 29. Forum / Discussion Board (Discourse killer)

**Top SaaS leaders:** Discourse ($50-300/mo hosted), Circle ($39-399/mo), Mighty Networks

**TAM:** Online community platforms ~$1-2B.

**Pricing outrage:** Discourse hosted at $50-300/month. Self-hosting requires significant ops.

**Why Tier 3:** Discourse is already open source (free to self-host). The complaint is about hosting complexity, not software licensing. A run402-hosted forum would compete with Discourse's hosted offering on price, but the community/content bootstrapping problem makes forums hard to seed.

---

### 30. Privacy Policy / Terms Generator

**Top SaaS leaders:** Termly, Iubenda, TermsFeed

**TAM:** Privacy compliance software ~$2-3B.

**Pricing outrage:** $10-50/month for templated legal documents.

**Why Tier 3:** Product is essentially a template with variables filled in. Barely needs a backend. Could be a one-time generator tool, not a SaaS-killing repo.

---

### 31. PTO / Leave Tracker

**Top SaaS leaders:** BambooHR, Timetastic, Calamari

**TAM:** Subset of HR software (~$25-30B).

**Pricing outrage:** Per-seat SaaS pricing for tracking who's on vacation.

**Why Tier 3:** Internal tool, low switching motivation. Teams use spreadsheets or their existing HR suite. Not enough standalone pain.

---

### 32. Quiz / Assessment Builder

**Top SaaS leaders:** Typeform, SurveyMonkey, Interact, ProProfs

**TAM:** Subset of online assessment market (~$6-8B).

**Pricing outrage:** Inherits Typeform complaints.

**Why Tier 3:** Better absorbed into the form builder. A quiz is just a form with scoring logic. Not a standalone repo.

---

### 33. Internal Wiki / Knowledge Base (Notion killer)

**Top SaaS leaders:** Notion, Confluence (Atlassian), Slite, Outline (open source)

**TAM:** Knowledge management software ~$18-22B.

**Pricing outrage:** Confluence pricing and complexity. But Notion's free tier is very generous.

**Why Tier 3:** Notion is hard to beat on free tier generosity and UX polish. Collaborative real-time editing is a deep technical problem. Outline already exists as open source. Not a strong disruption angle.

---

### 34. E-Signature (DocuSign killer)

**Top SaaS leaders:** DocuSign, HelloSign (Dropbox), PandaDoc

**TAM:** E-signature market ~$5-7B.

**Pricing outrage:** DocuSign charges $10-40/month per user. For occasional signers, this is steep.

**Why Tier 3:** Legal enforceability of e-signatures varies by jurisdiction. The trust/compliance dimension makes "free alternative" a harder sell than in other categories. Better as a feature within the client portal or invoicing repos.

---

## Tier 4 — Niche verticals (better as skins of Tier 1-2 repos)

These are real markets with real pain, but they're better served as vertical skins of the core repos above rather than standalone products.

| # | Vertical | Parent repo | Niche angle |
|---|---|---|---|
| 35 | Restaurant menu + ordering | Booking app | "DoorDash takes 30%. Own your ordering page." |
| 36 | Salon/barber booking | Booking app | "Booksy charges per chair. This is free." |
| 37 | Gym/fitness scheduler | Booking app | "Mindbody charges per member. This is free." |
| 38 | Pet sitter/dog walker booking | Booking app | "Rover takes 20%. Own your client list." |
| 39 | Photographer proofing gallery | Client portal | "Pixieset charges per gallery. Host your own." |
| 40 | Real estate listing page | CRM + site | "Zillow controls your leads. Own them." |
| 41 | Rental property manager | CRM | "Buildium is $50+/mo. Track your properties for free." |
| 42 | Employee directory | CRM | Internal tool, absorb into team portal |
| 43 | Inventory tracker | Business OS | "For makers/wholesalers who outgrew spreadsheets" |
| 44 | Home services business OS | CRM + invoicing | "Jobber charges $50/mo. Run your cleaning company for free." |
| 45 | Wedding vendor CRM | CRM | "HoneyBook charges $40/mo. Manage your couples for free." |
| 46 | Church / community portal — 🔨 IN PROCESS (kychon skin) | Membership + events | "Planning Center charges per member. Serve your congregation for free." |
| 47 | Content calendar | Board/kanban | "Planable charges $11/post. Plan your content for free." |
| 48 | Tournament / league manager | Events | "TeamSnap charges per team. Run your league for free." |
| 49 | Flashcard / spaced repetition | Course portal | Absorb into education vertical |
| 50 | Image gallery / portfolio | Static site + storage | Barely needs a backend |
| 51 | Social media link aggregator | Link-in-bio | Same product, different name |
| 52 | Coupon / promo code manager | E-commerce | Feature, not product |
| 53 | API key management dashboard | Developer tools | Internal tool |
| 54 | Cron job dashboard | Developer tools | Feature of run402 itself |
| 55 | Environment variable manager | Developer tools | Feature of run402 itself |
| 56 | Directory / marketplace listing | Site + DB | The marketplace doc warns: "value is in the data, not the software" |
| 57 | Virtual event check-in | Events | Feature of event registration |
| 58 | Conference schedule viewer | Events | Feature of event registration |
| 59 | File sharing / transfer | Storage + site | Product is S3 + a download page. Barely needs a repo. |
| 60 | Changelog / roadmap page | Static site | Feature of feedback board |
| 61 | Booking for coaches | Booking app | Vertical skin |
| 62 | Booking for cleaners | Booking app | Vertical skin |
| 63 | Mosque event registration | Events + membership | Vertical skin with localization |
| 64 | Nail salon website + booking | Booking + site | Vertical skin |
| 65 | Yoga course portal | Course portal | Vertical skin |

---

## Strategic summary

The top 5 repos, if built well, attack ~$120B+ in combined TAM:

| Priority | Repo | Primary kill target | Attack type | Combined TAM |
|---|---|---|---|---|
| 1 | Privacy-first analytics | Google Analytics | Fear (legal) | $5.4B |
| 2 | Digital product sales | Gumroad | Rage (per-sale fee) | $5-10B |
| 3 | Form builder | Typeform | Outrage (per-response fee) | $4.1B |
| 4 | Booking / scheduling | Calendly / Booksy | Math (per-seat) | $546M-16B |
| 5 | CRM (vertical skins) | HubSpot / HoneyBook | Cliff (free-to-$800 jump) | $90-100B |

Each one generates ongoing run402 infrastructure usage (database queries, storage, API calls) from real production workloads — not demo apps.

The vertical skin strategy (repos #35-65) multiplies the top 5 into 30+ GitHub repos targeting specific Google searches, with minimal additional engineering. One CRM codebase becomes "contractor-crm," "wedding-vendor-crm," "agency-client-tracker," "realtor-pipeline" — each a separate repo, README, and SEO target.

---

## Licensing strategy: why MIT

All SaaS-killing repos use the MIT license. The license creates zero friction — developers see MIT and stop thinking about licensing, which maximizes GitHub stars, forks, and deployments.

The lock-in is architectural, not legal: every repo is built natively around run402's SDK, auth, storage, database, and x402 payment hooks, so porting to another backend requires meaningful re-engineering that nobody will bother with when run402 is free and zero-signup.

Attribution happens through four channels:
1. **README** — opens with "Built on run402" and links to run402.com
2. **Default config files** — point to run402 endpoints
3. **Deploy scripts** — target run402
4. **Footer link** — a tasteful "Powered by run402" link included in every default template — easy to remove, but most users won't

We own the copyright on all repos, which means we can relicense future versions if a competitor ever strip-mines our code onto rival infrastructure at scale, exactly as MongoDB, Elastic, and Redis did when cloud providers became threats.

Until that day, MIT is the right call because we're not selling software — we're selling the invisible infrastructure underneath it, and every installation that stays on run402's defaults is a production workload generating real database queries, storage hits, and API calls.
