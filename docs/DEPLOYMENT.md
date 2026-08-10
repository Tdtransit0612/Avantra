# Avantra — Deployment & Go-Live Runbook

Everything needed to take Avantra from "runs locally" to "deployed on a real
domain." Written to be turnkey.

## Current state

- ✅ **Code** — full Phase-1 app. `npm run typecheck` + `npm run build` green.
- ✅ **Schema** — 6 idempotent migrations in `supabase/migrations/`, plus a
  combined `supabase/setup.sql` that applies all of them in one paste.
- ⬜ **Supabase project** — not created yet. You create it; you own the keys.
- ⬜ **GitHub remote, Vercel project, custom domain.**
- ⬜ **Feature API keys** (Resend, Google Maps, FMCSA).

Nothing in this repo contains a credential. `.env.local` is gitignored; start
from `.env.local.example`.

---

## 1. Supabase

1. **supabase.com → New project.** Name it `avantra`. Pick a region close to
   you (`us-east-2` matches the other projects). Save the database password.
2. **SQL Editor → New query.** Paste the whole of `supabase/setup.sql` and Run.
   It is idempotent, so a re-run is safe if something half-applied.
3. Verify it took: Table Editor should show `clients`, `brokers`, `loads`,
   `invoices`, `client_statements`, `compliance_items`, `service_requests`,
   `documents`, and Storage should show a **private** `documents` bucket.
4. **Authentication → Providers → Email**: enable. Turn OFF public sign-ups once
   your own staff accounts exist, or leave on and rely on the `pending` role
   (new users land there with zero access until an admin promotes them).
5. **Create your admin account**: sign up through the app at `/login`, then in
   the SQL editor run — replacing the email —

   ```sql
   update public.profiles
      set role = 'admin', is_master_admin = true
    where email = 'you@example.com';
   ```

   The self-escalation trigger blocks this from the client, which is the point;
   the SQL editor runs as the service role and is allowed.

### Applying later migrations

New schema changes = a new dated file in `supabase/migrations/`, run in the SQL
editor in filename order. Then regenerate `supabase/setup.sql` by concatenating
the migrations — don't hand-edit it.

---

## 2. GitHub

```bash
cd C:/Users/adamg/Desktop/avantra
git remote add origin https://github.com/<you>/avantra.git
git branch -M main
git push -u origin main
```

Create the repo **empty** on github.com (no README/gitignore/license).

---

## 3. Vercel

1. **vercel.com → Add New → Project → Import** the `avantra` repo.
2. Framework preset: **Next.js** (auto-detected). Build command / output: defaults.
3. Add **Environment Variables** (§5) for Production and Preview.
4. **Deploy.** First build takes ~2 min.

> Deploy model: **`git push` → Vercel auto-deploys from `main`.** Never also run
> `vercel --prod` — it creates a duplicate deployment.

`vercel.json` currently declares no crons. The compliance watchdog and AR chaser
are Phase 2; add their routes before adding cron entries, or Vercel will hit a
404 on a schedule.

---

## 4. Domain

1. Vercel → the project → **Settings → Domains → Add** your domain.
2. At your registrar, add the DNS records Vercel shows.
3. Once it resolves, set `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_TRACK_BASE_URL`
   to the final `https://…` and redeploy. The tracking links you hand brokers are
   built from these, so they must be the real domain, not the `.vercel.app` host.

---

## 5. Environment variables

Set in **Vercel → Settings → Environment Variables**. `NEXT_PUBLIC_*` are exposed
to the browser (safe); everything else is server-only.

### Required (core app)
| Var | Value / source |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API → anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role (**SECRET**) |
| `NEXT_PUBLIC_APP_URL` | your deployed URL |

### Tracking
| Var | Value / source |
|---|---|
| `NEXT_PUBLIC_TRACK_BASE_URL` | usually same as `NEXT_PUBLIC_APP_URL` — base for public `/track/<token>` links |

