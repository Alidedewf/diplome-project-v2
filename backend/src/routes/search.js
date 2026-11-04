// Поиск (2.5): гибридный — обычный (название, автор, ISBN, опечатки) и смысловой (эмбеддинги, ML-сервис)
// параллельно, смешивание RRF (3.5); автодополнение — только обычный.
import { Router } from 'express'
import { z } from 'zod'
import { Prisma, prisma } from '../db.js'
import { optionalAuth, prefersRussian } from '../lib/auth.js'
import { bookColumns, toBook } from '../lib/books.js'
import { semanticSearch } from '../lib/embeddings.js'
import { pageSchema, parse } from '../lib/http.js'
import { embedQuery } from '../services/ml.js'

export const router = Router()

// Меньше стольких точных совпадений — подмешиваем похожие по написанию
const FUZZY_BELOW = 5
// Гибрид: RRF_K — сглаживание мест в Reciprocal Rank Fusion (60 — стандартное значение, Cormack и др., 2009);
// в смешивание идут лучшие KEYWORD_DEPTH обычного поиска и SEMANTIC_DEPTH ближайших по смыслу
export const RRF_K = 60
const KEYWORD_DEPTH = 200
const SEMANTIC_DEPTH = 100
const SEMANTIC_MAX = 500 // mode=semantic: дальше этого места не листается
const TYPO_PIN = 0.7 // запрос с опечаткой: название с такой похожестью (word_similarity) — точное совпадение
// semWeight=auto: длинный запрос — скорее описание словами («книга про девушку, которая…»), где обычный поиск
// подмешивает книги со словом из запроса в названии; там смысловой части — больший вес
const AUTO_LONG_WORDS = 4
const AUTO_LONG_WEIGHT = 2
const SEM_WEIGHT = 2 // по умолчанию для всех запросов — по замеру ML (3.5); auto и параметр — для экспериментов
// Читающим по-русски (2.8): книги, известные по-русски, мягко выше. В RRF — добавка к сумме (≈ подъём с 30-го места
// обычного списка на 10-е), в обычном поиске — к релевантности (0,1 · ln(оценок) у книг с 50 и 400 оценками — 0,39 и 0,6).
// Точные совпадения — сверху как раньше
const RU_RRF_BOOST = 0.003
const RU_KEYWORD_BOOST = 0.2
export function semanticWeight(semWeight, q) {
  if (semWeight !== 'auto') return semWeight
  return (q.match(/[\p{L}\p{N}]+/gu) ?? []).length >= AUTO_LONG_WORDS ? AUTO_LONG_WEIGHT : 1
}

// year: «2015» или диапазон «2010-2015»
const yearSchema = z.string().regex(/^\d{4}(-\d{4})?$/, 'Год: 2015 или 2010-2015').transform((s) => {
  const [from, to = from] = s.split('-').map(Number)
  return { from, to }
})

const searchSchema = z.object({
  q: z.string().trim().min(1, 'Пустой запрос').max(200),
  section: z.string().min(1).optional(),
  year: yearSchema.optional(),
  rating: z.coerce.number().min(1).max(5).optional(), // минимальная средняя оценка
  hideRead: z.enum(['1', 'true', '0', 'false']).transform((v) => v === '1' || v === 'true').optional(),
  mode: z.enum(['hybrid', 'keyword', 'semantic']).default('hybrid'), // keyword и semantic — для сравнения (эксперимент E5)
  // Вес смысловой части в RRF (эксперимент E5): число 0–5 или auto — по длине запроса. По умолчанию 1 — как раньше
  semWeight: z.union([z.literal('auto'), z.coerce.number().min(0).max(5)]).default(SEM_WEIGHT),
  ...pageSchema,
})

// ISBN-10 → ISBN-13 (в базе хранится 13-значный)
function isbn13(raw) {
  const s = raw.replace(/[-\s]/g, '').toUpperCase()
  if (/^\d{13}$/.test(s)) return s
  if (!/^\d{9}[\dX]$/.test(s)) return null
  const core = '978' + s.slice(0, 9)
  const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0)
  return core + ((10 - (sum % 10)) % 10)
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c)

// Префиксный tsquery для автодополнения: «atomic hab» → atomic:* & hab:*
function prefixTsQuery(q) {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return words.length ? words.map((w) => `${w}:*`).join(' & ') : null
}

