import { cn } from '../lib/format.js'

// Метка-тег. С onClick становится переключателем (selected — выбранный фильтр/тема)
export function Chip({ selected = false, onClick, className, children, ...props }) {
  const Component = onClick ? 'button' : 'span'
  return (
    <Component
      type={onClick ? 'button' : undefined}
      aria-pressed={onClick ? selected : undefined}
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-sm whitespace-nowrap transition-colors',
        selected
          ? 'border-accent bg-accent text-accent-fg'
          : 'border-line bg-surface text-ink',
        onClick && !selected && 'hover:border-muted/60',
        className,
      )}
      {...props}
    >
      {children}
    </Component>
  )
}

// Те же отступы и рамка, что у Chip, — заглушка совпадает с ним по высоте
export function ChipSkeleton() {
  return (
    <span
      className="inline-flex shrink-0 animate-pulse rounded-full border border-transparent bg-surface-2 px-3 py-1 text-sm"
      aria-hidden
    >
      <span className="h-[1lh] w-20" />
    </span>
  )
}