### FMCSA authority lookup (free, recommended)
| Var | Value / source |
|---|---|
| `FMCSA_WEBKEY` | Free QCMobile web key: https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess . Without it the "Look up FMCSA" buttons return a clean "not configured" message and everything can still be entered by hand. |

### Email (Resend) — enables tracking-share and future AR/compliance mail
| Var | Value / source |
|---|---|
| `RESEND_API_KEY` | resend.com → API Keys |
| `RESEND_FROM_EMAIL` | e.g. `Avantra <dispatch@yourdomain.com>` — requires verifying the domain in Resend |

### Maps (address autocomplete + lane mileage)
| Var | Value / source |
|---|---|
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Google Cloud → Maps JS + Places API, referrer-restricted to your domain |
| `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` | optional, for styled maps |
| `GOOGLE_MAPS_API_KEY` | second, unrestricted server key for Distance Matrix |

### Cron / agents (Phase 2)
| Var | Value / source |
|---|---|
| `CRON_SECRET` | any long random string (`openssl rand -hex 32`) |
| `ANTHROPIC_API_KEY` | console.anthropic.com — only if rate-con parsing is turned on |

### Avantra's own remit details (fee statements only)
`INVOICE_CHECK_PAYEE`, `INVOICE_REMIT_ADDRESS`, `INVOICE_ACH_*`,
`INVOICE_PAYMENT_TERMS` — env fallbacks for Settings → Billing & Remit. These are
**Avantra's** banking details and appear only on client fee statements. Broker
invoices always remit to the client carrier or their factor.

---

## 6. Post-deploy verification

Drive the real app, in this order — it walks a load end to end:

1. `https://<domain>/login` → sign in → land on the dashboard.
2. **Settings → Company** — fill in Avantra's identity and remit details.
   **Settings → Dispatch Defaults** — set your standard fee %.
3. **Clients → New Client** — enter a real MC/DOT → **Look up FMCSA** → confirm
   authority prefills. Save, then open it and check the onboarding checklist
   seeded 12 steps. Add a driver and a truck.
4. **Brokers → New Broker** — add one, set the setup packet to Complete.
5. **Loads → Book Load** — pick the client and broker, enter a lane and a
   linehaul → confirm the live **gross / fee / net-to-client** preview, and that
   the pre-book warnings fire if the COI is expired or the packet is incomplete.
6. **Dispatch Board** — the load appears under "Booked". Try advancing it without
   a driver: it should refuse. Assign a driver on the load, then walk it through
   to Delivered, logging a check call along the way.
7. Open the **tracking link** in a private window — confirm it shows status and
   check-ins and **no money at all**.
8. **Invoicing → New Invoice** — pick the delivered load, confirm the bill-from
   is the *client carrier* (not Avantra) and the bill-to is the broker. Mark it
   sent, log a trace, record a payment. The load should flip to `paid`.
9. **Fee Statements → Generate Statement** — pick the client and the week that
   load delivered. Confirm the fee line appears at the amount the load showed.
   Generate again for the same period: the load must NOT appear twice.
10. **Compliance** and **Services** — confirm both list what you entered.
11. Hit `/api/health/resend` while signed in as staff to confirm email config.

---

## 7. Operational notes

- **Build gate:** `npm run typecheck` then `npm run build` before every push.
- **Documents** live in the private `documents` bucket — always served via signed
  URLs (`/api/doc-url`); never `getPublicUrl`.
- **Two money flows.** `invoices` = the broker paying our client.
  `client_statements` = our client paying us. Never merge them.
- **Fee terms are snapshotted onto each load at booking.** Changing a client's
  plan affects future loads only, by design — so a statement you already sent can
  never silently change.
- **Go-live (non-software) gates** before dispatching for a paying client: an
  EIN and business bank account; a written **dispatch service agreement** and
  **limited power of attorney** per client (the app tracks both); general
  liability / E&O insurance; and a conversation with counsel about how you're
  holding yourself out, so the agency relationship stays an agency relationship
  and not unlicensed brokering.