// Нормализованное имя автора: «J.K. Rowling» → «jkrowling». Выражение совпадает с индексом
// books_author_key_idx (миграция author_key_index) — иначе индекс не используется
const AUTHOR_KEY_SQL = Prisma.raw(`regexp_replace(lower(coalesce(author, '')), '[^[:alnum:]]', '', 'g')`)

// Имена авторов, совпадающие с запросом после нормализации (обычно одно, бывает «J.K. Rowling» и «J. K. Rowling»)
async function authorsNamed(q) {
  const key = q.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  if (key.length < 3) return []
  const rows = await prisma.$queryRaw`SELECT DISTINCT author FROM books WHERE ${AUTHOR_KEY_SQL} = ${key} LIMIT 20`
  return rows.map((r) => r.author)
}

function filters({ section, year, rating, hideRead }, user) {
  const parts = []
  if (section) parts.push(Prisma.sql`b.section = ${section}`)
  if (year) parts.push(Prisma.sql`b.year BETWEEN ${year.from} AND ${year.to}`)
  if (rating) parts.push(Prisma.sql`b.rating >= ${rating}`)
  if (hideRead && user) {
    parts.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM shelves s WHERE s.user_id = ${user.id} AND s.book_id = b.id AND s.shelf = 'read')`)
  }
  return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty
}

// ——— Обычный поиск ———

// ——— Опечатки ———
// Раньше: весь запрос похож на кусок названия/имени (word_similarity) с порогом 0,45 — его снизили с 0,6 ради
// «gillain flyn» (0,47). При 0,45 триграммы «the» плюс любое слово на «h» давали «the hobit» похожесть 0,5 с любым
// «The House…» — 11 тыс. кандидатов и 1,6 с. Теперь два пути, оба через GIN-индекс:
//   1) весь запрос (со стоп-словами — в названии между словами те же «on the»: без них «girl trian» похож на
//      «The Girl on the Train» на 0,45, с ними — на 0,76) похож на кусок названия/имени, <% с порогом 0,6;
//      запрос из одного значимого слова («the hobit») — само это слово, порог 0,45;
//   2) если по фразе меньше FUZZY_BELOW — каждое значимое слово (без стоп-слов) похоже на слово названия или имени
//      (<<%, strict_word_similarity ≥ 0,3); индекс пересекает списки по словам: «gillain flyn» → Gillian Flynn,
//      «the alchemyst coelho» (фамилия — автор). Все слова, и короткие тоже: пересечение узкое и быстрое
//      («gillain flyn» — 18 мс, 10 книг; без «flyn» — 945 книг; «thinking» без «fast slwo» — 7151 книга и 2,4 с)
const TYPO_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'about', 'how', 'what', 'where',
  'when', 'who', 'why', 'this', 'that', 'your', 'you', 'are', 'was', 'not', 'but', 'its', 'our', 'his', 'her'])
const TYPO_PHRASE = 0.6
const TYPO_PHRASE_ONE_WORD = 0.45
const TYPO_WORD = 0.3
const typoWords = (q) => (q.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => w.length >= 3 && !TYPO_STOP_WORDS.has(w))

// Пороги pg_trgm действуют через SET LOCAL — только в транзакции; она и открывается только в режиме опечаток
const withFuzzy = (plan, fn) => (plan.fuzzy
  ? prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(plan.phraseThreshold)}, true),
      set_config('pg_trgm.strict_word_similarity_threshold', ${String(TYPO_WORD)}, true)`
    return fn(tx)
  })
  : fn(prisma))

