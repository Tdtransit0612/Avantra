# Avantra Carrier Services

A purpose-built **dispatch service + carrier services** back office. Avantra owns
no trucks and holds no broker authority. Our **clients are motor carriers** —
owner-operators and small fleets. We act as their agent: source their freight,
dispatch it, handle the paperwork, invoice the broker in their name, chase the
money, and keep their compliance current. We bill them a **dispatch fee**.

Standalone project (own repo / Supabase / Vercel / domain). It reuses proven,
business-agnostic plumbing from the Cryolane and Top Dawg codebases (auth/RBAC,
signed-URL document security, cron-agent + Resend automation, pdf-lib generators,
the shadcn UI kit, the service-role write pattern) but the domain model is built
for **agency economics**, which run the opposite direction from a brokerage.

## The two money flows

Getting these backwards is the single most expensive mistake in this codebase, so
they live in separate tables and separate modules:

| Flow | Table | Who pays whom | Whose money |
|---|---|---|---|
| Freight | `invoices` | broker → **client carrier** (or their factor) | **Not ours.** We only bill and chase it. |
| Dispatch fee | `client_statements` | **client** → Avantra | **Ours.** This is the revenue. |

A load's `gross_total` belongs to the client. `dispatch_fee` is what Avantra
earns; `net_to_client` is what the carrier keeps. There is no "margin" here — we
never buy and resell a load, which is precisely what keeps this an agency
relationship rather than unlicensed brokering.

> Operating note, not legal advice: a dispatch service works under a signed
> dispatch agreement + limited power of attorney, invoicing in the carrier's name
> under their authority. `clients.agreement_signed_at` / `poa_signed_at` and the
> onboarding checklist exist to keep that paper trail real. Have counsel review
> the agreement before the first load.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind v4 ·
Supabase (Postgres / Auth / Storage / RLS) · Vercel · Resend · pdf-lib.

> **This is NOT the Next.js you know.** It is a heavily-versioned Next 16 —
> middleware is `src/proxy.ts` (not `middleware.ts`). Read `AGENTS.md` and the
> vendored guides in `node_modules/next/dist/docs/` before writing route /
> middleware / config code.

## Getting started

```bash
npm install
cp .env.local.example .env.local   # fill in Supabase + keys
npm run dev
```

Build gate: `npm run typecheck` (`tsc --noEmit`) **and** `npm run build` must pass
before every push. Deploy: `git push` → Vercel auto-deploys from `main`.

## Data model

- **clients** — the carriers we dispatch for. Authority, insurance, equipment,
  lane preferences, fee plan, factoring, onboarding checklist.
- **client_drivers / client_equipment** — their people and trucks, so the board
  can assign a real driver to a real load.
- **brokers** — counterparties we book with. Credit, days-to-pay, setup-packet
  state, do-not-use blocklist.
- **loads** — the fact table. Gross from the broker, dispatch fee to us, net to
  the client. Fee terms are *snapshotted* at booking so plan changes never
  rewrite history.
- **invoices / invoice_traces** — bill the broker; log every collection attempt.
- **client_statements / statement_lines** — bill the client for our fees.
- **compliance_items** — one generic expiry ledger: authority, COIs, IFTA, UCR,
  MCS-150, BOC-3, drug consortium, 2290, CDLs, medical cards.
- **service_requests** — the A-to-Z back-office work queue (new authority, IFTA
  filings, permits, disputes), optionally billable onto a statement.
- **documents** — private bucket, signed-URL access only.

Schema of record: real `CREATE TABLE` migrations in `supabase/migrations/`,
applied by hand in the Supabase SQL editor in filename order. RLS is enabled on
every table with explicit policies; `is_staff()` is the workhorse predicate and
`app_client_id()` scopes the (future) client portal.

## Phase plan

- **Phase 0 — Foundation:** auth/RBAC shell, UI kit, doc security, service-role
  write pattern, audit log.
- **Phase 1 — MVP:** clients + brokers + loads + dispatch board + assignment +
  check calls + public tracking + broker invoicing + invoice tracing + fee
  statements + compliance + service requests.
- **Phase 2 — Automation:** compliance watchdog + AR chaser crons, Resend email,
  rate-con and invoice PDFs, load-board intake.
- **Phase 3 — Scale:** client portal (carriers see their own loads, docs, and
  statements), e-signed agreements, factoring integrations, lane/rate analytics.
