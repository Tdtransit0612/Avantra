import type { SupabaseClient } from '@supabase/supabase-js'
import type { Client, FactoringCompany } from '@/types'

// ── Billing identity + remittance config ────────────────────────────────────
// Avantra prints TWO fundamentally different documents, and getting the payee
// wrong on either one sends money to the wrong company:
//
//   1. BROKER INVOICE — issued in our CLIENT CARRIER's name, under their MC/DOT,
//      for freight they hauled. Remit-to is the CLIENT (or, when the receivable
//      has been assigned, their FACTOR). Avantra is never the payee here; we
//      appear only as the preparing agent in the footer. Building this from
//      company_settings — the way a brokerage would — would have brokers paying
//      Avantra for freight it has no authority to haul or bill.
//
//   2. CLIENT FEE STATEMENT — issued in AVANTRA's name, for dispatch fees the
//      client owes us. Remit-to is Avantra, from company_settings.
//
// `InvoiceSettings.company` therefore means "the party this document is issued
// FROM", not "Avantra". Use buildClientInvoiceParty() for (1) and
// fetchCompanySettings() for (2).

export type AchInfo = { bank: string; routing: string; account: string; accountName: string }

export type RemitInfo = {
  payee: string
  remitAddress: string
  ach: AchInfo | null
  terms: string
}

// company_settings.billing_settings jsonb (all optional; blank → use fallback).
export type BillingSettings = {
  ach_bank?: string | null
  ach_routing?: string | null
  ach_account?: string | null
  ach_account_name?: string | null
  check_payee?: string | null
  remit_address?: string | null
  payment_terms?: string | null
}

// Where a factored receivable must actually be paid.
export type FactoringSettings = {
  company?: string | null
  remit_address?: string | null
  rate?: number | null      // factoring fee %
  advance?: number | null   // advance %
}

// Legal identity for a document header / authority line / footer.
export type CompanyIdentity = { name: string; mc: string; dot: string; addressLine: string }

// Everything a printed document needs.
export type InvoiceSettings = {
  /** The party the document is issued FROM (a client carrier, or Avantra). */
  company: CompanyIdentity
  billing: BillingSettings | null
  factoring: FactoringSettings | null
  /** Avantra, when it prepared the document on someone else's behalf. */
  preparedBy?: CompanyIdentity | null
}

const DEFAULT_TERMS = 'Net 30 days from invoice date'

// Ultimate fallback so a document never renders a blank payee/header. MC/DOT/
// address are intentionally empty rather than fabricated — a wrong authority
// number on a freight invoice is worse than none at all.
export const DEFAULT_COMPANY_IDENTITY: CompanyIdentity = {
  name: 'Avantra Carrier Services',
  mc: '',
  dot: '',
  addressLine: '',
}

const s = (v: unknown): string => String(v ?? '').trim()

// Normalize an MC / USDOT number to a labeled form if the user typed bare digits.
const fmtMc = (v: string): string => (!v ? '' : /^mc/i.test(v) ? v : `MC-${v}`)
const fmtDot = (v: string): string => (!v ? '' : /^(usdot|dot)/i.test(v) ? v : `USDOT ${v}`)