// Условие, порядок и число совпадений. Совпадение — по словам (стемминг), по подстроке названия/автора,
// по ISBN или ASIN. Порядок: точное название → начало названия → релевантность → популярность
async function keywordPlan(q, extra, ru = false) {
  const like = `%${escapeLike(q)}%`
  const isbn = isbn13(q)
  const match = Prisma.sql`(
    b.search_vector @@ websearch_to_tsquery('english', ${q})
    OR b.title ILIKE ${like} OR b.author ILIKE ${like} OR b.title_ru ILIKE ${like}
    ${isbn ? Prisma.sql`OR b.isbn13 = ${isbn}` : Prisma.empty}
    OR b.id = ${q.toUpperCase()})`
  // Запрос — имя автора («stephen king», «jk rowling»): сначала его книги по популярности,
  // а не сборники и путеводители с этим именем в названии (тест-кейс SRCH-02).
  // Есть ли такой автор — отдельный быстрый запрос по индексу books_author_key_idx; подъём включается,
  // только если есть, и сравнивает готовые имена — нормализация на каждой найденной книге тормозила широкие запросы
  const [authors, [{ total: exact }]] = await Promise.all([authorsNamed(q), prisma.$queryRaw`
    SELECT count(*)::int AS total FROM books b WHERE ${match} ${extra}`])
  const idHit = Prisma.sql`(${isbn ? Prisma.sql`coalesce(b.isbn13 = ${isbn}, false) OR` : Prisma.empty} b.id = ${q.toUpperCase()})`
  const relevance = Prisma.sql`(
    3 * (lower(b.title) = lower(${q}) OR coalesce(lower(b.title_ru) = lower(${q}), false))::int
    + 2 * (b.title ILIKE ${escapeLike(q) + '%'})::int
    + 5 * ${idHit}::int
    + ts_rank(b.search_vector, websearch_to_tsquery('english', ${q}))
    + word_similarity(${q}, b.title) + 0.5 * word_similarity(${q}, coalesce(b.author, ''))
    + 0.1 * ln(1 + b.ratings_count)
    ${ru ? Prisma.sql`+ ${RU_KEYWORD_BOOST}::float8 * b.ru_known::int` : Prisma.empty})`
  const authorHit = authors.length ? Prisma.sql`b.author = ANY(${authors}::text[])` : Prisma.sql`false`
  const score = authors.length ? Prisma.sql`CASE WHEN ${authorHit} THEN 100 + ln(1 + b.ratings_count) ELSE ${relevance} END` : relevance
  // Точные совпадения — всегда сверху, в гибриде тоже: название целиком или до «:» / «(»
  // («atomic habits» → «Atomic Habits: An Easy & Proven Way…»), ISBN или ASIN, полное имя автора
  const pinned = Prisma.sql`(lower(b.title) = lower(${q}) OR coalesce(lower(b.title_ru) = lower(${q}), false)
    OR lower(trim(regexp_replace(b.title, '\\s*[:(].*$', ''))) = lower(${q}) OR ${idHit} OR ${authorHit})`

  // Точных совпадений мало — добавляем похожие по написанию (триграммы, индекс gin_trgm_ops), см. «Опечатки»
  const fuzzy = exact < FUZZY_BELOW && q.length >= 3 && !isbn
  const words = typoWords(q)
  const everyWord = (column) => Prisma.join(words.map((w) => Prisma.sql`${w} <<% ${Prisma.raw(column)}`), ' AND ')
  const phrase = words.length === 1 ? words[0] : q
  const byPhrase = Prisma.sql`(${match} OR ${phrase} <% b.title OR ${phrase} <% b.author)`
  const byWords = words.length >= 2
    ? Prisma.join(words.map((w) => Prisma.sql`(${w} <<% b.title OR ${w} <<% b.author)`), ' AND ')
    : null
  const order = fuzzy
    ? Prisma.sql`${score} + 2 * greatest(word_similarity(${q}, b.title), word_similarity(${q}, coalesce(b.author, '')))`
    : score
  // Опечатка в имени автора или названии — тоже точный запрос: исправленные совпадения сверху, иначе смысловая
  // часть подмешивает «Flying with a Unicorn» выше романов Gillian Flynn («gillain flyn»). Автор — все значимые
  // слова похожи на слова имени; название — только очень похожее (TYPO_PIN: при 0,6 «the hobit» закреплял бы
  // 2000+ книг со словом «the»)
  const typoPinned = Prisma.sql`(${pinned} ${words.length ? Prisma.sql`OR (${everyWord('b.author')})` : Prisma.empty}
    OR word_similarity(${q}, b.title) >= ${TYPO_PIN})`
  const plan = {
    where: match, order, pinned: fuzzy ? typoPinned : pinned, extra, fuzzy, total: exact,
    phraseThreshold: words.length >= 2 ? TYPO_PHRASE : TYPO_PHRASE_ONE_WORD,
  }
  if (fuzzy) {
    // Кандидаты — одним запросом, дальше страницы и подсчёты идут по готовым id: иначе фраза (до ~120 мс на длинном
    // запросе) считалась бы заново при подсчёте 2-го этапа и при выборке строк. Пословный путь дорогой на частых словах
    // («pride», «harry» при пороге 0,3) — только если по фразе мало: условие на подзапрос Postgres проверяет один раз
    // до обхода индекса
    const ids = await withFuzzy(plan, (tx) => tx.$queryRaw`
      WITH phrase AS MATERIALIZED (SELECT b.id FROM books b WHERE ${byPhrase} ${extra})
      SELECT id FROM phrase
      ${byWords ? Prisma.sql`UNION SELECT b.id FROM books b WHERE (SELECT count(*) FROM phrase) < ${FUZZY_BELOW} AND ${byWords} ${extra}` : Prisma.empty}`)
    plan.where = Prisma.sql`b.id = ANY(${ids.map((r) => r.id)}::varchar[])`
    plan.total = ids.length
  }
  return plan
}

