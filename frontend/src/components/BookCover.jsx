import { useState } from 'react'
import { cn } from '../lib/format.js'
import { useBookNames } from '../lib/useBookNames.js'

// Спокойные «книжные» тона для заглушек; выбор стабилен для книги
const PLACEHOLDER_TONES = [
  'bg-[#2e5e4e] text-[#f1ede4]',
  'bg-[#6b4e3d] text-[#f4ebe0]',
  'bg-[#3c4a63] text-[#e9edf4]',
  'bg-[#7a6a4f] text-[#f6f0e3]',
  'bg-[#5b3f52] text-[#f3e8ef]',
  'bg-[#44514a] text-[#ecefe9]',
]

function tone(id = '') {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PLACEHOLDER_TONES[h % PLACEHOLDER_TONES.length]
}

// withBadge — сверху на обложке пометка (язык оригинала): название уходит ниже, чтобы она его не закрывала
function CoverPlaceholder({ book, withBadge }) {
  const names = useBookNames(book)
  return (
    <div className={cn('absolute inset-0 flex flex-col justify-between p-[8%]', withBadge && 'pt-9', tone(book?.id))} aria-hidden>
      <p lang={names.titleLang} className="line-clamp-5 font-serif text-[clamp(0.7rem,10cqw,1.4rem)] leading-tight font-semibold hyphens-auto [overflow-wrap:anywhere]">
        {names.title}
      </p>
      <p lang={names.authorLang} className="line-clamp-2 text-[0.7rem] leading-tight opacity-80">
        {names.author}
      </p>
    </div>
  )
}

// Пока картинка грузится (или если её нет) видна заглушка с названием и автором; загруженная картинка
// плавно проявляется поверх. Размер задаёт рамка 2:3, так что загрузка ничего не сдвигает.
// alt пустой: название и автор всегда написаны рядом с обложкой.
// badge — элемент поверх обложки в левом верхнем углу (OriginChip)
export function BookCover({ book, className, eager = false, badge }) {
  // 'loading' | 'loaded' | 'cached' (уже была в кэше браузера — показываем сразу, без анимации) | 'error'
  const [status, setStatus] = useState('loading')

  // картинка из кэша бывает готова сразу при монтировании — тогда не мигаем заглушкой
  const checkCached = (img) => {
    if (img?.complete && img.naturalWidth > 0) setStatus((s) => (s === 'loading' ? 'cached' : s))
  }

  return (
    <div className={cn('@container relative aspect-[2/3] overflow-hidden rounded-cover shadow-cover', className)}>
      {status !== 'cached' && <CoverPlaceholder book={book} withBadge={Boolean(badge)} />}
      {book?.cover && status !== 'error' && (
        <img
          ref={checkCached}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          width={200}
          height={300}
          src={book.cover}
          alt=""
          onLoad={() => setStatus((s) => (s === 'loading' ? 'loaded' : s))}
          onError={() => setStatus('error')}
          className={cn(
            'absolute inset-0 size-full object-cover',
            status === 'loading' ? 'opacity-0' : 'opacity-100',
            status !== 'cached' && 'transition-opacity duration-500',
          )}
        />
      )}
      {badge && <div className="absolute top-2 left-2">{badge}</div>}
      {/* тонкий «корешок» слева — чтобы обложка читалась как книга */}
      <span className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-black/10" aria-hidden />
    </div>
  )
}
