/**
 * Server-safe upload validator — inspects magic bytes, not just file extension.
 * Used by the secure upload routes (DQF, compliance, onboarding) to enforce file
 * type and size limits before touching storage.
 */

// ── Magic byte signatures ─────────────────────────────────────────────────────

interface Sig {
  bytes: number[]
  offset?: number       // byte offset to start comparison (default 0)
}

const SIGNATURES: Array<{ mime: string } & Sig> = [
  { mime: 'application/pdf',  bytes: [0x25, 0x50, 0x44, 0x46] },           // %PDF
  { mime: 'image/jpeg',       bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',        bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/gif',        bytes: [0x47, 0x49, 0x46, 0x38] },           // GIF8
  { mime: 'image/webp',       bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 }, // WEBP at +8 (after RIFF)
  // DOCX / XLSX / ZIP — same PK header; caller validates extension separately
  { mime: 'application/zip',  bytes: [0x50, 0x4B, 0x03, 0x04] },
  // Old binary .doc / .xls (OLE2 Compound Document)
  { mime: 'application/msword', bytes: [0xD0, 0xCF, 0x11, 0xE0] },
  // ISOBMFF container — HEIC/HEIF/MP4 all share 'ftyp' at offset 4
  { mime: 'video/mp4',        bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // ftyp
]

// Always-blocked magic bytes — executables / binaries
const BLOCKED_MAGIC: Array<{ label: string; bytes: number[] }> = [
  { label: 'Windows PE executable', bytes: [0x4D, 0x5A] },           // MZ
  { label: 'ELF binary',            bytes: [0x7F, 0x45, 0x4C, 0x46] },
  { label: 'Mach-O binary',         bytes: [0xFE, 0xED, 0xFA, 0xCE] },
  { label: 'Mach-O binary 64-bit',  bytes: [0xCF, 0xFA, 0xED, 0xFE] },
  { label: 'Java class file',        bytes: [0xCA, 0xFE, 0xBA, 0xBE] },
]

// Always-blocked extensions — regardless of magic bytes
const BLOCKED_EXT = new Set([
  'exe','dll','bat','cmd','com','scr','msi','msc','msp',
  'sh','bash','zsh','fish','ps1','psm1','psd1',
  'vbs','vbe','js','jse','wsf','wsh','hta',
  'jar','class','war','ear',
  'php','php3','php4','php5','phtml','phar',
  'asp','aspx','ashx','asmx','axd',
  'cgi','pl','py','rb','lua','go',
  'html','htm','xhtml','shtml','svg','xml',
  'sql','db','sqlite',
])

// Allowed MIME types per upload purpose
const ALLOWED: Record<string, Set<string>> = {
  documents: new Set([
    'application/pdf',
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
    'application/zip',          // docx/xlsx after extension check
    'application/msword',       // legacy .doc
  ]),
  photos: new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  ]),
}

