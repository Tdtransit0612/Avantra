import { createClient } from '@/lib/supabase/client'

// Actions that trigger an email alert to admins.
// Matches getRiskDef() in /api/audit/alert/route.ts — keep in sync.
const ALERT_ACTIONS = new Set([
  'user.role_change',
  'client.status_change',
  'invoice.void',
  'statement.void',
  // Rewriting the fee on a load changes what Avantra earns, so it's worth a look
  // even when it's legitimate (detention added, fee waived for goodwill).
  'load.money_update',
])
const ALERT_PATTERNS = ['bulk', 'delete', 'export', 'void']

function isHighRisk(action: string): boolean {
  if (ALERT_ACTIONS.has(action)) return true
  return ALERT_PATTERNS.some(p => action.includes(p))
}

export async function logAudit(
  action: string,
  opts: {
    table_name?: string
    record_id?: string
    old_value?: Record<string, unknown>
    new_value?: Record<string, unknown>
  } = {}
) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    await supabase.from('audit_log').insert({
      user_id: user.id,
      action,
      table_name: opts.table_name ?? null,
      record_id: opts.record_id ?? null,
      old_value: opts.old_value ?? null,
      new_value: opts.new_value ?? null,
    })
  } catch (err) {
    console.error('[audit] logAudit failed — action:', action, err)
  }

  // Fire-and-forget alert for high-risk actions
  if (isHighRisk(action)) {
    fetch('/api/audit/alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...opts }),
    }).catch(() => {/* non-blocking — never throw */})
  }
}
