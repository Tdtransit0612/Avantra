import Link from 'next/link'
import { Snowflake } from 'lucide-react'

export default function NotFound() {
  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="text-center">
        <div className="flex justify-center mb-6">
          <div className="bg-sky-600 p-4 rounded-2xl">
            <Snowflake className="h-12 w-12 text-white" />
          </div>
        </div>
        <h1 className="text-6xl font-bold text-sky-500 mb-2">404</h1>
        <h2 className="text-2xl font-semibold text-white mb-3">Page Not Found</h2>
        <p className="text-gray-400 mb-8 max-w-sm mx-auto">
          This load took a wrong turn. The page you&apos;re looking for doesn&apos;t exist.
        </p>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 bg-sky-600 hover:bg-sky-700 text-white font-medium px-6 py-3 rounded-lg transition-colors"
        >
          Back to Dashboard
        </Link>
      </div>
    </div>
  )
}
