# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-24T10:19:03.033241
**Completed**: 2026-03-24T10:35:49.157716
**Status**: completed

---

Short version: **AgentMail is selling a hosted mailbox API**, not just “SES with an endpoint.” For Run402, I’d start **much narrower**: **project-scoped transactional mail / invite mailboxes**, not arbitrary general-purpose inboxes.

## 1) What AgentMail seems to be doing

Based on the product surface you gathered, their API is centered around these resources:

- **Inboxes** — create/manage mailbox identities for agents
- **Messages** — send, receive, list, read, archive/delete
- **Threads** — conversation grouping
- **Drafts** — create/review/schedule before send
- **Labels** — organize mail for workflows
- **Lists** — allowlists/blocklists
- **Attachments**
- **Domains** — custom domain verification + SPF/DKIM/DMARC setup
- **Webhooks / WebSockets** — delivery, bounce, complaint, inbox events
- **Pods** — tenant / workspace isolation
- **API keys & permissions** — scoped access

That tells you their real value prop:

> **“Mailbox semantics for agents”**  
> not just outbound email delivery.

### AgentMail pricing

| Tier | Cost | Inboxes | Emails/Month | Storage | Custom Domains | Notes |
|---|---:|---:|---:|---:|---:|---|
| Free | $0 | 3 | 3,000 | 3 GB | — | basic |
| Developer | $20/mo | 10 | 10,000 | 10 GB | 10 | email support |
| Startup | $200/mo | 150 | 150,000 | 150 GB | 150 | Slack, dedicated IPs, SOC 2 |
| Enterprise | Custom | Custom | Custom | Custom | Custom | white-label, BYO cloud |

### Strategic takeaway from AgentMail
They’re not trying to be “SMTP for AI.” They’re trying to be **“Gmail API for agents.”**

So if you build on SES, the question is:

- Do you want **full inbox infrastructure** like AgentMail?
- Or do you want **safe, bounded app email** for invites / auth / support / notifications?

For Run402, I think the second is much better initially.

---

## 2) My recommendation for Run402

### Don’t start with arbitrary `something@run402.com`
I would **not** let untrusted projects create arbitrary root-domain mailboxes like:

- `admin@run402.com`
- `info@run402.com`
- `tal@run402.com`
- `barry@run402.com`

Even with a stoplist, root-domain addresses are:

- flat/scarce namespace
- brand-sensitive
- harder to reserve safely
- more likely to be abused or impersonate you
- risky if you ever want human/company mail there

### Better options

| Scheme | Example | My take |
|---|---|---|
| Root mailbox | `myapp@run402.com` | **Avoid for MVP** |
| Project subdomain mailbox | `invite@myapp.run402.com` | **Good** |
| Dedicated mail subdomain | `myapp@mail.run402.com` | **Best MVP** |

### Best MVP shape
I’d launch with:

- **1 mailbox per project**
- **managed address only**
- **HTTP API only**
- **no SMTP/IMAP**
- **template-oriented outbound**
- **reply-only or allowlist inbound**

Examples:

- `myapp@mail.run402.com`
- or `invite@myapp.run402.com`

If you want the simplest operationally, use:

> **`<project-slug>@mail.run402.com`**

That gives you:

- one verified SES domain
- easy inbound routing
- isolation from your root brand mail
- no giant root stoplist problem

---

## 3) Product shape I’d ship first

### Phase 1: “Project Mail” not “Hosted Email”
This is the simplest thing that matches your use case:

- invite users to a project
- send auth / magic links / notifications
- receive replies from those users
- hard cap everything
- no bulk mail

### Strong constraints for MVP
I’d make these **non-negotiable** at first:

- **1 primary mailbox per project**
- **No arbitrary aliases**
- **No attachments outbound**
- **No CC / BCC**
- **1 recipient per send**
- **Template-based sends only**
- **Receive only from:**
  - prior recipients
  - explicit allowlist
  - or same thread participants

