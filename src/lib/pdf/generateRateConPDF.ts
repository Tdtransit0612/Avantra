import { PDFDocument, rgb, StandardFonts, PDFPage, PDFFont } from 'pdf-lib'

/* ─── Avantra rate confirmation (BROKER → CARRIER) ───────────────────────────
 * The core brokerage document. Avantra is the BROKER; it books a load with a
 * shipper (customer) and tenders it to an outside CARRIER. This PDF confirms the
 * agreed rate WE PAY THE CARRIER (carrier_rate + any agreed accessorials) and the
 * broker-carrier terms. Pure pdf-lib, no network. Company identity is passed in
 * via opts (from company_settings → fetchInvoiceSettings) with a hardcoded
 * Avantra fallback so the doc never renders blank.
 * Adapted from Top Dawg's generateRateConPDF.ts. Brand = cool sky, NO orange.
 * ──────────────────────────────────────────────────────────────────────────── */

/* ─── Colour palette (Avantra sky) ───────────────────────────────────────── */
const SKY     = rgb(0.008, 0.518, 0.780)   // #0284c7 sky-600 (brand accent)
const SKYTINT = rgb(0.855, 0.933, 0.980)   // pale sky, for text on the sky band
const WHITE   = rgb(1, 1, 1)
const DARK    = rgb(0.09, 0.09, 0.09)
const MID     = rgb(0.40, 0.40, 0.40)
const LIGHT   = rgb(0.62, 0.62, 0.62)
const RULE    = rgb(0.88, 0.88, 0.88)
const STRIPE  = rgb(0.965, 0.977, 0.985)   // faint sky-tinted stripe

/* ─── WinAnsi sanitizer ───────────────────────────────────────────────────────
 * StandardFonts (Helvetica) are WinAnsi-encoded; drawing a char outside that
 * range throws. Map the common "smart" punctuation to ASCII and drop anything
 * else that WinAnsi can't represent, so untrusted DB text can never crash a PDF. */
