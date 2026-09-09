<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Avantra — project rules

Middleware is **`src/proxy.ts`**, not `middleware.ts`.

## The invariant that matters most

Avantra is a dispatch **agency**, not a broker and not an asset carrier. Two
money flows, and conflating them is the expensive bug:

| Table | Who pays whom | Whose money |
|---|---|---|
| `invoices` | broker → **client carrier** (or their factor) | **not ours** — we only bill and chase it |
| `client_statements` | **client** → Avantra | **ours** — this is the revenue |

A load's `gross_total` belongs to the client. `dispatch_fee` is Avantra's cut,
`net_to_client` is what the carrier keeps. There is no margin — we never buy and
resell a load, which is what keeps this an agency rather than unlicensed
brokering. A broker invoice is issued **in the client's name, under their
authority** (see `buildClientInvoiceParty()` in `src/lib/billing.ts`); Avantra
appears only as the preparing agent.

## Things that will bite you

- **`computeFee()` in `src/lib/dispatch.ts` mirrors the `recalc_load_money()` SQL
  trigger line for line.** The DB is the source of truth; the TS copy exists only
  so a booking form can preview before saving. Change one, change the other.
- **Never write `gross_total`, `dispatch_fee` (unless `fee_manual`), or
  `net_to_client` from app code** — the trigger owns them. `/api/protected/update`
  strips them.
- **Fee terms are snapshotted onto each load at booking.** Changing a client's
  plan must never rewrite a load that already happened, or a sent statement
  silently changes.
- **Role changes cannot go through the browser client.**
  `prevent_profile_privilege_escalation()` pins `profiles.role`,
  `is_master_admin`, `client_id` and `mfa_enrolled` against any non-service-role
  write. Use `/api/users`; 2FA enrollment goes through `/api/auth/mfa-enrolled`,
  which verifies the factor with Supabase rather than trusting the caller.
  `client_id` is the tenancy key — unpinned, it let any signup read another
  carrier's entire book.
- **Money writes are enforced by column privileges, not just by UI flags.**
  Migration 10 revokes `update` on the fee columns of `loads` and on all of
  `invoices` / `client_statements` from `authenticated`. A hidden button is not
  a control: RLS here is `for all using (is_staff())`, which is true for
  dispatcher and sales too. Write these through `updateProtectedRow()` →
  `/api/protected/update`, which re-checks table + column + role server-side.
  Payments go through `record_statement_payment()` / `record_invoice_payment()`,
  which accumulate atomically and check the role themselves.
  A browser `.update()` against those columns now fails — that is the point.
- **Fee terms are pinned at booking by `pin_load_fee_terms()`**, not just by the
  form. Column privileges cover UPDATE but say nothing about INSERT, so without
  it a dispatcher could simply book at `fee_percent` 0. It sorts before
  `trg_loads_money` on purpose — `recalc_load_money()` must see the pinned
  values.
- **A voided statement's fee lines must release their loads.**
  `statement_lines.voided` is maintained by trigger, and both the unique index
  and the generator's scan ignore released lines. Without it, voiding a
  statement made those loads permanently unbillable.
- **The `documents` bucket is private.** Read only via `/api/doc-url` →
  `DocLink` / `DocumentsPanel`. Never `getPublicUrl`.
- **The public `/track/<token>` page must never expose money.** It reads through
  whitelisting SECURITY DEFINER RPCs; keep rates out of them.
- **`STAFF_ROLES` in `src/lib/access.ts` must mirror `public.is_staff()` in
  migration 01.** Server routes gate on the TS list, RLS gates on the SQL
  function; drift between them is a security hole.

## House conventions

- Add/edit forms are **wide right-side sheets**: `!w-[75vw] !max-w-[900px]`.
  Never narrow dialogs.
- Status vocabularies, colors, and money formatting live in `src/lib/dispatch.ts`.
  Don't redefine them per page.
- List pages: KPI tiles that double as one-click filters, `SortableTh` + `useSort`,
  CSV export, `logAudit` on every write.
- Migrations are the schema of record, in `supabase/migrations/`, numbered and
  idempotent, RLS enabled with explicit policies on every table. Regenerate
  `supabase/setup.sql` after adding one — don't hand-edit it.

## Build gate

`npm run typecheck` **and** `npm run build` must both pass before every push.

`npm run lint` currently reports ~39 `react-hooks/set-state-in-effect` errors.
These are the codebase-wide "fetch in an effect, setState with the result"
pattern inherited from the shared skeleton (they fire in `theme-context`,
`use-mobile`, and `audit` too, none of which this project wrote). Lint is **not**
in the build gate for that reason. Don't add new lint classes on top; if you
refactor the data-fetching pattern, do it everywhere at once.
