import { Check } from 'lucide-react'
import { useId } from 'react'
import { READING_LANGUAGES } from '../lib/bookNames.js'
import { cn } from '../lib/format.js'

export const LANGUAGES_HINT = 'Покажем книги, которые есть на вашем языке — в том числе переводные'

// «На каком языке читаете?» (2.8) — чипы, можно несколько или ни одного. value — ['ru', 'kk', 'en'].
// bare — без заголовка и пояснения (их показывает обёртка, как в кабинете)
export function LanguagePicker({ value, onChange, bare = false, className }) {
  const titleId = useId()
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div
      role="group"
      aria-labelledby={bare ? undefined : titleId}
      aria-label={bare ? 'Язык чтения' : undefined}
      className={cn('flex flex-col gap-3', className)}
    >
      {!bare && (
        <div>
          <h2 id={titleId} className="text-lg font-semibold">
            На каком языке читаете?
          </h2>
          <p className="mt-0.5 text-sm text-muted">{LANGUAGES_HINT}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {READING_LANGUAGES.map(({ id, label }) => {
          const on = value.includes(id)
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(id)}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors',
                on ? 'border-accent bg-accent-soft font-medium text-accent-text' : 'border-line bg-surface text-ink hover:border-muted/60',
              )}
            >
              {on && <Check size={15} strokeWidth={2.5} aria-hidden />}
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