function safe(v: unknown): string {
  return String(v ?? '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•·]/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '')
}

const money = (n: number | null | undefined): string =>
  `$${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const clip = (v: string, max: number): string => (v.length > max ? v.slice(0, max) + '…' : v)

/* ─── Drawing helpers ─────────────────────────────────────────────────────── */

function hRule(page: PDFPage, x: number, y: number, width: number) {
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.5, color: RULE })
}

function row(
  page: PDFPage,
  font: PDFFont, boldFont: PDFFont,
  y: number, x1: number, x2: number,
  label: string, value: string,
  bodyW: number,
  stripe = false,
) {
  if (stripe) page.drawRectangle({ x: x1 - 4, y: y - 3, width: bodyW + 8, height: 16, color: STRIPE })
  page.drawText(safe(label), { x: x1, y, font, size: 9, color: MID })
  page.drawText(safe(value) || '—', { x: x2, y, font: boldFont, size: 9, color: DARK })
}

function section(page: PDFPage, boldFont: PDFFont, x: number, y: number, title: string, pageWidth: number) {
  page.drawRectangle({ x: x - 4, y: y - 2, width: pageWidth - (x - 4) * 2, height: 14, color: STRIPE })
  page.drawRectangle({ x: x - 4, y: y - 2, width: 3, height: 14, color: SKY })
  page.drawText(safe(title).toUpperCase(), { x: x + 4, y, font: boldFont, size: 7.5, color: MID })
  return y - 22
}

/* ─── Public types ────────────────────────────────────────────────────────── */

/**
 * Structural subset of a Avantra `loads` row that this PDF reads. A full `Load`
 * (from @/types) satisfies it, so callers pass the row straight through.
 */
export interface RateConLoad {
  load_number: string
  status?: string | null
  carrier_id?: string | null
  carrier_name?: string | null
  carrier_rate?: number | null
  shipper_name?: string | null
  shipper_address?: string | null
  pickup_city?: string | null
  pickup_state?: string | null
  pickup_date?: string | null
  consignee_name?: string | null
  consignee_address?: string | null
  delivery_city?: string | null
  delivery_state?: string | null
  delivery_date?: string | null
  miles?: number | null
  commodity?: string | null
  weight?: number | null
  temperature?: string | null
  equipment_type?: string | null
  po_number?: string | null
  bol_number?: string | null
  ref_number?: string | null
}

/** Avantra's own broker identity for the header. Shape matches billing.ts's
 *  CompanyIdentity, so callers can pass `fetchInvoiceSettings(sb).company`. */
export interface BrokerIdentity {
  name: string
  mc?: string | null
  dot?: string | null
  addressLine?: string | null
}

/** Carrier the load is tendered to. A `Carrier` row satisfies this. */
export interface RateConCarrier {
  name?: string | null
  mc_number?: string | null
  dot_number?: string | null
  contact_name?: string | null
  phone?: string | null
  email?: string | null
}

export interface RateConOpts {
  /** Broker (Avantra) identity — from company_settings; defaults below. */
  company?: BrokerIdentity | null
  /** The carrier being paid; supplies MC/DOT + contact the load row lacks. */
  carrier?: RateConCarrier | null
  /** Agreed accessorials PAID TO THE CARRIER (line-item add-ons to carrier_rate). */
  carrierAccessorials?: { label: string; amount: number }[]
  /** Broker rep contact shown in the terms block (dispatch/after-hours). */
  brokerContact?: { name?: string | null; phone?: string | null; email?: string | null } | null
}

/** Ultimate fallback so the header never renders blank. */
export const DEFAULT_BROKER_IDENTITY: BrokerIdentity = {
  name: 'CRYOLANE LOGISTICS',
  mc: 'MC-000000',
  dot: 'USDOT 0000000',
  addressLine: '',
}

/* ─── Standard broker → carrier terms ─────────────────────────────────────── */
const CARRIER_TERMS: string[] = [
  'This Rate Confirmation is governed by the Broker-Carrier Agreement between Avantra and Carrier and confirms the agreed all-in rate for this load.',
  'Payment: Carrier will be paid within the agreed terms following Avantra\'s receipt of a legible, signed Proof of Delivery (POD), the Carrier invoice, and this signed Rate Confirmation. Missing or illegible paperwork delays payment.',
  'NO DOUBLE BROKERING. Carrier may not re-broker, co-broker, interline, or subcontract this load to any other carrier without Avantra\'s prior written consent. Doing so voids all payment obligations to Carrier.',
  'Reefer loads: Carrier must run the trailer on CONTINUOUS mode at the set-point shown above and provide a download/printout on request. Pre-cool the trailer before pickup. Report any temperature deviation immediately.',
  'Carrier must maintain active operating authority and required cargo & auto-liability insurance for the full transit, and confirm receipt/acceptance of this load before dispatch.',
  'Notify Avantra immediately of any delay, breakdown, OS&D (over/short/damaged), detention, or claim. Accessorials must be pre-approved in writing to be payable. Rate above is all-in unless a line item states otherwise.',
]

/* ─── Main export ─────────────────────────────────────────────────────────── */

export async function generateRateConPDF(
  load: RateConLoad,
  opts: RateConOpts = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font     = await doc.embedFont(StandardFonts.Helvetica)
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold)

  const company = { ...DEFAULT_BROKER_IDENTITY, ...(opts.company ?? {}) }
  const carrier = opts.carrier ?? {}
  const accessorials = opts.carrierAccessorials ?? []

  const W = 612
  const H = 792
  const ML = 48           // margin left
  const MR = W - 48       // margin right
  const BODY_W = MR - ML
  const COL2 = ML + 140   // label/value split
  const HALF = ML + BODY_W / 2

  const page = doc.addPage([W, H])

  /* ── Header band ─────────────────────────────────────────────────── */
  page.drawRectangle({ x: 0, y: H - 78, width: W, height: 78, color: SKY })

  page.drawText(safe(company.name).toUpperCase(), {
    x: ML, y: H - 34, font: boldFont, size: 20, color: WHITE,
  })
  page.drawText('RATE CONFIRMATION', {
    x: ML, y: H - 52, font, size: 10, color: SKYTINT,
  })
  const idLine = [company.mc, company.dot].map((v) => safe(v)).filter(Boolean).join('   ·   ')
  if (idLine) page.drawText(idLine, { x: ML, y: H - 66, font, size: 8, color: SKYTINT })

  /* ── Doc number + date (top right) ─────────────────────────────── */
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const docNum = `RC-${safe(load.load_number)}`

  page.drawText('Confirmation #', { x: MR - 180, y: H - 32, font, size: 8.5, color: SKYTINT })
  page.drawText(docNum,           { x: MR - 180, y: H - 47, font: boldFont, size: 12, color: WHITE })
  page.drawText(`Date: ${today}`, { x: MR - 180, y: H - 62, font, size: 8, color: SKYTINT })

  /* ── Carrier block (WHO WE ARE PAYING) ───────────────────────────── */
  let y = H - 104
  page.drawText('CARRIER', { x: ML, y, font: boldFont, size: 7.5, color: LIGHT })
  y -= 15
  page.drawText(safe(carrier.name) || safe(load.carrier_name) || 'Carrier — TBD', {
    x: ML, y, font: boldFont, size: 13, color: DARK,
  })
  y -= 15

  const carrierAuthority = [
    carrier.mc_number ? `MC ${safe(carrier.mc_number)}` : '',
    carrier.dot_number ? `USDOT ${safe(carrier.dot_number)}` : '',
  ].filter(Boolean).join('   ·   ')
  if (carrierAuthority) {
    page.drawText(carrierAuthority, { x: ML, y, font, size: 9, color: MID })
    y -= 13
  }
  const carrierContact = [
    safe(carrier.contact_name),
    safe(carrier.phone),
    safe(carrier.email),
  ].filter(Boolean).join('   ·   ')
  if (carrierContact) {
    page.drawText(clip(carrierContact, 92), { x: ML, y, font, size: 9, color: MID })
    y -= 13
  }

  y -= 10
  hRule(page, ML, y, BODY_W)
  y -= 16

  /* ── Load Details ───────────────────────────────────────────────── */
  y = section(page, boldFont, ML, y, 'Load Details', W)

  const details: [string, string][] = [
    ['Load #',        safe(load.load_number)],
    ['Equipment',     safe(load.equipment_type) || 'Reefer'],
    ['Temperature',   load.temperature ? safe(load.temperature) : '—'],
    ['Commodity',     safe(load.commodity) || '—'],
    ['Weight',        load.weight ? `${Number(load.weight).toLocaleString()} lbs` : '—'],
    ['Miles',         load.miles ? `${Number(load.miles).toLocaleString()} mi` : '—'],
    ['PO #',          safe(load.po_number) || '—'],
    ['BOL #',         safe(load.bol_number) || '—'],
    ['Ref #',         safe(load.ref_number) || '—'],
  ]
  details.forEach(([lbl, val], i) => {
    row(page, font, boldFont, y, ML, COL2, lbl, val, BODY_W, i % 2 === 0)
    y -= 18
  })

  y -= 4
  hRule(page, ML, y, BODY_W)
  y -= 16

  /* ── Route ──────────────────────────────────────────────────────── */
  y = section(page, boldFont, ML, y, 'Route', W)

  page.drawText('PICKUP', { x: ML, y, font: boldFont, size: 7.5, color: LIGHT })
  page.drawText('DELIVERY', { x: HALF, y, font: boldFont, size: 7.5, color: LIGHT })
  y -= 14

  const puName = safe(load.shipper_name) || 'Shipper'
  const dlName = safe(load.consignee_name) || 'Consignee'
  page.drawText(clip(puName, 30), { x: ML, y, font: boldFont, size: 9.5, color: DARK })
  page.drawText(clip(dlName, 30), { x: HALF, y, font: boldFont, size: 9.5, color: DARK })
  y -= 13

  page.drawText(safe([load.pickup_city, load.pickup_state].filter(Boolean).join(', ')) || '—',
    { x: ML, y, font, size: 9, color: MID })
  page.drawText(safe([load.delivery_city, load.delivery_state].filter(Boolean).join(', ')) || '—',
    { x: HALF, y, font, size: 9, color: MID })
  y -= 13

  if (load.shipper_address) {
    page.drawText(clip(safe(load.shipper_address), 34), { x: ML, y, font, size: 8, color: LIGHT })
  }
  if (load.consignee_address) {
    page.drawText(clip(safe(load.consignee_address), 34), { x: HALF, y, font, size: 8, color: LIGHT })
  }
  y -= 14

  page.drawText(`Date: ${safe(load.pickup_date) || '—'}`, { x: ML, y, font, size: 8.5, color: MID })
  page.drawText(`Date: ${safe(load.delivery_date) || '—'}`, { x: HALF, y, font, size: 8.5, color: MID })
  y -= 20

  hRule(page, ML, y, BODY_W)
  y -= 16

  /* ── Carrier Pay (what Avantra pays the carrier) ──────────────────── */
  y = section(page, boldFont, ML, y, 'Carrier Pay', W)

  // Line haul
  page.drawRectangle({ x: ML - 4, y: y - 3, width: BODY_W + 8, height: 18, color: STRIPE })
  page.drawText('Line Haul (all-in)', { x: ML, y: y + 1, font, size: 9.5, color: DARK })
  page.drawText(money(load.carrier_rate), { x: MR - 90, y: y + 1, font: boldFont, size: 9.5, color: DARK })
  y -= 22

  // Agreed accessorials paid to the carrier
  let accTotal = 0
  accessorials.forEach((a) => {
    const amt = Number(a.amount) || 0
    accTotal += amt
    page.drawText(clip(safe(a.label) || 'Accessorial', 48), { x: ML, y: y + 1, font, size: 9, color: MID })
    page.drawText(money(amt), { x: MR - 90, y: y + 1, font, size: 9, color: DARK })
    y -= 18
  })

  const totalToCarrier = (Number(load.carrier_rate) || 0) + accTotal

  y -= 2
  hRule(page, ML, y, BODY_W)
  y -= 4

  // Total-to-carrier box
  page.drawRectangle({ x: ML - 4, y: y - 24, width: BODY_W + 8, height: 28, color: SKY })
  page.drawText('TOTAL TO CARRIER', { x: ML + 4, y: y - 14, font: boldFont, size: 10, color: WHITE })
  page.drawText(money(totalToCarrier), { x: MR - 110, y: y - 14, font: boldFont, size: 14, color: WHITE })
  y -= 40

  page.drawText('All-in, USD. Accessorials payable only if pre-approved in writing by Avantra.', {
    x: ML, y, font, size: 7.5, color: LIGHT, maxWidth: BODY_W,
  })
  y -= 22

  /* ── Terms & Conditions ─────────────────────────────────────────── */
  y = section(page, boldFont, ML, y, 'Terms & Conditions', W)

  const lineH = 9
  for (const term of CARRIER_TERMS) {
    const lines = wrapText(safe(term), font, 7.5, BODY_W - 10)
    // bullet marker
    page.drawText('-', { x: ML, y, font: boldFont, size: 7.5, color: SKY })
    for (const ln of lines) {
      page.drawText(ln, { x: ML + 10, y, font, size: 7.5, color: MID })
      y -= lineH
    }
    y -= 3
  }

  /* ── Signature line ─────────────────────────────────────────────── */
  y = Math.max(y, 96)
  y -= 4
  const bc = opts.brokerContact
  const brokerLine = [safe(bc?.name), safe(bc?.phone), safe(bc?.email)].filter(Boolean).join('   ·   ')
  if (brokerLine) {
    page.drawText(`Broker contact: ${clip(brokerLine, 80)}`, { x: ML, y, font, size: 8, color: MID })
    y -= 16
  }
  hRule(page, ML, y, (BODY_W - 24) / 2)
  hRule(page, HALF + 12, y, (BODY_W - 24) / 2)
  y -= 11
  page.drawText('Carrier signature', { x: ML, y, font, size: 7.5, color: LIGHT })
  page.drawText('Date', { x: HALF + 12, y, font, size: 7.5, color: LIGHT })

  /* ── Footer ─────────────────────────────────────────────────────── */
  page.drawRectangle({ x: 0, y: 0, width: W, height: 36, color: STRIPE })
  hRule(page, 0, 36, W)
  page.drawText(`${safe(company.name)}  •  Rate confirmation generated by Avantra`, {
    x: ML, y: 13, font, size: 7.5, color: LIGHT,
  })
  page.drawText(today, { x: MR - 80, y: 13, font, size: 7.5, color: LIGHT })

  return doc.save()
}

/* ─── Word-wrap for the terms block (WinAnsi-safe input assumed) ───────────── */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(trial, size) > maxWidth && current) {
      lines.push(current)
      current = word
    } else {
      current = trial
    }
  }
  if (current) lines.push(current)
  return lines
}
