'use client'

import { useState } from 'react'
import { Loader2, ExternalLink } from 'lucide-react'
import { getDocUrl } from '@/lib/doc-url'

// Opens a `documents`-bucket file by minting a short-lived signed URL on click
// (the bucket is private). Accepts a bare storage path OR a stored legacy public
// URL — the doc-url route re-signs either. Renders a <button> styled like the
// anchor it replaces (pass the same className + children).
export function DocLink({
  path, className, title, children,
}: { path: string | null | undefined; className?: string; title?: string; children?: React.ReactNode }) {
  const [loading, setLoading] = useState(false)
  if (!path) return null

  const open = async () => {
    setLoading(true)
    const url = await getDocUrl(path)
    setLoading(false)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
    else alert('Could not open this document. Please try again.')
  }

  return (
    <button type="button" onClick={open} className={className} title={title} disabled={loading}>
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : (children ?? <>view<ExternalLink className="h-3 w-3" /></>)}
    </button>
  )
}