const MAX_BYTES: Record<string, number> = {
  documents: 20 * 1024 * 1024,   // 20 MB
  photos:     5 * 1024 * 1024,   //  5 MB
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function startsWith(buf: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false
  return bytes.every((b, i) => buf[offset + i] === b)
}

function detectMime(buf: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (startsWith(buf, sig.bytes, sig.offset ?? 0)) return sig.mime
  }
  return null
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface UploadValidationResult {
  ok: boolean
  error?: string
  /** Verified MIME type (use this as contentType when writing to storage) */
  mime?: string
}

export function validateUpload(
  buf: Uint8Array,
  fileName: string,
  fileSize: number,
  purpose: 'documents' | 'photos' = 'documents',
): UploadValidationResult {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  // Guard against an unexpected `purpose` value (route reads it from client FormData)
  const allowedSet = ALLOWED[purpose] ?? ALLOWED.documents

  // 1. Block dangerous extensions
  if (BLOCKED_EXT.has(ext)) {
    return { ok: false, error: `Files with extension ".${ext}" are not permitted.` }
  }

  // 2. Size limit
  const maxBytes = MAX_BYTES[purpose] ?? MAX_BYTES.documents
  if (fileSize > maxBytes) {
    return {
      ok: false,
      error: `File is too large (${(fileSize / 1024 / 1024).toFixed(1)} MB). Maximum is ${maxBytes / 1024 / 1024} MB.`,
    }
  }

  // 3. Blocked magic bytes (must be before general detection)
  for (const { label, bytes } of BLOCKED_MAGIC) {
    if (startsWith(buf, bytes)) {
      return { ok: false, error: `Rejected: file is a ${label}.` }
    }
  }

  // 4. HEIC / HEIF — ISOBMFF container; 'ftyp' is at offset 4
  if (ext === 'heic' || ext === 'heif') {
    const hasFtyp = startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4)  // 'ftyp'
    if (!hasFtyp) {
      return { ok: false, error: 'File does not appear to be a valid HEIC/HEIF image.' }
    }
    if (!allowedSet.has('image/heic')) {
      return { ok: false, error: `HEIC images are not allowed for ${purpose}.` }
    }
    return { ok: true, mime: 'image/heic' }
  }

  // 5. ZIP-family: DOCX, XLSX — must match extension
  const detected = detectMime(buf)
  if (detected === 'application/zip') {
    const officeExts = new Set(['docx', 'xlsx', 'pptx'])
    if (!officeExts.has(ext)) {
      return { ok: false, error: `Generic ZIP archives are not allowed. Upload .docx or .xlsx files only.` }
    }
    if (!allowedSet.has('application/zip')) {
      return { ok: false, error: `Office documents are not allowed for ${purpose}.` }
    }
    return {
      ok: true,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }
  }

  // 6. Require recognisable magic bytes (reject unknown binary blobs)
  if (!detected) {
    // Allow plain-text-ish files like .txt only if explicitly permitted — currently we don't
    return {
      ok: false,
      error: 'File type could not be verified. Please upload a PDF, image (JPG/PNG/HEIC), or Word document.',
    }
  }

  // 7. Check against allowed set for this purpose
  if (!allowedSet.has(detected)) {
    return { ok: false, error: `${detected} files are not permitted for ${purpose}.` }
  }

  return { ok: true, mime: detected }
}

// Extension → content type, for the metadata-only path (direct-to-storage uploads
// where we never see the bytes and so cannot inspect magic bytes).
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heic',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

const ALLOWED_EXT: Record<string, Set<string>> = {
  documents: new Set(['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'doc', 'docx', 'xlsx']),
  photos:    new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif']),
}

/**
 * Validate an upload by its metadata only (file name + size), for flows where the
 * browser uploads straight to storage via a signed URL and the bytes never reach
 * the server. Enforces the same extension blocklist and size limits as
 * validateUpload; magic-byte verification is necessarily skipped. The file still
 * lands in the PRIVATE secure-docs bucket, readable only by staff via signed URLs.
 */
export function validateUploadMeta(
  fileName: string,
  fileSize: number,
  purpose: 'documents' | 'photos' = 'documents',
): UploadValidationResult {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()

  if (BLOCKED_EXT.has(ext)) {
    return { ok: false, error: `Files with extension ".${ext}" are not permitted.` }
  }

  const maxBytes = MAX_BYTES[purpose] ?? MAX_BYTES.documents
  if (fileSize > maxBytes) {
    return {
      ok: false,
      error: `File is too large (${(fileSize / 1024 / 1024).toFixed(1)} MB). Maximum is ${maxBytes / 1024 / 1024} MB.`,
    }
  }

  const allowedExt = ALLOWED_EXT[purpose] ?? ALLOWED_EXT.documents
  if (!allowedExt.has(ext)) {
    return {
      ok: false,
      error: 'Unsupported file type. Please upload a PDF, image (JPG/PNG/HEIC), or Word document.',
    }
  }

  return { ok: true, mime: EXT_MIME[ext] }
}
