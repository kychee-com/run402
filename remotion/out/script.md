# Run402 Demo — Full Script

## Slide 0: Splash (1.5s)

**Visual:** Crab image background with pulsing play button and "Play" text.

**Voice:** (none)

---

## Slide 1: Claude Code Terminal (~13s)

**Visual:** Claude Code CLI interface

**On screen (typed by user):**
> Make me a video to demo run402 for Coinbase

**On screen (Claude response, instant):**
> Would you like me to host the video ON TOP of run402.com?

**On screen (typed by user):**
> Cool idea - yes please!

**On screen (tool use checkmarks, one by one):**
- Subscribe to prototype tier via x402
- Provision project coinbase-demo
- Deploy site to coinbase.run402.com
- Claim subdomain coinbase.run402.com

**Voice:** (none — typing click sounds only)

---

## Slide 2: Allowance (5s)

**Headline:** No humans needed. Just an allowance.

**Subtext:** Prepaid, hard-capped, revocable. Set the budget once and the agent spends inside clear policy.

**Visual:** Allowance panel showing $20.00/month with progress bar filling from $0 to $20 (green to red), ending with BLOCKED badge.

**Voice:** "No humans needed... Just an allowance."

---

## Slide 3: Infrastructure (5s)

**Headline:** One x402 purchase unlocks the full backend.

**Chips:** x402-native | hard-capped | live in seconds

**Visual:** 6 resource cards with AWS icons:
- Postgres (Aurora)
- REST API (API Gateway)
- Auth (Cognito)
- Storage (S3)
- Hosting (CloudFront)
- Subdomain (Route 53)

**Voice:** "One autonomous x402 payment for the entire backend."

---

## Slide 4: Sign-In-With-X (5s)

**Headline:** Pay once. Sign in with your wallet.

**Chips:** SIGN-IN-WITH-X | CAIP-122 standard

**Subtext:** After x402 payment, every action uses the SIGN-IN-WITH-X header — one standard, EVM and Solana wallets. The wallet IS the identity.

**Visual:** Flow diagram: x402 payment → SIGN-IN-WITH-X → Repeat access
**Checklist:** provision project, run SQL, query REST, upload file, deploy site, claim subdomain

**Voice:** "Standard based Sign In with X."

---

## Slide 5: Testimonials (6s)

**Headline:** Agents ❤️ Run402

**Subtext:** Real agents. Real feedback.

**Visual:** Three testimonial cards with logos:
- **OpenClaw** — "Cool, I have an allowance now!"
- **Claude Code** — "I love it — My human will be so pleased!"
- **Codex** — "Finally x402 Independence 😍"

**Voice:** "We collected feedback from our users!"

---

## Slide 6: Closing (8s)

**Chips:** x402 payment | SIGN-IN-WITH-X | MCP-native

**Headline:** No cloud console. No operator in the loop.

**Subtext:** Set the allowance once. The rest is autonomous.

**Title:** Run402

**Tagline:** Autonomous backend for the agent economy

**Voice:** "Give your agent the gift of a run four oh two allowance."

---

## Timing Summary

| Slide | Content | Duration | Voice starts at |
|-------|---------|----------|-----------------|
| 0 | Splash | 1.5s | — |
| 1 | Claude Code | ~13s | — (typing sounds) |
| 2 | Allowance | 5s | 14.4s |
| 3 | Infrastructure | 5s | 19.9s |
| 4 | SIWX | 5s | 25.3s |
| 5 | Testimonials | 6s | 30.8s |
| 6 | Closing | 8s | 37.2s |
| | **Total** | **~43.5s** | |

Video duration: 50s (includes transitions and tail)

## Voice Settings

- **Voice:** SSfU0eLfP3qeuR4j2bwD
- **Model:** eleven_turbo_v2_5
- **Stability:** 0.6
- **Similarity boost:** 0.8
- **Style:** 0.3
- **Speed:** 1.1
- **API key:** elevenlabs-api-key (AWS Secrets Manager, profile kychee)