That gives you an email feature without becoming a spam platform.

---

## 4) Abuse prevention: the important part

Your instinct to rate-limit aggressively is right. I’d go further.

### Recommended abuse controls

#### Outbound
- **Template-only** initially
  - `project_invite`
  - `magic_link`
  - `password_reset`
  - `project_notification`
- **Max 1 recipient per API call**
- **No CC/BCC**
- **Low daily cap**
- **Low monthly cap**
- **Unique-recipient cap**
- **No arbitrary HTML at first**
- **No attachments**
- **Only links to**
  - the project’s Run402 URL
  - or verified project custom domains

#### Inbound
- Default inbound mode should be:
  - **`reply_only`**
  - or **`allowlist_only`**
- Reject/drop mail from unknown senders
- Use SES spam/virus scanning
- Store verdicts on the message record

#### Reputation / compliance
- Global suppression list
- Project-level suppression list
- Auto-suspend on:
  - first complaint, or
  - a few hard bounces
- Manual review to re-enable
- Reserve/own `abuse@` and `postmaster@`

### A simple trust ladder
You could also do:

- **Level 0**: template-only, 10–25/day
- **Level 1**: more volume after healthy history
- **Level 2**: custom domains / freer sending after review

That’s much safer than “everyone gets a mailbox.”

---

## 5) I like “1 per project” — but namespace matters

Your idea of **one per project** is good.

### Best version
Use the **project** as the tenancy boundary, not individual free-form addresses.

That means:

- mailbox is tied to `project_id`
- lifecycle tied to project lease
- usage tied to project billing/allowance
- auth uses the project `service_key`

### Even better: plus-addressing for workflows
Instead of many aliases, use a single mailbox plus tags:

- `myapp@mail.run402.com`
- `myapp+invite@mail.run402.com`
- `myapp+support@mail.run402.com`
- `myapp+thread_abc123@mail.run402.com`

That lets you route internally without exposing unlimited new addresses.

---

## 6) Stoplist: yes, but ideally need less of it

If you let users choose arbitrary local parts, you need a large reserved set.

### Root-domain reserved local parts
At minimum reserve these at `@run402.com`:

**RFC / abuse / infra**
- `abuse`
- `postmaster`
- `hostmaster`
- `webmaster`
- `mailer-daemon`
- `bounce`
- `bounces`
- `smtp`
- `imap`
- `pop`
- `mx`
- `dkim`
- `dmarc`

**Platform / company**
- `admin`
- `info`
- `support`
- `help`
- `hello`
- `contact`
- `sales`
- `billing`
- `accounts`
- `legal`
- `privacy`
- `security`
- `press`
- `media`
- `jobs`
- `careers`
- `team`
- `ops`
- `status`
- `api`
- `docs`
- `dashboard`
- `run402`
- `agentdb`

**People / impersonation**
- `tal`
- `barry`
- founder/staff names
- `ceo`
- `founder`
- `owner`
- `finance`
- `payroll`
- `hr`

### But the better solution is:
**don’t let users choose root-domain local parts at all.**

If the public mailbox is `myapp@mail.run402.com`, your stoplist burden drops a lot.

---

## 7) SES architecture that fits Run402

Important point: **SES is transport + receive hooks**, not inbox storage.

So if you build this, you still need your own mailbox layer.

### Outbound
- Verify SES identity for:
  - **`mail.run402.com`** for MVP
- Enable:
  - DKIM
  - SPF
  - DMARC
- Use SES config sets for:
  - delivery
  - bounce
  - complaint
  - reject events
- Send from gateway or a mail worker

### Inbound
Use this flow:

1. **MX** for `mail.run402.com` or `*.mail.run402.com` -> SES inbound
2. SES receipt rule ->
   - S3 raw MIME storage
   - Lambda parse/validate
