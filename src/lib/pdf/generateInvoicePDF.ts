import { PDFDocument, rgb, StandardFonts, PDFPage, PDFFont } from 'pdf-lib'
import { getRemitInfo, DEFAULT_COMPANY_IDENTITY, type InvoiceSettings } from '@/lib/billing'

/* ─────────────────────────────────────────────────────────────────────────────
   Customer Invoice PDF  (Avantra brokerage — bill the shipper)
   ----------------------------------------------------------------------------
   A themed invoice rendered from the real `invoices` row (with its embedded load
   + customer), so the PDF matches what the office sees: true invoice number,
   amount, amount paid, balance due, due date, and — critically — the correct
   REMIT-TO party. Avantra is a BROKER: it bills the CUSTOMER (shipper) and the
   money it collects is Avantra's own revenue. When an invoice is factored,
   receivables are legally assigned to the factoring company, so the PDF prints a
   Notice of Assignment and remits to the factor instead of Avantra. Server-safe
   (pure pdf-lib) so it can run inside the email route and be attached to the
   outbound message. Mirrors the house style of the rate-con generator.
   ───────────────────────────────────────────────────────────────────────── */

/* ─── Company identity + remittance come from Settings → Company Information
   via @/lib/billing (getRemitInfo), falling back to DEFAULT_COMPANY_IDENTITY. ── */

/* ─── Colour palette (Avantra sky, replaces Top Dawg orange) ──────────────── */
const SKY     = rgb(0.008, 0.518, 0.780)   // #0284c7  (sky-600)
const SKYTINT = rgb(0.80, 0.92, 1)         // light band-subtext on the sky header
const WHITE   = rgb(1, 1, 1)
const DARK    = rgb(0.09, 0.09, 0.09)
const MID     = rgb(0.40, 0.40, 0.40)
const LIGHT   = rgb(0.62, 0.62, 0.62)
const GREEN   = rgb(0.086, 0.639, 0.290)
const RULE    = rgb(0.88, 0.88, 0.88)
const STRIPE  = rgb(0.975, 0.975, 0.975)

/* ─── WinAnsi safety (Helvetica can't draw arbitrary unicode) ──────────────── */
function safe(s: unknown): string {
  return String(s ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•·]/g, '-')
    .replace(/ /g, ' ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x09\x0a\x20-\x7e\xa0-\xff]/g, '')
}