const joinAddress = (address: unknown, city: unknown, state: unknown, zip: unknown): string => {
  const cityStateZip = [s(city), [s(state), s(zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return [s(address), cityStateZip].filter(Boolean).join(', ')
}

// Build Avantra's own identity from the company_settings row.
function toCompanyIdentity(row: Record<string, unknown> | null): CompanyIdentity {
  if (!row) return DEFAULT_COMPANY_IDENTITY
  const ident: Record<string, unknown> = (row.company_identity && typeof row.company_identity === 'object'
    ? (row.company_identity as Record<string, unknown>)
    : {})
  const addressLine = joinAddress(ident.address, ident.city, ident.state, ident.zip)
  return {
    name: s(ident.name) || s(row.company_name) || DEFAULT_COMPANY_IDENTITY.name,
    mc: fmtMc(s(ident.mc_number)) || DEFAULT_COMPANY_IDENTITY.mc,
    dot: fmtDot(s(ident.dot_number)) || DEFAULT_COMPANY_IDENTITY.dot,
    addressLine: addressLine || DEFAULT_COMPANY_IDENTITY.addressLine,
  }
}

/** A client carrier's identity, for invoices issued in THEIR name. */
export function toClientIdentity(client: Pick<Client,
  'legal_name' | 'dba_name' | 'mc_number' | 'dot_number' | 'address' | 'city' | 'state' | 'zip'
> | null): CompanyIdentity {
  if (!client) return { name: '', mc: '', dot: '', addressLine: '' }
  const name = s(client.dba_name) || s(client.legal_name)
  return {
    name,
    mc: fmtMc(s(client.mc_number)),
    dot: fmtDot(s(client.dot_number)),
    addressLine: joinAddress(client.address, client.city, client.state, client.zip),
  }
}

/**
 * Load Avantra's own identity + billing settings from the company_settings
 * singleton. Use for FEE STATEMENTS (money owed to us), never for a broker
 * invoice. Returns defaults on any error so a document never breaks. NEVER throws.
 */
export async function fetchCompanySettings(supabase: SupabaseClient): Promise<InvoiceSettings> {
  try {
    // select('*') so a not-yet-migrated jsonb column can't error the query.
    const { data, error } = await supabase.from('company_settings').select('*').limit(1).maybeSingle()
    if (error || !data) return { company: DEFAULT_COMPANY_IDENTITY, billing: null, factoring: null }
    const row = data as Record<string, unknown>
    return {
      company: toCompanyIdentity(row),
      billing: (row.billing_settings as BillingSettings | null) ?? null,
      factoring: null,
    }
  } catch (e) {
    console.warn('[billing] fetchCompanySettings failed, using defaults:', e instanceof Error ? e.message : e)
    return { company: DEFAULT_COMPANY_IDENTITY, billing: null, factoring: null }
  }
}

/** Back-compat alias — statements are the document Avantra issues in its own name. */
export const fetchInvoiceSettings = fetchCompanySettings

/**
 * Build the settings for a BROKER INVOICE issued on a client's behalf: the
 * client is the issuing party and the payee, unless the invoice is factored, in
 * which case the factor is. Avantra rides along as `preparedBy` only.
 */
export function buildClientInvoiceParty(
  client: Client | null,
  factor: FactoringCompany | null,
  avantra: CompanyIdentity | null,
): InvoiceSettings {
  const identity = toClientIdentity(client)
  return {
    company: identity,
    billing: {
      check_payee: identity.name,
      remit_address: identity.addressLine,
      payment_terms: null,
    },
    factoring: factor
      ? { company: factor.name, remit_address: null, rate: factor.fee_percent, advance: factor.advance_rate }
      : null,
    preparedBy: avantra ?? null,
  }
}

/**
 * Build the remit-to block with a DB → env → identity fallback chain. ACH is
 * only surfaced when BOTH a routing and an account number resolve — a partial
 * ACH block is worse than none.
 *
 * IMPORTANT: this returns the payee for `settings.company`. For a factored
 * receivable the caller must suppress this block entirely and direct payment to
 * the factor (see remitInstructionsEmailHtml's factored branch) — the receivable
 * is legally assigned, so paying the carrier would not discharge the debt.
 */
export function getRemitInfo(settings?: InvoiceSettings | null): RemitInfo {
  const e = process.env
  const b = settings?.billing ?? {}
  const company = settings?.company ?? DEFAULT_COMPANY_IDENTITY
  const pick = (dbVal: unknown, envVal: string | undefined, def: string): string => s(dbVal) || s(envVal) || def

  const routing = s(b.ach_routing) || s(e.INVOICE_ACH_ROUTING)
  const account = s(b.ach_account) || s(e.INVOICE_ACH_ACCOUNT)
  const ach: AchInfo | null =
    routing && account
      ? {
          bank: s(b.ach_bank) || s(e.INVOICE_ACH_BANK),
          routing,
          account,
          accountName: pick(b.ach_account_name, e.INVOICE_ACH_ACCOUNT_NAME ?? e.INVOICE_CHECK_PAYEE, company.name),
        }
      : null

  const termsRaw = s(b.payment_terms) || s(e.INVOICE_PAYMENT_TERMS) || DEFAULT_TERMS
  const terms = /^net\s*\d+$/i.test(termsRaw) ? `${termsRaw} days from invoice date` : termsRaw

  return {
    payee: pick(b.check_payee, e.INVOICE_CHECK_PAYEE, company.name),
    remitAddress: pick(b.remit_address, e.INVOICE_REMIT_ADDRESS, company.addressLine),
    ach,
    terms,
  }
}

// Shared HTML-escaper for any user/DB value interpolated into transactional
// email HTML. Used across routes.
export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * "Payment Instructions" block for an invoice email. When the receivable is
 * factored, this directs payment to the FACTOR and never falls through to the
 * carrier's own ACH/check block — even if no factor name resolves.
 */
export function remitInstructionsEmailHtml(
  invoiceNum: string,
  opts?: { factored?: boolean; factor?: string | null; settings?: InvoiceSettings | null },
): string {
  if (opts?.factored) {
    const factorName = s(opts?.factor) || s(opts?.settings?.factoring?.company) || 'our assigned factor'
    return `
      <div style="margin-top:24px;padding:16px;background:#eef2ff;border-left:4px solid #4f46e5;border-radius:4px">
        <p style="margin:0 0 4px;font-size:13px;color:#312e81;font-weight:700">Payment Instructions</p>
        <p style="margin:0;font-size:13px;color:#3730a3">This invoice has been assigned to <strong>${escapeHtml(
          factorName,
        )}</strong>; please remit payment to them per their remittance instructions. Reference Invoice #${escapeHtml(
          invoiceNum,
        )} on all payments.</p>
      </div>`
  }
  const r = getRemitInfo(opts?.settings)
  const achRows = r.ach
    ? `<tr><td style="padding:3px 0;color:#6b7280;font-size:12px;vertical-align:top">ACH / Wire</td><td style="padding:3px 0;font-size:12px;color:#111827">${
        r.ach.bank ? escapeHtml(r.ach.bank) + ' &middot; ' : ''
      }Routing ${escapeHtml(r.ach.routing)} &middot; Account ${escapeHtml(
        r.ach.account,
      )}<br><span style="color:#6b7280">Account name: ${escapeHtml(r.ach.accountName)}</span></td></tr>`
    : ''
  return `
    <div style="margin-top:24px;padding:16px;background:#eef2ff;border-left:4px solid #4f46e5;border-radius:4px">
      <p style="margin:0 0 8px;font-size:13px;color:#312e81;font-weight:700">Payment Instructions</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:3px 0;color:#6b7280;font-size:12px;width:110px;vertical-align:top">Terms</td><td style="padding:3px 0;font-size:12px;color:#111827">${escapeHtml(
          r.terms,
        )}</td></tr>
        <tr><td style="padding:3px 0;color:#6b7280;font-size:12px;vertical-align:top">Make payable to</td><td style="padding:3px 0;font-size:12px;color:#111827">${escapeHtml(
          r.payee,
        )}</td></tr>
        ${r.remitAddress ? `<tr><td style="padding:3px 0;color:#6b7280;font-size:12px;vertical-align:top">Remit to</td><td style="padding:3px 0;font-size:12px;color:#111827">${escapeHtml(r.remitAddress)}</td></tr>` : ''}
        ${achRows}
      </table>
      <p style="margin:8px 0 0;font-size:11px;color:#6b7280">Reference Invoice #${escapeHtml(invoiceNum)} on all payments.</p>
    </div>`
}
