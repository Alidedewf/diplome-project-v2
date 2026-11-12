// Тексты объяснений «почему рекомендовано» (решения.md 3.8, объяснения; 4.11; 5.9). ML-сервис отдаёт тип причины
// и id, бэкенд добавляет книгу-«зерно» целиком. Reason:
//   { kind, text?, seed?: { id, title, titleRu, author, authorRu }, section?, seedId? }
//   kind: similar {seed} · same_author {seed} · trending {section} · new · topic {section?} · popular · series
//         · own_catalog {seed?} — слот своего каталога в «Для вас» (метку «Русская / Казахская литература» ставит карточка)
// Лента из ML (forYouSource: 'ml', 4.12) — без text, собираем по типу; лента на правилах ('rules') — готовый text,
// показываем как есть. Нет причины — null, без подписи.
// Короткий вариант — под карточкой в ленте (до двух строк), подробный — на странице книги.
import { bookNames } from './bookNames.js'
import { shortTitle } from './format.js'
import { sectionLabel } from './sections.js'

// Название книги-зерна — отдельной частью, чтобы WhyRecommended сделал его ссылкой на её страницу.
// Русское, где есть и пользователь читает по-русски (5.6)
const seedPart = (seed, reader) => ({
  seed,
  text: `«${shortTitle(bookNames(seed, reader).title)}»`,
})

// → [строка | { seed, text }] или null (без подписи)
export function reasonParts(reason, { detailed = false, reader = true, book } = {}) {
  if (!reason) return null
  if (reason.text) return [reason.text]
  const { kind, seed, section } = reason
  const label = section ? `«${sectionLabel(section)}»` : null
  switch (kind) {
    case 'similar':
    case 'own_catalog':
      if (!seed) return kind === 'similar' ? ['Похожа на книги, которые вам понравились'] : null
      return detailed
        ? ['Похожа на ', seedPart(seed, reader), ' — она вам понравилась']
        : ['Похожа на ', seedPart(seed, reader)]
    case 'same_author': {
      if (!seed) return ['Автор книг, которые вам понравились']
      const author = bookNames(seed, reader).author
      return detailed && author
        ? [`${author} — автор `, seedPart(seed, reader), ', она вам понравилась']
        : ['Тот же автор, что у ', seedPart(seed, reader)]
    }
    case 'trending':
      if (!label) return ['Популярно сейчас']
      return [
        detailed ? `Популярно сейчас в разделе ${label}: много оценок за последний год` : `Популярно сейчас в ${label}`,
      ]
    case 'new':
      return [detailed ? (book?.year ? `Новинка ${book.year} года` : 'Новинка — вышла недавно') : 'Новинка']
    case 'topic':
      if (!label) return ['В ваших темах']
      return [detailed ? `В ваших темах — раздел ${label}` : `Из темы ${label}`]
    case 'popular':
      return ['Популярно у читателей']
    default:
      return null
  }
}

// Подпись одной строкой (title=, aria, события)
export function reasonText(reason, options) {
  return (
    reasonParts(reason, options)
      ?.map((p) => (typeof p === 'string' ? p : p.text))
      .join('') ?? null
  )
}
