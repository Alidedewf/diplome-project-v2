import { cn } from '../lib/format.js'

const variants = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'border border-line bg-surface text-ink hover:border-muted/50',
  ghost: 'text-muted hover:bg-surface-2 hover:text-ink',
  // выбранное состояние для кнопок-переключателей (полки)
  selected: 'border border-accent bg-accent-soft text-accent-text',
  // необратимые действия (удаление аккаунта)
  danger: 'bg-red-700 text-white hover:bg-red-800',
  'danger-outline': 'border border-red-500/40 bg-surface text-red-700 hover:bg-red-500/10 dark:text-red-400',
}

const sizes = {
  sm: 'h-8 gap-1.5 px-3 text-sm',
  md: 'h-10 gap-2 px-4 text-sm',
  icon: 'size-10 justify-center',
}

export function Button({ as: Component = 'button', variant = 'secondary', size = 'md', className, ...props }) {
  return (
    <Component
      type={Component === 'button' ? 'button' : undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  )
}
