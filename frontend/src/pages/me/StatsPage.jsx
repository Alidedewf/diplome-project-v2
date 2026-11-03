import { BarChart3, ChevronLeft, ChevronRight, Pencil, Star, Target } from 'lucide-react'
import { useState } from 'react'
import { useSetGoal, useStats } from '../../api/queries.js'
import { useAuth } from '../../auth/context.js'
import { Button } from '../../components/Button.jsx'
import { cn, formatCount, plural } from '../../lib/format.js'
import { EmptyLinks, EmptyState, PageHeader } from './parts.jsx'

// Статистика чтения (2.2, п. 5). Графики — на CSS, без библиотеки: три простых столбчатых графика
// в одну серию (один цвет — акцент), подсказка при наведении и фокусе, таблица для экранных читалок
const BOOKS = { one: 'книга', few: 'книги', many: 'книг' }
const RATINGS = { one: 'оценка', few: 'оценки', many: 'оценок' }
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const MONTH_NAMES = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleString('ru-RU', { month: 'long' }))
const ratingFmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

function Card({ title, children, className }) {
  return (
    <section className={cn('rounded-2xl border border-line bg-surface p-4 sm:p-5', className)}>
      {title && <h2 className="mb-4 font-semibold">{title}</h2>}
      {children}
    </section>
  )
}

function Tile({ label, value, note }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3 sm:p-4">
      <p className="text-xs text-muted sm:text-sm">{label}</p>
      <p className="mt-1 font-serif text-2xl font-semibold tabular-nums sm:text-3xl">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </div>
  )
}

