import { Star } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../lib/format.js'

const STARS = [1, 2, 3, 4, 5]

// Только показ: дробная заливка (4.6 → 4 полные звезды и 60% пятой)
function StaticStars({ value, size }) {
  return (
    <span className="inline-flex" role="img" aria-label={`Оценка ${value.toFixed(1)} из 5`}>
      {STARS.map((n) => {
        const fill = Math.max(0, Math.min(1, value - n + 1))
        return (
          <span key={n} className="relative inline-block" style={{ width: size, height: size }}>
            <Star size={size} className="absolute inset-0 text-line" fill="currentColor" strokeWidth={0} />
            <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
              <Star size={size} className="text-star" fill="currentColor" strokeWidth={0} />
            </span>
          </span>
        )
      })}
    </span>
  )
}

// Ввод оценки пользователя 1–5; повторный клик по той же звезде снимает оценку
function InputStars({ value, onChange, size }) {
  const [hover, setHover] = useState(0)
  const shown = hover || value || 0
  return (
    <span className="inline-flex" role="radiogroup" aria-label="Ваша оценка" onMouseLeave={() => setHover(0)}>
      {STARS.map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} из 5`}
          className="rounded p-0.5 transition-transform hover:scale-110"
          onMouseEnter={() => setHover(n)}
          onClick={() => onChange(value === n ? null : n)}
        >
          <Star
            size={size}
            className={n <= shown ? 'text-star' : 'text-line'}
            fill="currentColor"
            strokeWidth={0}
          />
        </button>
      ))}
    </span>
  )
}

export function RatingStars({ value = 0, onChange, size = 16, className }) {
  return (
    <span className={cn('inline-flex items-center', className)}>
      {onChange ? <InputStars value={value} onChange={onChange} size={size} /> : <StaticStars value={value} size={size} />}
    </span>
  )
}
