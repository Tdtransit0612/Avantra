'use client'

import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { logAudit } from '@/lib/audit'

interface SensitiveInputProps {
  value: string
  onChange: (v: string) => void
  driverId: string
  fieldName: string
  label: string
  type?: string
  placeholder?: string
  className?: string
  maxLength?: number
  step?: string
  [key: string]: unknown
}

/**
 * SensitiveInput — shows a masked value (••••) by default.
 * Clicking the eye icon reveals the real value, enables editing,
 * and logs a driver.sensitive_field_viewed audit event.
 */
export default function SensitiveInput({
  value,
  onChange,
  driverId,
  fieldName,
  label,
  type = 'text',
  placeholder,
  className = '',
  ...rest
}: SensitiveInputProps) {
  const [revealed, setRevealed] = useState(false)

  const handleReveal = async () => {
    if (!revealed && value) {
      await logAudit('driver.sensitive_field_viewed', {
        table_name: 'drivers',
        record_id: driverId,
        new_value: { field: fieldName, label },
      })
    }
    setRevealed(v => !v)
  }

  return (
    <div className="relative">
      {revealed ? (
        <Input
          type={type}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className={`mt-1 pr-8 ${className}`}
          {...rest}
        />
      ) : (
        <div className="mt-1 flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 py-1 shadow-sm text-sm">
          {value
            ? <span className="tracking-[0.25em] text-gray-500 dark:text-gray-400 flex-1 select-none">
                {'•'.repeat(Math.min(value.length, 10))}
              </span>
            : <span className="text-gray-300 dark:text-gray-600 flex-1">{placeholder ?? '—'}</span>
          }
        </div>
      )}
      <button
        type="button"
        onClick={handleReveal}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-orange-500 transition-colors z-10"
        title={revealed ? 'Hide field' : 'Reveal (logged)'}
        aria-label={revealed ? 'Hide field' : 'Reveal field'}
      >
        {revealed
          ? <EyeOff className="h-3.5 w-3.5" />
          : <Eye    className="h-3.5 w-3.5" />
        }
      </button>
    </div>
  )
}