function fmtMoney(n: number): string {
  return `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return ''
  const dt = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T12:00:00' : d)
  if (isNaN(dt.getTime())) return safe(d)
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/* ─── Inputs ───────────────────────────────────────────────────────────────
   The caller passes the real `invoices` row with its load and its BILL-TO party
   embedded (Supabase PostgREST embed or a JS stitch). Only the fields the PDF
   prints are typed here; extra columns on the row are ignored.

   Direction matters: this invoice is issued in our CLIENT CARRIER's name (that
   identity arrives via `settings.company` — build it with
   buildClientInvoiceParty()) and billed TO the BROKER (the `billTo` below).
   Getting those two backwards would bill our own client for their own freight. */
export interface InvoiceLoadForPDF {
  load_number: string | null
  line_haul: number | null
  fuel_surcharge: number | null
  accessorials: number | null
  detention: number | null
  lumper: number | null
  other_charges: number | null
  shipper_name: string | null
  consignee_name: string | null
  pickup_city: string | null
  pickup_state: string | null
  pickup_date: string | null
  delivery_city: string | null
  delivery_state: string | null
  delivery_date: string | null
  po_number: string | null
  bol_number: string | null
  ref_number: string | null
  miles: number | null
  commodity: string | null
  weight: number | null
}

/** The broker being billed. */
export interface InvoiceBillToForPDF {
  name: string | null
  billing_email: string | null
  billing_phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  payment_terms: string | null
}

export interface InvoiceForPDF {
  invoice_number: string | null
  amount: number | null
  amount_paid: number | null
  due_date: string | null
  status: string | null
  created_at: string | null
  issued_date: string | null
  sent_at: string | null
  /** Receivable assigned to a factor — remit must point there, not at the carrier. */
  factored_at: string | null
  factoring_company_name: string | null
  load?: InvoiceLoadForPDF | null
  billTo?: InvoiceBillToForPDF | null
}

/* ─── Defensive views over @/lib/billing return shapes ──────────────────────
   billing.ts is authored by a sibling agent; accept either the {payee,
   remitAddress,terms,ach} shape or a {lines[],ach} shape without a TS break. ── */
interface AchLike { bank?: string | null; routing?: string | null; account?: string | null; accountName?: string | null }
interface RemitInfoLike { lines?: string[]; payee?: string; remitAddress?: string; terms?: string; ach?: AchLike | null }
interface CompanyIdentityLike { name?: string; mc?: string; dot?: string; addressLine?: string }

/* ─── Drawing helpers ─────────────────────────────────────────────────────── */
function hRule(page: PDFPage, x: number, y: number, width: number) {
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.5, color: RULE })
}

function section(page: PDFPage, boldFont: PDFFont, x: number, y: number, title: string, pageWidth: number) {
  page.drawRectangle({ x: x - 4, y: y - 2, width: pageWidth - (x - 4) * 2, height: 14, color: STRIPE })
  page.drawRectangle({ x: x - 4, y: y - 2, width: 3, height: 14, color: SKY })
  page.drawText(safe(title).toUpperCase(), { x: x + 4, y, font: boldFont, size: 7.5, color: MID })
  return y - 22
}

/* ─── Main export ─────────────────────────────────────────────────────────── */
export async function generateInvoicePDF(
  invoice: InvoiceForPDF,
  settings?: InvoiceSettings | null,
): Promise<Uint8Array> {
  const company = ((settings?.company as CompanyIdentityLike | undefined) ?? DEFAULT_COMPANY_IDENTITY) as CompanyIdentityLike
  const remit = getRemitInfo(settings) as RemitInfoLike
  const load = invoice.load ?? null
  const customer = invoice.billTo ?? null

  const doc = await PDFDocument.create()
  const font     = await doc.embedFont(StandardFonts.Helvetica)
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold)

  const W = 612, H = 792
  const ML = 48, MR = W - 48, BODY_W = MR - ML
  const COL2 = ML + 140

  const invoiceNum = invoice.invoice_number || 'N/A'
  doc.setTitle(`Invoice ${safe(invoiceNum)}`)
  doc.setProducer('Avantra')

  const amount        = Number(invoice.amount) || 0
  const paid          = Number(invoice.amount_paid) || 0
  const fuelSurcharge = Number(load?.fuel_surcharge) || 0
  const accessorials  = Number(load?.accessorials) || 0
  const detention     = Number(load?.detention) || 0
  const lumper        = Number(load?.lumper) || 0
  const otherCharges  = Number(load?.other_charges) || 0
  // Print each component as its own line. Back the linehaul out of the invoiced
  // amount rather than reading load.line_haul directly, so a hand-adjusted
  // invoice total still foots against the lines shown.
  const linehaul = Math.max(0, amount - fuelSurcharge - accessorials - detention - lumper - otherCharges)
  // A receivable is factored once it's been assigned — even if no factor name was
  // captured — because payment to the carrier would not discharge the debt.
  const factored = !!invoice.factored_at
  const factorName = safe(
    invoice.factoring_company_name ||
    settings?.factoring?.company ||
    'Assigned Factor',
  )
  // On a factored invoice, amount_paid holds the FACTOR's advance to the carrier —
  // it is not a broker payment. The broker still owes the full amount to the
  // factor, so it must not be credited against the broker-facing balance.
  const customerPaid = factored ? 0 : paid
  const balance = Math.max(0, amount - customerPaid)

  const invDate = fmtDate(invoice.issued_date || invoice.sent_at || invoice.created_at) || fmtDate(new Date().toISOString())
  const dueDate = fmtDate(invoice.due_date)
  const today   = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  const page = doc.addPage([W, H])

  /* ── Header band ─────────────────────────────────────────────────── */
  page.drawRectangle({ x: 0, y: H - 72, width: W, height: 72, color: SKY })
  page.drawText(safe(company.name || DEFAULT_COMPANY_IDENTITY.name), { x: ML, y: H - 36, font: boldFont, size: 20, color: WHITE })
  page.drawText('INVOICE', { x: ML, y: H - 55, font, size: 10, color: SKYTINT })

  // doc number / dates (top right)
  page.drawText('Invoice #', { x: MR - 190, y: H - 30, font, size: 8.5, color: SKYTINT })
  page.drawText(safe(invoiceNum), { x: MR - 190, y: H - 44, font: boldFont, size: 12, color: WHITE })
  page.drawText(`Invoice Date: ${invDate}`, { x: MR - 190, y: H - 58, font, size: 8, color: SKYTINT })
  if (dueDate) page.drawText(`Due: ${dueDate}`, { x: MR - 190, y: H - 68, font, size: 8, color: SKYTINT })

  // company authority / address line under band (join only the parts we have —
  // a broker may carry an MC but no USDOT)
  let y = H - 88
  const authLine = [company.mc, company.dot, company.addressLine].map(v => safe(v)).filter(Boolean).join('  -  ')
  if (authLine) { page.drawText(authLine, { x: ML, y, font, size: 8, color: MID }); y -= 18 }
  else y -= 6

  /* ── Bill To  /  Remit To (two columns) ──────────────────────────── */
  const colR = ML + BODY_W / 2 + 10
  page.drawText('BILL TO', { x: ML, y, font: boldFont, size: 7.5, color: LIGHT })
  page.drawText('REMIT PAYMENT TO', { x: colR, y, font: boldFont, size: 7.5, color: LIGHT })
  let yL = y - 14, yR = y - 14

  // Bill To (the customer / shipper)
  page.drawText(safe(customer?.name || 'Customer'), { x: ML, y: yL, font: boldFont, size: 11, color: DARK }); yL -= 13
  const custAddr1 = safe(customer?.address || '')
  if (custAddr1) { page.drawText(custAddr1, { x: ML, y: yL, font, size: 8.5, color: MID }); yL -= 11 }
  const custCityLine = [safe(customer?.city), [safe(customer?.state), safe(customer?.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  if (custCityLine) { page.drawText(custCityLine, { x: ML, y: yL, font, size: 8.5, color: MID }); yL -= 11 }
  if (customer?.billing_email) { page.drawText(safe(customer.billing_email), { x: ML, y: yL, font, size: 8.5, color: MID }); yL -= 11 }
  if (customer?.billing_phone) { page.drawText(safe(customer.billing_phone), { x: ML, y: yL, font, size: 8.5, color: MID }); yL -= 11 }

  // Remit To (factor when assigned, else Avantra)
  if (factored) {
    page.drawText(factorName, { x: colR, y: yR, font: boldFont, size: 11, color: DARK }); yR -= 13
    page.drawText('(Assigned — see Notice of Assignment below)', { x: colR, y: yR, font, size: 7.5, color: MID }); yR -= 12
  } else {
    const payee = safe(remit.payee || company.name || DEFAULT_COMPANY_IDENTITY.name)
    page.drawText(payee, { x: colR, y: yR, font: boldFont, size: 11, color: DARK }); yR -= 13
    // Prefer explicit remit lines[] if billing.ts provides them, else the single address line.
    const remitLines = (remit.lines && remit.lines.length)
      ? remit.lines
      : [remit.remitAddress || company.addressLine || DEFAULT_COMPANY_IDENTITY.addressLine]
    for (const rl of remitLines) {
      const t = safe(rl)
      if (!t) continue
      page.drawText(t, { x: colR, y: yR, font, size: 8, color: MID }); yR -= 11
    }
  }

  y = Math.min(yL, yR) - 6
  hRule(page, ML, y, BODY_W)
  y -= 16

  /* ── Load reference ──────────────────────────────────────────────── */
  y = section(page, boldFont, ML, y, 'Load Reference', W)
  const route = load && (load.pickup_city || load.delivery_city)
    ? `${safe(load.pickup_city)}, ${safe(load.pickup_state)} -> ${safe(load.delivery_city)}, ${safe(load.delivery_state)}`
    : '—'
  const refRows: [string, string][] = [
    ['Load #',    safe(load?.load_number || '—')],
    ['Route',     route],
    ['Shipper',   safe(load?.shipper_name || '—')],
    ['Consignee', safe(load?.consignee_name || '—')],
    ['BOL #',     safe(load?.bol_number || '—')],
    ['PO #',      safe(load?.po_number || '—')],
    ['Ref #',     safe(load?.ref_number || '—')],
  ]
  refRows.forEach(([lbl, val], i) => {
    if (i % 2 === 0) page.drawRectangle({ x: ML - 4, y: y - 3, width: BODY_W + 8, height: 16, color: STRIPE })
    page.drawText(lbl, { x: ML, y, font, size: 9, color: MID })
    page.drawText(val, { x: COL2, y, font: boldFont, size: 9, color: DARK, maxWidth: MR - COL2 })
    y -= 18
  })
  y -= 4
  hRule(page, ML, y, BODY_W)
  y -= 16

  /* ── Charges ─────────────────────────────────────────────────────── */
  y = section(page, boldFont, ML, y, 'Charges', W)

  const charge = (label: string, value: number, stripe: boolean) => {
    if (stripe) page.drawRectangle({ x: ML - 4, y: y - 3, width: BODY_W + 8, height: 18, color: STRIPE })
    page.drawText(safe(label), { x: ML, y: y + 1, font, size: 9.5, color: DARK })
    const v = fmtMoney(value)
    const vw = boldFont.widthOfTextAtSize(v, 9.5)
    page.drawText(v, { x: MR - vw, y: y + 1, font: boldFont, size: 9.5, color: DARK })
    y -= 22
  }

  charge('Line Haul / Freight Charge', linehaul, true)
  if (fuelSurcharge > 0) charge('Fuel Surcharge', fuelSurcharge, false)
  if (accessorials > 0) charge('Accessorials', accessorials, false)

  hRule(page, ML, y + 6, BODY_W)
  y -= 2

  // Invoice total
  const drawTotalRow = (label: string, value: string, color = DARK, bold = true) => {
    page.drawText(safe(label), { x: ML, y, font: bold ? boldFont : font, size: 9.5, color: MID })
    const f = bold ? boldFont : font
    const vw = f.widthOfTextAtSize(value, 9.5)
    page.drawText(value, { x: MR - vw, y, font: f, size: 9.5, color })
    y -= 18
  }
  drawTotalRow('Invoice Total', fmtMoney(amount))
  if (customerPaid > 0) drawTotalRow('Amount Paid', `-${fmtMoney(customerPaid)}`, GREEN)

  y -= 2
  // Balance-due box (sky)
  page.drawRectangle({ x: ML - 4, y: y - 24, width: BODY_W + 8, height: 28, color: SKY })
  page.drawText(customerPaid > 0 ? 'BALANCE DUE' : 'TOTAL DUE', { x: ML + 4, y: y - 14, font: boldFont, size: 10, color: WHITE })
  const balStr = fmtMoney(balance)
  const balW = boldFont.widthOfTextAtSize(balStr, 14)
  page.drawText(balStr, { x: MR - balW - 6, y: y - 15, font: boldFont, size: 14, color: WHITE })
  y -= 44

  /* ── Payment Instructions  /  Notice of Assignment ───────────────── */
  const terms = safe(remit.terms || customer?.payment_terms || 'Net 30 days from invoice date')
  if (factored) {
    // Assigned to a factor: terms line + the legal Notice of Assignment. Avantra's
    // own ACH/check are intentionally suppressed — payment goes to the factor.
    const termsLine = `Payment Terms: ${terms}. Please reference Invoice # ${safe(invoiceNum)} on all payments.`
    page.drawText(termsLine, { x: ML, y, font, size: 7.5, color: MID, maxWidth: BODY_W })
    y -= 16
    page.drawText('NOTICE OF ASSIGNMENT', { x: ML, y, font: boldFont, size: 7.5, color: DARK })
    y -= 11
    const noa = `This account/invoice has been assigned, sold and transferred to ${factorName} to whom payment must be made. Payment to any other party does not discharge this obligation.`
    const words = noa.split(/\s+/)
    let line = ''
    for (const w of words) {
      const test = line ? `${line} ${w}` : w
      if (font.widthOfTextAtSize(test, 7.5) > BODY_W && line) {
        page.drawText(line, { x: ML, y, font, size: 7.5, color: MID }); y -= 10; line = w
      } else line = test
    }
    if (line) { page.drawText(line, { x: ML, y, font, size: 7.5, color: MID }); y -= 12 }
  } else {
    y = section(page, boldFont, ML, y, 'Payment Instructions', W)
    const payee = safe(remit.payee || company.name || DEFAULT_COMPANY_IDENTITY.name)
    const remitAddr = safe(
      (remit.lines && remit.lines.length ? remit.lines.join(', ') : remit.remitAddress) ||
      company.addressLine || DEFAULT_COMPANY_IDENTITY.addressLine,
    )
    const piRows: [string, string][] = [
      ['Terms', terms],
      ['Pay by Check', `Payable to ${payee}`],
      ['Mail Checks To', remitAddr],
    ]
    if (remit.ach && (remit.ach.routing || remit.ach.account)) {
      if (remit.ach.bank) piRows.push(['ACH / Wire Bank', safe(remit.ach.bank)])
      if (remit.ach.routing) piRows.push(['Routing Number', safe(remit.ach.routing)])
      if (remit.ach.account) piRows.push(['Account Number', safe(remit.ach.account)])
      if (remit.ach.accountName) piRows.push(['Account Name', safe(remit.ach.accountName)])
    }
    piRows.forEach(([lbl, val], i) => {
      if (i % 2 === 0) page.drawRectangle({ x: ML - 4, y: y - 3, width: BODY_W + 8, height: 16, color: STRIPE })
      page.drawText(lbl, { x: ML, y, font, size: 9, color: MID })
      page.drawText(safe(val), { x: COL2, y, font: boldFont, size: 9, color: DARK, maxWidth: MR - COL2 })
      y -= 18
    })
    y -= 2
    page.drawText(safe(`Please reference Invoice # ${invoiceNum} on all payments.`), { x: ML, y, font, size: 7.5, color: MID })
    y -= 14
  }

  /* ── Footer ──────────────────────────────────────────────────────── */
  page.drawRectangle({ x: 0, y: 0, width: W, height: 36, color: STRIPE })
  hRule(page, 0, 36, W)
  const footL = [safe(company.name || DEFAULT_COMPANY_IDENTITY.name), safe(company.mc), 'Generated by Avantra']
    .filter(Boolean).join('  -  ')
  page.drawText(footL, { x: ML, y: 13, font, size: 7.5, color: LIGHT })
  page.drawText(today, { x: MR - 80, y: 13, font, size: 7.5, color: LIGHT })

  return doc.save()
}