// Страница обычного поиска; exclude — уже показанные (продолжение гибрида)
const keywordRows = (plan, { limit, offset = 0, exclude = [] }) => withFuzzy(plan, (tx) => tx.$queryRaw`
  SELECT ${bookColumns('b')}, ${plan.pinned} AS pinned FROM books b
  WHERE ${plan.where} ${plan.extra} ${exclude.length ? Prisma.sql`AND NOT (b.id = ANY(${exclude}::varchar[]))` : Prisma.empty}
  ORDER BY ${plan.order} DESC, b.id LIMIT ${limit} OFFSET ${offset}`)

// ——— Смысловой поиск и смешивание ———

// Вектор запроса от ML-сервиса → ближайшие книги по HNSW с теми же фильтрами (строки books, по близости).
// null — сервис недоступен, векторов его модели нет в базе или запрос не уложился в таймаут:
// смысловая часть необязательна, её сбой не должен ронять поиск
async function semanticRows(q, extra, limit) {
  const emb = await embedQuery(q)
  if (!emb) return null
  try {
    return await semanticSearch(emb.vector, { model: emb.model, limit, where: extra, columns: bookColumns('b') })
  } catch (err) {
    console.warn(`Смысловой поиск не удался (${err.message.split('\n')[0]}) — только обычный`)
    return null
  }
}

// Reciprocal Rank Fusion: книга получает Σ вес / (RRF_K + место) по двум спискам (3.5); вес обычной части — 1,
// смысловой — semWeight (по умолчанию 2). Точные совпадения обычного поиска — сверху в его порядке, остальное — по сумме
// boosted — id книг, которым добавка RU_RRF_BOOST (известные по-русски, для читающих по-русски)
export function fuse(keyword, semantic, semWeight = SEM_WEIGHT, boosted = new Set()) {
  const score = new Map()
  const add = (id, rank, weight) => score.set(id, (score.get(id) ?? 0) + weight / (RRF_K + rank))
  keyword.forEach((r, i) => add(r.id, i + 1, 1))
  semantic.forEach((id, i) => add(id, i + 1, semWeight))
  for (const id of boosted) if (score.has(id)) score.set(id, score.get(id) + RU_RRF_BOOST)
  const pinned = keyword.filter((r) => r.pinned).map((r) => r.id)
  const pinnedSet = new Set(pinned)
  const kwRank = new Map(keyword.map((r, i) => [r.id, i]))
  const rest = [...score.keys()].filter((id) => !pinnedSet.has(id))
    .sort((a, b) => score.get(b) - score.get(a) || (kwRank.get(a) ?? Infinity) - (kwRank.get(b) ?? Infinity))
  return [...pinned, ...rest]
}

