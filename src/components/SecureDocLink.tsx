'use client'

import { useState } from 'react'
import { Loader2, ExternalLink } from 'lucide-react'

// Opens a stored document by minting a short-lived signed URL on click. Works for
// relative secure-docs paths and for legacy absolute project-storage URLs (the
// signer re-signs those; their old public URLs 404 once the bucket goes private).

export function SecureDocLink({ path, className, title, children }: { path: string | null | undefined; className?: string; title?: string; children?: React.ReactNode }) {
  const [loading, setLoading] = useState(false)
  if (!path) return null

  const open = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/storage/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })
      const j = await res.json().catch(() => ({}))
      if (j.url) window.open(j.url, '_blank', 'noopener,noreferrer')
      else alert('Could not open this document. Please try again.')
    } catch {
      alert('Could not open this document. Please try again.')
    } finally { setLoading(false) }
  }

  return (
    <button type="button" onClick={open} className={className} title={title} disabled={loading}>
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : (children ?? <>view<ExternalLink className="h-3 w-3" /></>)}
    </button>
  )
}
