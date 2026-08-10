'use client'

import { useEffect } from 'react'
import { Snowflake, RefreshCw } from 'lucide-react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('App error:', error)
  }, [error])

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="text-center">
        <div className="flex justify-center mb-6">
          <div className="bg-red-600 p-4 rounded-2xl">
            <Snowflake className="h-12 w-12 text-white" />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-white mb-3">Something went wrong</h1>
        <p className="text-gray-400 mb-2 max-w-sm mx-auto">
          An unexpected error occurred. Try refreshing, or contact your admin if this keeps happening.
        </p>
        {error.digest && (
          <p className="text-xs text-gray-600 mb-6 font-mono">Error ID: {error.digest}</p>
        )}
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-6 py-3 rounded-lg transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          Try Again
        </button>
      </div>
    </div>
  )
}