// GET /search?q=&section=&year=&rating=&hideRead=&mode= → { items: Book[], total, fuzzy, mode }
// mode: hybrid (по умолчанию) — обычный + смысловой, RRF; keyword — только обычный; semantic — только смысловой.
// В ответе mode — каким поиском найдено на самом деле: ML-сервис недоступен — keyword, без ошибки.
// fuzzy: true — точных совпадений мало, к ним добавлены похожие написания (исправление опечаток)
router.get('/search', optionalAuth, async (req, res) => {
  const params = parse(searchSchema, req.query)
  const { q, limit, offset } = params
  const extra = filters(params, req.user)
  const asked = params.mode
  const ru = prefersRussian(req.user)

  // Обе части — параллельно до конца: обычная сразу считает лучшие KEYWORD_DEPTH (для гибрида), смысловая —
  // вектор запроса и ближайшие книги
  const semanticLimit = asked === 'semantic' ? Math.min(Math.max(SEMANTIC_DEPTH, offset + limit), SEMANTIC_MAX) : SEMANTIC_DEPTH
  const keywordPart = async () => {
    const plan = await keywordPlan(q, extra, ru)
    return { plan, top: asked === 'hybrid' ? await keywordRows(plan, { limit: KEYWORD_DEPTH }) : null }
  }
  const [kw, semantic] = await Promise.all([
    asked === 'semantic' ? null : keywordPart(),
    asked === 'keyword' ? null : semanticRows(q, extra, semanticLimit),
  ])
  const plan = kw?.plan

  let mode, items, total
  if (semantic && asked === 'semantic') {
    mode = 'semantic'
    total = semantic.length
    items = semantic.slice(offset, offset + limit)
  } else if (semantic) {
    mode = 'hybrid'
    const { top } = kw
    const boosted = ru ? new Set([...top, ...semantic].filter((r) => r.ru_known).map((r) => r.id)) : undefined
    const fused = fuse(top, semantic.map((r) => r.id), semanticWeight(params.semWeight, q), boosted)
    // Найдено = совпадения обычного поиска + смысловые находки, которых среди них нет
    const inTop = new Set(top.map((r) => r.id))
    const extraFound = semantic.filter((r) => !inTop.has(r.id)).map((r) => r.id)
    const alsoKeyword = extraFound.length && plan.total > top.length
      ? await withFuzzy(plan, (tx) => tx.$queryRaw`SELECT b.id FROM books b WHERE b.id = ANY(${extraFound}::varchar[]) AND ${plan.where}`)
      : []
    total = plan.total + extraFound.length - alsoKeyword.length
    // Страница: сначала смешанный список, за ним — продолжение обычного поиска без уже показанного
    const byId = new Map([...semantic, ...top].map((r) => [r.id, r]))
    const head = fused.slice(offset, offset + limit).map((id) => byId.get(id))
    const tail = head.length < limit && plan.total > top.length
      ? await keywordRows(plan, { limit: limit - head.length, offset: Math.max(0, offset - fused.length), exclude: fused })
      : []
    items = [...head, ...tail]
  } else {
    mode = 'keyword'
    const p = plan ?? (await keywordPlan(q, extra, ru))
    total = p.total
    // Гибрид без смысловой части: лучшие KEYWORD_DEPTH уже посчитаны
    items = kw?.top && offset + limit <= kw.top.length
      ? kw.top.slice(offset, offset + limit)
      : await keywordRows(p, { limit, offset })
  }
  const fuzzy = mode !== 'semantic' && Boolean(plan?.fuzzy)

  // Поисковый запрос — неявный сигнал для рекомендаций (2.5); пишем только первую страницу
  if (req.user && offset === 0) {
    await prisma.event.create({ data: { userId: req.user.id, type: 'search', query: q, payload: { total, fuzzy, mode } } })
  }

  res.json({ items: items.map((r) => toBook(r)), total, fuzzy, mode })
})

const suggestSchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(8),
})

// GET /search/suggest?q= → [{ id, title, titleRu, author, authorRu, year, cover }] — автодополнение при вводе.
// Начало названия — и английского, и русского (2.8).
// Скрытые пользователем книги («Не интересно») в подсказках не показываем (тест-кейс SRCH-15)
router.get('/search/suggest', optionalAuth, async (req, res) => {
  const { q, limit } = parse(suggestSchema, req.query)
  const tsq = prefixTsQuery(q)
  const rows = await prisma.$queryRaw`
    SELECT b.id, b.title, b.title_ru AS "titleRu", b.author, b.author_ru AS "authorRu", b.year, b.cover FROM books b
    WHERE (b.title ILIKE ${escapeLike(q) + '%'} OR b.title_ru ILIKE ${escapeLike(q) + '%'}
      ${tsq ? Prisma.sql`OR b.search_vector @@ to_tsquery('english', ${tsq})` : Prisma.empty})
      ${req.user
        ? Prisma.sql`AND NOT EXISTS (SELECT 1 FROM hidden_books h WHERE h.user_id = ${req.user.id} AND h.book_id = b.id)`
        : Prisma.empty}
    ORDER BY (b.title ILIKE ${escapeLike(q) + '%'} OR coalesce(b.title_ru ILIKE ${escapeLike(q) + '%'}, false)) DESC,
      b.ratings_count DESC
    LIMIT ${limit}`
  res.json(rows)
})
