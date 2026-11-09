// Тексты объяснений «почему рекомендовано» (решения.md 3.8, объяснения; 5.9). ML-сервис отдаёт тип причины
// и id, бэкенд добавляет книгу-«зерно» целиком. Reason:
//   { kind, text?, seed?: { id, title, titleRu, author, authorRu }, section?, seedId? }
//   kind: similar {seed} · same_author {seed} · trending {section} · new · topic {section?} · popular · series
// Готовый text с бэкенда (как сейчас) показываем как есть; без text — собираем по типу.
// Короткий вариант — под карточкой в ленте (до двух строк), подробный — на странице книги.
import { bookNames } from './bookNames.js'
import { shortTitle } from './format.js'
import { sectionLabel } from './sections.js'

// «X» — название книги-зерна: русское, где есть и пользователь читает по-русски (5.6)
const titleOf = (seed, reader) => `«${shortTitle(bookNames(seed, reader).title)}»`

export function reasonText(reason, { detailed = false, reader = true, book } = {}) {
  if (!reason) return null
  if (reason.text) return reason.text
  const { kind, seed, section } = reason
  const label = section ? `«${sectionLabel(section)}»` : null
  switch (kind) {
    case 'similar':
      if (!seed) return 'Похожа на книги, которые вам понравились'
      return detailed ? `Похожа на ${titleOf(seed, reader)} — она вам понравилась` : `Похожа на ${titleOf(seed, reader)}`
    case 'same_author': {
      if (!seed) return 'Автор книг, которые вам понравились'
      const author = bookNames(seed, reader).author
      return detailed && author ? `${author} — автор ${titleOf(seed, reader)}, она вам понравилась` : `Тот же автор, что ${titleOf(seed, reader)}`
    }
    case 'trending':
      if (!label) return 'Популярно сейчас'
      return detailed ? `Популярно сейчас в разделе ${label}: много оценок за последний год` : `Популярно сейчас в ${label}`
    case 'new':
      return detailed ? (book?.year ? `Новинка ${book.year} года` : 'Новинка — вышла недавно') : 'Новинка'
    case 'topic':
      return detailed && label ? `В ваших темах — раздел ${label}` : 'В ваших темах'
    case 'popular':
      return 'Популярно у читателей'
    default:
      return null
  }
}
