'use client'

import { Compass, AlertTriangle, ExternalLink } from 'lucide-react'
import { missingSupabaseVars } from '@/lib/supabase/config'

// Shown instead of the app when Supabase credentials are absent. Without this,
// a fresh clone 500s on every route with only a stack trace in the terminal —
// which reads like the app is broken rather than simply not configured yet.

export function SetupRequired() {
  const missing = missingSupabaseVars()

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/20">
            <Compass className="h-7 w-7" />
          </div>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-white">Avantra Carrier Services</h1>
          <p className="text-sm font-medium text-indigo-400">Setup required</p>
        </div>

        <div className="rounded-xl bg-slate-800 p-6 space-y-4">
          <div className="flex items-start gap-2 text-amber-300">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
            <p className="text-sm">
              The app can&apos;t reach Supabase, so there&apos;s nothing to sign in to yet. This is a
              configuration state, not an error.
            </p>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
              Missing environment {missing.length === 1 ? 'variable' : 'variables'}
            </p>
            <ul className="space-y-1">
              {missing.map(v => (
                <li key={v}>
                  <code className="text-xs text-red-300 bg-slate-900 rounded px-2 py-1 inline-block">{v}</code>
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t border-slate-700 pt-4 space-y-2 text-sm text-slate-300">
            <p className="font-semibold text-white">To finish setup</p>
            <ol className="list-decimal pl-5 space-y-1.5 text-slate-400">
              <li>Create a Supabase project.</li>
              <li>
                Run <code className="text-xs text-slate-200">supabase/setup.sql</code> in its SQL editor
                to build the schema.
              </li>
              <li>
                Copy <code className="text-xs text-slate-200">.env.local.example</code> to{' '}
                <code className="text-xs text-slate-200">.env.local</code> and paste in the project URL
                and anon key from <span className="text-slate-300">Settings → API</span>.
              </li>
              <li>Restart the dev server.</li>
            </ol>
            <p className="text-xs text-slate-500 pt-1">
              Full walkthrough in <code className="text-[11px] text-slate-400">docs/DEPLOYMENT.md</code>.
            </p>
          </div>

          <a
            href="https://supabase.com/dashboard"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300 hover:underline"
          >
            Open the Supabase dashboard<ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </div>
  )
}

export default SetupRequired
