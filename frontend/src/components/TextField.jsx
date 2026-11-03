import { useId } from 'react'
import { cn } from '../lib/format.js'

// Поле формы с подписью, подсказкой и ошибкой
export function TextField({ label, error, hint, className, multiline = false, ...props }) {
  const id = useId()
  const Input = multiline ? 'textarea' : 'input'
  const note = error ?? hint
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={note ? `${id}-note` : undefined}
        className={cn(
          'rounded-lg border bg-surface px-3 text-sm transition-colors outline-none placeholder:text-muted focus:border-accent',
          multiline ? 'min-h-24 resize-y py-2.5' : 'h-11',
          error ? 'border-red-500/70' : 'border-line',
        )}
        {...props}
      />
      {note && (
        <p id={`${id}-note`} className={cn('text-xs', error ? 'text-red-600 dark:text-red-400' : 'text-muted')}>
          {note}
        </p>
      )}
    </div>
  )
}