3. Lambda:
   - validates recipient exists
   - enforces allowlist/reply-only policy
   - parses MIME
   - stores metadata in Postgres
   - stores raw/attachments in S3
4. Optional webhook fan-out to project endpoints

### Storage model
- **Postgres**: mailbox, threads, message metadata, usage, suppression lists
- **S3**: raw MIME and attachments

### Eventing
- SES -> SNS/EventBridge
- update message state in DB
- trigger webhooks

### Specific Run402 note
Your current infra says **no NAT Gateway**. So if ECS/private workloads call SES directly, make sure that sender path has egress. In practice you may prefer:
- a Lambda mail worker, or
- whatever path in your stack already has internet/AWS service access

Also: your ACM wildcard cert is not really relevant here; the useful part is that you already control **Route 53**.

---

## 8) Suggested API shape for Run402

I’d keep it small.

### Mailboxes
- `POST /v1/mailboxes`
- `GET /v1/mailboxes`
- `GET /v1/mailboxes/:id`
- `DELETE /v1/mailboxes/:id`

### Messages
- `POST /v1/mailboxes/:id/messages`
- `GET /v1/mailboxes/:id/messages`
- `GET /v1/mailboxes/:id/messages/:messageId`

### Policy
- `POST /v1/mailboxes/:id/allowlist`
- `DELETE /v1/mailboxes/:id/allowlist/:entry`
- `POST /v1/mailboxes/:id/webhooks`

### Example send payload
```json
{
  "template": "project_invite",
  "to": ["user@example.com"],
  "variables": {
    "project_name": "Workout Tracker",
    "invite_url": "https://myapp.run402.com/invite/abc"
  }
}
```

### Response should include limits
Return:

- address
- current tier
- daily/monthly send caps
- inbound policy
- current usage
- storage used

This fits Run402’s “bounded, payable, machine-native” model.

And when a project hits its cap:

> return **402 Payment Required** with a top-up quote

That is very on-brand for Run402.

---

## 9) Two important product/security differences from subdomains

### 1. Don’t recycle email addresses quickly
This is a big one.

Unlike subdomains, **email addresses should not be easily reassigned**.

If `myapp@mail.run402.com` is deleted and later reused, the new owner may get:
- password resets
- delayed replies
- invoices
- private mail

So I’d do:

- long tombstone period
- maybe permanent non-reuse for premium/root aliases

### 2. Forks should get new mailboxes
For forkable apps:

- do **not** clone mailbox identity
- do **not** clone inbound mail
- mint a fresh mailbox for the fork

---

## 10) What I would actually build first

If I were you, I’d ship this in order:

### MVP-0
**Auth / invite email only**
- no mailbox creation yet
- fixed sender
- transactional templates only

### MVP-1
**1 project mailbox**
- `myapp@mail.run402.com`
- send invites + notifications
- receive replies only
- hard caps
- webhook events

### MVP-2
**Aliases + custom domains**
- allow a small alias set
- domain verification via SES + Route 53
- still strong abuse controls

### MVP-3
If demand is real:
- threads
- labels
- search
- richer inbox semantics

Not before.

---

## Bottom line

My strongest recommendations:

1. **Do not start with arbitrary `something@run402.com`**
2. **Use project-scoped addresses**, ideally under **`mail.run402.com`**
3. **One mailbox per project** is a very good MVP
4. **Template-only + reply-only** keeps you out of spam hell
5. **SES is fine**, but remember you still have to build the mailbox layer
6. **AgentMail’s lesson** is that the value is the inbox abstraction, not email transport

If you want, I can next draft a concrete:
- Postgres schema
- Express route design
- SES/Route53 setup plan
- reserved-name list
- abuse/rate-limit policy matrix for Prototype/Hobby/Team tiers

---
**Wall time**: 16m 46s
**Tokens**: 3,282 input, 25,868 output (22,979 reasoning), 29,150 total
**Estimated cost**: $4.7547
