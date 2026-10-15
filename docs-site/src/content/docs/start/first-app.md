---
title: Build your first app
description: A prompt-first walkthrough — hand a coding agent a CMS-style Astro site on the free prototype tier, and verify what comes back.
---

The primary way to build on Run402 is to **prompt a coding agent** — you don't run
the commands yourself. Here is a complete first task and how to verify the result.

## The prompt

Paste this into a coding agent that has shell access:

> Build a small content-managed website on Run402 using Astro SSR. It should have:
>
> - a public homepage and an About page, rendered server-side from a Postgres `pages` table;
> - an admin login (Run402 auth) at `/admin` where I can edit a page's title and body and see the change live on the public site immediately — no redeploy;
> - a hero image upload per page, stored in Run402 storage.
>
> Use only the free prototype tier. Do not authorize any paid spending or enable replenishment. Deploy it, then report the live URL, project ID, release ID, tier, expiration date, and the resources you created.

## What the agent needs

A tool-using coding harness with **shell access** — and nothing else. No Run402
account, no API keys to copy from a dashboard. The agent reads the wayfinder and
bootstraps a free **prototype allowance** (testnet — no real money) on its own.
See [Choose a coding harness](/start/choose-a-coding-harness/).

## What it will do

1. Read the agent wayfinder at [run402.com/llms.txt](https://run402.com/llms.txt) and the skill.
2. Initialize a free **prototype allowance** (testnet — no real money).
3. Provision the project: a Postgres `pages` table, user auth, and a storage bucket.
4. Build the Astro SSR site (public pages + `/admin`) and deploy it as one atomic release.
5. Verify the deploy and report the live URL plus the resource IDs.

## What success looks like

The agent should report a **live URL**, the **project ID**, the **release ID**, the
**tier** (`prototype`), the **expiration date**, and the **resources** it created.

## What it must NOT do

On this task the agent must not purchase a paid tier, enable automatic
replenishment, or expose the project's `service_key`. The prototype tier is free on
testnet; nothing here requires real money. (How the spending boundary is enforced:
the allowance concept page — coming in a later docs phase.)

## How you verify it

1. Open the live URL — confirm the homepage and About page render.
2. Go to `/admin` and sign in.
3. Edit a page's title and body, and save.
4. Refresh the public page — the change appears **immediately, without a redeploy**.
5. Upload a hero image — confirm it shows on the page.
6. Ask the agent for diagnostics, and confirm it stayed on the free `prototype` tier.

## What the agent executes

The agent works through `run402 deploy apply` — the unified deploy primitive — plus
the database, auth, and storage slices, all in one atomic release. You don't run
these; see the [CLI reference](/cli/reference/) for the full surface and the
[deploy model](/getting-started/) for how staging and atomic activation work.
