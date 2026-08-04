'use client'

import { useEffect, useState } from 'react'
import { getDocUrl } from '@/lib/doc-url'

// Renders a `documents`-bucket image via a short-lived signed URL (private bucket).
// Accepts a bare storage path OR a stored legacy public URL. Renders nothing until
// the URL resolves (and nothing on failure), so callers should size via className.
export function DocImg({
  path, alt, className, ...rest
}: { path: string | null | undefined; alt?: string; className?: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setSrc(null)
    getDocUrl(path).then((u) => { if (active) setSrc(u) })
    return () => { active = false }
  }, [path])
  if (!src) return null
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt ?? ''} className={className} {...rest} />
}
