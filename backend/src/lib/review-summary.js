// Сводка отзывов на карточке книги (решения.md 2.6.1, 3.6, 4.13) — таблицы review_summaries / review_summary_items
// (scripts/load-review-summary.js). Формат отдан фронтенду, менять — только через координатора:
//   { analyzed, overall: { verdict, sharePos, mentions, quotePos, quoteNeg } | null,
//     aspects: [{ aspect, label, verdict, sharePos, mentions, quotePos, quoteNeg }], info: [{ aspect, label, mentions, quotePos }] }
// Порядок — по rank. Сводки нет — null
import { prisma } from '../db.js'
import { editionKey } from './books.js'

const share = (v) => (v == null ? null : Math.round(v * 1000) / 1000)

// editionKey отбрасывает подзаголовок и номер в скобках: «Sapiens: A Graphic History, Volume 2» = «Sapiens: A Brief
// History…», «Confessions: The Private School Murders (Confessions, 2)» = «Confessions: The Murder of an Angel
// (Confessions, 4)». Для ленты терпимо, для сводки нет — чужие отзывы. Поэтому издание подходит, только если:
// обе книги одного вида (адаптация, пересказ, рабочая тетрадь — или нет), номер тома тот же (без номера — первый)
// и подзаголовки не расходятся: «A Novel», «… Anniversary Edition» — не подзаголовок; есть у обеих — должны совпасть;
// есть только у одной — должен описывать серию или жанр («Dune: Book One in the Dune Chronicles»), а не отдельную книгу
// франшизы («Fancy Nancy: JoJo and the Magic Trick», «Dceased: Dead Planet»). Сомнение — без сводки: лучше не показать,
// чем показать чужую
const DERIVATIVE = /\b(graphic (novel|history|adaptation)|manga|comics?|summary|study guide|workbook|coloring|companion|analysis|cliffs ?notes|sparknotes)\b/i
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, i: 1, ii: 2, iii: 3, iv: 4, v: 5 }
const VOLUME_WORD = /\b(?:book|vol\.?|volume|part|no\.)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|i{1,3}|iv|v)\b/i
const VOLUME = [
  VOLUME_WORD,
  /#\s*(\d+)/, // «Series #4»
  /\([^()]*?[,\s](\d+)\)/, // «(Confessions, 4)», «(Moon Saga 2)»
]
function volume(title) {
  for (const re of VOLUME) {
    const m = title.match(re)
    if (m) return Number(m[1]) || NUMBERS[m[1].toLowerCase()] || 1
  }
  return 1
}
// Подзаголовок без скобок и номера тома; из одних служебных слов — пусто
const SERVICE_WORD = /^(a|an|the|novel|memoir|edition|illustrated|anniversary|new|revised|updated|expanded|special|deluxe|collector's|gift|paperback|hardcover|mass|market|box|boxed|set|movie|tie|in|\d+(st|nd|rd|th)?)$/
const SERIES_WORD = /\b(novels?|saga|series|trilogy|chronicles?|cycle|quartet|mystery|mysteries|thriller|story|stories|adventure|romance|memoir)\b/
function subtitle(title) {
  const i = title.indexOf(':')
  if (i < 0) return ''
  const words = title.slice(i + 1).replace(/\(.*?\)|\[.*?\]/g, ' ').replace(new RegExp(VOLUME_WORD.source, 'gi'), ' ')
    .toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? []
  return words.every((w) => SERVICE_WORD.test(w)) ? '' : words.join(' ')
}
export function sameWork(a, b) {
  if (!editionKey(a) || editionKey(a) !== editionKey(b)) return false
  if (DERIVATIVE.test(a) !== DERIVATIVE.test(b) || volume(a) !== volume(b)) return false
  const [sa, sb] = [subtitle(a), subtitle(b)]
  if (sa && sb) return sa === sb
  return SERIES_WORD.test(sa || sb) || !(sa || sb)
}

// Чья сводка: своя, иначе — другого издания той же книги (тот же автор и sameWork: «Moon Tale» и «Moon Tale: The
// Illustrated Edition»), у которого проанализировано больше отзывов. У своих книг (ru / kz) отзывов Amazon нет
async function summarySource(book) {
  if (book.source !== 'amazon') return null
  const [own] = await prisma.$queryRaw`SELECT book_id, analyzed FROM review_summaries WHERE book_id = ${book.id}`
  if (own || !book.author) return own ?? null
  if (!editionKey(book.title)) return null
  const editions = await prisma.$queryRaw`
    SELECT s.book_id, s.analyzed, b.title FROM review_summaries s JOIN books b ON b.id = s.book_id
    WHERE b.author = ${book.author} AND b.id <> ${book.id}`
  return editions.filter((e) => sameWork(book.title, e.title))
    .sort((a, b) => b.analyzed - a.analyzed || a.book_id.localeCompare(b.book_id))[0] ?? null
}

export async function reviewSummaryFor(book) {
  const source = await summarySource(book)
  if (!source) return null
  const items = await prisma.$queryRaw`
    SELECT kind, aspect, label_ru, verdict, share_pos, mentions, quote_pos, quote_neg
    FROM review_summary_items WHERE book_id = ${source.book_id} ORDER BY rank`
  return formatSummary(source.analyzed, items)
}

// Строки review_summary_items (уже по rank) → формат ответа
export function formatSummary(analyzed, items) {
  const summary = { analyzed, overall: null, aspects: [], info: [] }
  for (const i of items) {
    if (i.kind === 'info') {
      summary.info.push({ aspect: i.aspect, label: i.label_ru, mentions: i.mentions, quotePos: i.quote_pos })
      continue
    }
    const point = { verdict: i.verdict, sharePos: share(i.share_pos), mentions: i.mentions, quotePos: i.quote_pos, quoteNeg: i.quote_neg }
    if (i.kind === 'overall') summary.overall ??= point
    else summary.aspects.push({ aspect: i.aspect, label: i.label_ru, ...point })
  }
  return summary
}
