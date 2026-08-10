'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { DocLink } from '@/components/DocLink'
import {
  Upload, Loader2, FileText, Trash2, ExternalLink, AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { logAudit } from '@/lib/audit'
import { validateUploadMeta } from '@/lib/validate-upload'
import { longDate, daysUntil } from '@/lib/dispatch'
import type { DocEntityType, DocumentRecord } from '@/types'

// Reusable document list + uploader for any entity. Files go to the PRIVATE
// `documents` bucket; the table row is metadata only. Reads always go through
// DocLink → /api/doc-url, which mints a short-lived signed URL — we never call
// getPublicUrl, and the bucket would 404 it anyway.

const DOC_TYPES_BY_ENTITY: Partial<Record<DocEntityType, { value: string; label: string }[]>> = {
  load: [
    { value: 'rate_con', label: 'Rate confirmation' },
    { value: 'bol', label: 'Bill of lading' },
    { value: 'pod', label: 'Proof of delivery' },
    { value: 'lumper_receipt', label: 'Lumper receipt' },
    { value: 'scale', label: 'Scale ticket' },
    { value: 'other', label: 'Other' },
  ],
  client: [
    { value: 'agreement', label: 'Dispatch agreement' },
    { value: 'poa', label: 'Power of attorney' },
    { value: 'w9', label: 'W-9' },
    { value: 'coi', label: 'Certificate of insurance' },
    { value: 'authority', label: 'Operating authority' },
    { value: 'noa', label: 'Notice of assignment' },
    { value: 'other', label: 'Other' },
  ],
  driver: [
    { value: 'cdl', label: 'CDL' },
    { value: 'medical', label: 'Medical card' },
    { value: 'other', label: 'Other' },
  ],
  equipment: [
    { value: 'inspection', label: 'Annual inspection' },
    { value: 'registration', label: 'Registration' },
    { value: 'other', label: 'Other' },
  ],
  invoice: [
    { value: 'invoice', label: 'Invoice' },
    { value: 'packet', label: 'Invoice packet' },
    { value: 'other', label: 'Other' },
  ],
}

const FALLBACK_TYPES = [{ value: 'other', label: 'Other' }]

const DOC_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  Object.values(DOC_TYPES_BY_ENTITY).flat().filter(Boolean).map(t => [t!.value, t!.label]),
)

export function DocumentsPanel({
  entityType, entityId, clientId, canModify, title = 'Documents',
}: {
  entityType: DocEntityType
  entityId: string
  /** Scopes portal visibility. Pass the owning client where there is one. */
  clientId?: string | null
  canModify: boolean
  title?: string
}) {
  const [docs, setDocs] = useState<DocumentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [docType, setDocType] = useState('other')
  const fileRef = useRef<HTMLInputElement>(null)

  const types = DOC_TYPES_BY_ENTITY[entityType] ?? FALLBACK_TYPES

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data } = await supabase.from('documents').select('*')
      .eq('entity_type', entityType).eq('entity_id', entityId)
      .order('created_at', { ascending: false })
    setDocs((data ?? []) as DocumentRecord[])
    setLoading(false)
  }, [entityType, entityId])

  useEffect(() => { load() }, [load])
  useEffect(() => { setDocType(types[0]?.value ?? 'other') }, [types])

  const handleFile = async (file: File) => {
    // Same extension + size rules the server-side validator enforces. The bytes
    // go browser → storage directly, so magic-byte inspection isn't possible
    // here; the bucket is private either way.
    const check = validateUploadMeta(file.name, file.size, 'documents')
    if (!check.ok) { toast.error(check.error ?? 'That file type is not allowed.'); return }

    setUploading(true)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // Strip anything that could confuse a storage path; keep it recognisable.
    const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-120)
    const path = `${entityType}/${entityId}/${Date.now()}-${safeName}`

    const { error: upErr } = await supabase.storage.from('documents')
      .upload(path, file, { contentType: check.mime ?? file.type, upsert: false })
    if (upErr) { setUploading(false); toast.error(upErr.message); return }

    const { error: rowErr } = await supabase.from('documents').insert({
      entity_type: entityType,
      entity_id: entityId,
      client_id: clientId ?? null,
      doc_type: docType,
      file_path: path,
      file_name: file.name,
      mime_type: check.mime ?? file.type,
      size_bytes: file.size,
      uploaded_by: user?.id ?? null,
    })

    setUploading(false)
    if (rowErr) {
      // The object is orphaned in storage if the metadata insert fails — remove
      // it so the bucket doesn't accumulate files nothing points at.
      await supabase.storage.from('documents').remove([path])
      toast.error(rowErr.message)
      return
    }

    void logAudit('document.upload', {
      table_name: 'documents',
      record_id: entityId,
      new_value: { entity_type: entityType, doc_type: docType, file_name: file.name },
    })
    toast.success(`${file.name} uploaded`)
    if (fileRef.current) fileRef.current.value = ''
    load()
  }

  const remove = async (doc: DocumentRecord) => {
    if (!confirm(`Delete ${doc.file_name ?? 'this document'}? This can't be undone.`)) return
    const supabase = createClient()
    const { error } = await supabase.from('documents').delete().eq('id', doc.id)
    if (error) { toast.error(error.message); return }
    await supabase.storage.from('documents').remove([doc.file_path])
    void logAudit('document.delete', {
      table_name: 'documents',
      record_id: doc.id,
      old_value: { entity_type: entityType, doc_type: doc.doc_type, file_name: doc.file_name },
    })
    toast.success('Document deleted')
    load()
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
        {canModify && (
          <div className="flex items-center gap-2">
            <Select value={docType} onValueChange={v => setDocType(v ?? 'other')}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {types.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
            />
            <Button
              size="sm" variant="outline" className="h-8 gap-1.5 text-xs"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-gray-400 py-4">
          <Loader2 className="h-4 w-4 animate-spin" />Loading documents…
        </div>
      ) : docs.length === 0 ? (
        <p className="text-xs text-gray-400 py-4 text-center border border-dashed dark:border-gray-800 rounded-lg">
          No documents yet.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {docs.map(d => {
            const exp = daysUntil(d.expiry_date)
            const expired = exp != null && exp < 0
            const expiring = exp != null && exp >= 0 && exp <= 30
            return (
              <li key={d.id} className="flex items-center gap-3 rounded-lg border dark:border-gray-800 px-3 py-2">
                <FileText className="h-4 w-4 text-gray-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-gray-800 dark:text-gray-100">{d.file_name ?? 'Document'}</div>
                  <div className="flex items-center gap-2 text-[11px] text-gray-400">
                    <span>{DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type}</span>
                    <span>·</span>
                    <span>{longDate(d.created_at)}</span>
                    {d.expiry_date && (
                      <>
                        <span>·</span>
                        <span className={expired ? 'text-red-600 dark:text-red-400 font-medium' : expiring ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}>
                          {expired ? 'expired' : 'expires'} {longDate(d.expiry_date)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                {(expired || expiring) && (
                  <Badge className={`border shrink-0 ${expired
                    ? 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800/50'
                    : 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800/50'}`}>
                    <AlertTriangle className="h-3 w-3 mr-1" />{expired ? 'Expired' : 'Expiring'}
                  </Badge>
                )}
                <DocLink
                  path={d.file_path}
                  className="shrink-0 inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  Open<ExternalLink className="h-3 w-3" />
                </DocLink>
                {canModify && (
                  <button
                    type="button"
                    onClick={() => remove(d)}
                    title="Delete document"
                    className="shrink-0 text-gray-400 hover:text-red-600 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default DocumentsPanel
