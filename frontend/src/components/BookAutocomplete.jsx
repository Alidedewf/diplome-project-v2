import { Search } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useSuggest } from '../api/queries.js'
import { cn } from '../lib/format.js'
import { bookNames } from '../lib/bookNames.js'
import { useReader } from '../lib/useBookNames.js'

function useDebounced(value, ms) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

// Поле с подсказками книг (/search/suggest). Стрелки — выбор подсказки, Enter — открыть её
// или (без выбора) onSubmitQuery(текст), Esc — закрыть список.
export function BookAutocomplete({
  onSelect,
  onSubmitQuery,
  initialValue = '',
  placeholder,
  label,
  clearOnSelect = false,
  className,
  inputClassName,
}) {
  const reader = useReader()
  const [value, setValue] = useState(initialValue)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()
  const q = useDebounced(value.trim(), 200)
  const suggest = useSuggest(q)
  const items = q.length >= 2 ? (suggest.data ?? []) : []
  const showList = open && value.trim().length >= 2 && (items.length > 0 || (!suggest.isFetching && q === value.trim()))

  const choose = (item) => {
    setOpen(false)
    setActive(-1)
    setValue(clearOnSelect ? '' : bookNames(item, reader).title)
    onSelect(item)
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      // по кругу: -1 (ничего не выбрано) → 0 … n-1 → -1
      setActive((i) => {
        if (!items.length) return -1
        const next = i + step
        return next < -1 ? items.length - 1 : next >= items.length ? -1 : next
      })
    } else if (e.key === 'Escape') {
      setOpen(false)
      setActive(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (showList && items[active]) choose(items[active])
      else if (onSubmitQuery) {
        setOpen(false)
        onSubmitQuery(value.trim())
      }
    }
  }

  return (
    <div className={cn('relative', className)}>
      <label
        className={cn(
          'flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-4 transition-colors focus-within:border-accent',
          inputClassName,
        )}
      >
        <Search size={17} className="shrink-0 text-muted" aria-hidden />
        <input
          type="search"
          role="combobox"
          aria-label={label}
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && items[active] ? `${listId}-${active}` : undefined}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted"
        />
      </label>

      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-2 max-h-[min(70vh,28rem)] overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-lg"
          // не терять фокус поля при клике по подсказке
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.length === 0 && <li className="px-4 py-3 text-sm text-muted">Ничего не нашлось</li>}
          {items.map((item, i) => {
            const names = bookNames(item, reader)
            return (
              <li
                key={item.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(item)}
                className={cn('flex cursor-pointer items-center gap-3 px-3 py-2', i === active && 'bg-surface-2')}
              >
                {item.cover ? (
                  <img src={item.cover} alt="" width={28} height={42} className="h-[42px] w-7 shrink-0 rounded-[2px] object-cover" />
                ) : (
                  <span className="h-[42px] w-7 shrink-0 rounded-[2px] bg-surface-2" aria-hidden />
                )}
                <span className="min-w-0">
                  <span lang={names.titleLang} className="line-clamp-1 text-sm font-medium">
                    {names.title}
                  </span>
                  {/* читающим по-русски — оригинал в строке под названием: «Gone Girl · Гиллиан Флинн · 2012» */}
                  <span className="line-clamp-1 text-xs text-muted">
                    {[names.originalTitle, names.author, item.year].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </li>
            )
          })}
          {onSubmitQuery && items.length > 0 && (
            <li
              role="option"
              aria-selected={false}
              onClick={() => {
                setOpen(false)
                onSubmitQuery(value.trim())
              }}
              className="cursor-pointer border-t border-line px-4 py-2.5 text-sm text-accent-text hover:bg-surface-2"
            >
              Все результаты по запросу «{value.trim()}»
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