// Прочитано по месяцам: одна линия сетки на максимуме, подпись значения — в подсказке
function MonthsChart({ byMonth, year, now }) {
  const max = Math.max(1, ...byMonth.map((m) => m.count))
  const future = (month) => year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1)
  return (
    <figure>
      <div className="relative ml-6 flex h-40 items-end gap-1 border-b border-line sm:gap-2">
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-line" aria-hidden>
          <span className="absolute top-0 -left-6 -translate-y-1/2 text-xs text-muted tabular-nums">{max}</span>
        </div>
        {byMonth.map(({ month, count }) => {
          const pct = count ? Math.max(4, (count / max) * 100) : 0
          return (
            <div
              key={month}
              tabIndex={0}
              aria-label={`${MONTH_NAMES[month - 1]}: ${formatCount(count, BOOKS)}`}
              className="group relative flex h-full flex-1 items-end justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {count > 0 && <div className="w-full max-w-8 rounded-t-[4px] bg-accent transition-colors group-hover:bg-accent-hover" style={{ height: `${pct}%` }} />}
              <div
                role="tooltip"
                className="pointer-events-none absolute z-10 hidden -translate-y-2 rounded-md bg-ink px-2 py-1 text-xs whitespace-nowrap text-paper group-hover:block group-focus-visible:block"
                style={{ bottom: `${pct}%` }}
              >
                {MONTH_NAMES[month - 1]}: {formatCount(count, BOOKS)}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-2 ml-6 flex gap-1 sm:gap-2" aria-hidden>
        {byMonth.map(({ month }) => (
          <span key={month} className={cn('flex-1 text-center text-[0.7rem] text-muted', future(month) && 'opacity-50')}>
            {MONTHS[month - 1]}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>Прочитано по месяцам, {year}</caption>
        <tbody>
          {byMonth.map(({ month, count }) => (
            <tr key={month}>
              <th scope="row">{MONTH_NAMES[month - 1]}</th>
              <td>{count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

// Горизонтальные полосы с подписями: разделы и распределение оценок
function Bars({ rows, labelClass }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,9rem)_1fr_2rem] items-center gap-3 text-sm sm:grid-cols-[minmax(0,12rem)_1fr_2rem]">
          <span className={cn('truncate', labelClass)} title={typeof r.label === 'string' ? r.label : undefined}>
            {r.label}
          </span>
          <span className="h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            {r.count > 0 && <span className="block h-full rounded-r-[4px] bg-accent" style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }} />}
          </span>
          <span className="text-right text-muted tabular-nums">{r.count}</span>
        </li>
      ))}
    </ul>
  )
}

function GoalForm({ year, initial, onDone }) {
  const goal = useSetGoal()
  const [value, setValue] = useState(initial ?? '')
  const submit = (e) => {
    e.preventDefault()
    goal.mutate({ target: Number(value), year }, { onSuccess: onDone })
  }
  const error = goal.error?.details?.[0]?.message ?? goal.error?.message
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor="goal-target" className="text-sm text-muted">
        Сколько книг хотите прочитать в {year} году?
      </label>
      <div className="flex gap-2">
        <input
          id="goal-target"
          type="number"
          inputMode="numeric"
          min={1}
          max={1000}
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={Boolean(error)}
          className="h-10 w-28 rounded-lg border border-line bg-surface px-3 text-sm tabular-nums outline-none focus:border-accent"
        />
        <Button type="submit" variant="primary" disabled={goal.isPending || !value}>
          {goal.isPending ? 'Сохраняем…' : 'Сохранить'}
        </Button>
        {initial && (
          <Button variant="ghost" onClick={onDone}>
            Отмена
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </form>
  )
}

function Goal({ stats, now }) {
  const [editing, setEditing] = useState(false)
  const { goal, year } = stats

  if (!goal || editing) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <Target size={20} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
          <div className="flex-1">
            <h2 className="mb-2 font-semibold">Цель на {year} год</h2>
            <GoalForm year={year} initial={goal?.target} onDone={() => setEditing(false)} />
          </div>
        </div>
      </Card>
    )
  }

  const pct = Math.min(1, goal.done / goal.target)
  const left = goal.target - goal.done
  const monthsLeft = year === now.getFullYear() ? 12 - now.getMonth() : 0
  const note =
    left <= 0
      ? 'Цель выполнена — так держать!'
      : monthsLeft > 0
        ? `Осталось ${formatCount(left, BOOKS)} — примерно ${Math.ceil(left / monthsLeft)} в месяц`
        : `Осталось ${formatCount(left, BOOKS)}`

  return (
    <Card>
      <div className="flex items-start gap-3">
        <Target size={20} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">Цель на {year} год</h2>
              <p className="mt-1 font-serif text-2xl font-semibold tabular-nums">
                {goal.done} <span className="text-base font-normal text-muted">из {formatCount(goal.target, BOOKS)}</span>
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Изменить цель">
              <Pencil size={14} aria-hidden /> Изменить
            </Button>
          </div>
          <div
            className="h-2.5 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-label={`Цель на ${year} год`}
            aria-valuemin={0}
            aria-valuemax={goal.target}
            aria-valuenow={Math.min(goal.done, goal.target)}
          >
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct * 100}%` }} />
          </div>
          <p className="text-sm text-muted">
            {Math.round(pct * 100)}% · {note}
          </p>
        </div>
      </div>
    </Card>
  )
}

function StatsSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-4" aria-busy>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 rounded-2xl bg-surface-2 sm:h-28" />
        ))}
      </div>
      <div className="h-36 rounded-2xl bg-surface-2" />
      <div className="h-64 rounded-2xl bg-surface-2" />
    </div>
  )
}

export function StatsPage() {
  const { user } = useAuth()
  // «сейчас» фиксируем при открытии экрана: от него зависят прошедшие месяцы и темп для цели
  const [now] = useState(() => new Date())
  const thisYear = now.getFullYear()
  const firstYear = Math.min(thisYear, new Date(user.createdAt).getFullYear())
  const [year, setYear] = useState(thisYear)
  const stats = useStats(year)
  const s = stats.data

  const switcher = firstYear < thisYear && (
    <div className="flex items-center gap-1" aria-label="Год">
      <Button size="icon" variant="ghost" className="size-9" disabled={year <= firstYear} onClick={() => setYear(year - 1)} aria-label="Предыдущий год">
        <ChevronLeft size={18} />
      </Button>
      <span className="w-12 text-center font-medium tabular-nums">{year}</span>
      <Button size="icon" variant="ghost" className="size-9" disabled={year >= thisYear} onClick={() => setYear(year + 1)} aria-label="Следующий год">
        <ChevronRight size={18} />
      </Button>
    </div>
  )

  const sections = s?.bySection.slice(0, 6).map((r) => ({ key: r.section, label: r.label, count: r.count })) ?? []
  const ratings = s ? [5, 4, 3, 2, 1].map((n) => ({ key: n, label: <RatingLabel n={n} />, count: s.ratings.distribution[n] })) : []

  return (
    <>
      <PageHeader title="Статистика чтения" subtitle="Книга считается прочитанной, когда попадает на полку «Прочитал»." action={switcher} />

      {stats.error ? (
        <p role="alert" className="text-muted">
          Не удалось загрузить статистику. {stats.error.message}
        </p>
      ) : !s ? (
        <StatsSkeleton />
      ) : (
        <div className={cn('flex flex-col gap-4 transition-opacity', stats.isPlaceholderData && 'opacity-60')}>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <Tile label={`Прочитано в ${s.year}`} value={s.readThisYear} note={plural(s.readThisYear, BOOKS)} />
            <Tile label="Всего прочитано" value={s.readTotal} note={plural(s.readTotal, BOOKS)} />
            <Tile
              label="Средняя оценка"
              value={s.ratings.average ? ratingFmt.format(s.ratings.average) : '—'}
              note={s.ratings.count ? formatCount(s.ratings.count, RATINGS) : 'оценок пока нет'}
            />
          </div>

          <Goal key={s.year} stats={s} now={now} />

          {s.readTotal === 0 && s.ratings.count === 0 ? (
            <EmptyState icon={BarChart3} title="Здесь появятся графики" actions={<EmptyLinks />}>
              Отмечайте прочитанные книги и ставьте оценки — увидите, сколько читаете по месяцам и какие темы любите.
            </EmptyState>
          ) : (
            <>
              <Card title={`Прочитано по месяцам, ${s.year}`}>
                <MonthsChart byMonth={s.byMonth} year={s.year} now={now} />
              </Card>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card title="Любимые разделы">
                  {sections.length ? <Bars rows={sections} /> : <p className="text-sm text-muted">Пока нет прочитанных книг.</p>}
                </Card>
                <Card title="Ваши оценки">
                  {s.ratings.count ? <Bars rows={ratings} /> : <p className="text-sm text-muted">Пока нет оценок.</p>}
                </Card>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

function RatingLabel({ n }) {
  return (
    <span className="inline-flex items-center gap-1" aria-label={`${n} из 5`}>
      {n} <Star size={12} className="text-star" fill="currentColor" strokeWidth={0} aria-hidden />
    </span>
  )
}
