// Рекомендации (решения.md, 3.3, 3.8 и 4.2): популярное в темах пользователя; похожие книги — соседи по вектору
// (content-модель, e5, pgvector), без вектора — по разделу/подразделу; раунды онбординга по подразделам и по
// описанию своими словами. Маршруты зовут только функции этого модуля — при появлении рекомендаций
// ML-сервиса они заменяются HTTP-запросами к нему, форма ответов та же.
import { config } from '../config.js'
import { Prisma, prisma } from '../db.js'
import { prefersRussian } from '../lib/auth.js'
import { bookColumns, capPerAuthor, editionKey, littleKids, oneEdition, shortTitle, titleWords, toBook } from '../lib/books.js'
import { byTaste, nearestBooksTo, semanticSearch } from '../lib/embeddings.js'
import { sectionLabel } from '../lib/sections.js'
import { embedQuery } from './ml.js'

// Раунд 1 онбординга: сколько книг — ближайших к описанию своими словами (3.4)
const DESCRIPTION_BOOKS = 4

const ONBOARDING_ROUND_SIZE = 12
const ONBOARDING_MAX_ROUNDS = 3
const ONBOARDING_STOP_LIKES = 5 // «остановка при 5+ ответах «Нравится»» (3.4)
// «Популярное в теме»: из стольких самых популярных книг темы берутся лучшие по взвешенному рейтингу.
// Чистый взвешенный рейтинг поднимает малоизвестные циклы с небольшим числом преданных читателей
const POPULAR_POOL = 200
// Раздел с книгами для малышей: их показываем, только если пользователь сам выбрал этот раздел или ему понравилась
// такая книга (иначе лайк «Голодных игр» из Children's Books приводил в ленту Gruffalo и Pete the Cat)
const CHILDREN_SECTION = "Children's Books"

// Читающим по-русски (2.8, эксперимент): книги, известные по-русски (ru_known — русское имя автора или название
// в Wikidata), — мягко выше; «популярное» — сначала среди них, не хватило — остальные
const RU_FEED_BOOST = 0.08 // «Для вас»: к взвешенному рейтингу (у популярных книг раздела он ~3,9–4,7); 0,15 — почти фильтр
const RU_SIMILAR_BOOST = 0.01 // «Похожие»: к близости (≈ разница между книгами с 10 и 120 оценками, см. POPULARITY_WEIGHT)
const ruFirst = (ru, alias = 'b') => (ru ? Prisma.sql`${Prisma.raw(alias ? `${alias}.` : '')}ru_known DESC,` : Prisma.empty)
// Название для объяснений «Похожа на «…»»: читающим по-русски — русское, если есть
const titleFor = (book, ru) => shortTitle((ru && book.titleRu) || book.title)

// ——— Профиль пользователя ———

// Что известно о пользователе: понравившиеся книги, темы, что исключить из выдачи
export async function loadProfile(userId) {
  const [likedRows, topics, excludedRows, user] = await Promise.all([
    // Понравилось: оценки 4–5 и «Нравится» в онбординге; сначала пятёрки, затем свежие
    prisma.$queryRaw`
      SELECT ${bookColumns('b')}, src.score, src.via, ${littleKids('b')} AS little
      FROM (
        SELECT book_id, value AS score, 'rating' AS via, updated_at AS at
        FROM ratings WHERE user_id = ${userId} AND value >= 4
        UNION ALL
        SELECT book_id, 4, 'onboarding', created_at
        FROM events WHERE user_id = ${userId} AND type = 'onboarding_answer' AND payload->>'answer' = 'like'
      ) src
      JOIN books b ON b.id = src.book_id
      ORDER BY src.score DESC, src.at DESC
      LIMIT 100`,
    prisma.userTopic.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    // Не показывать: оценённое, всё на полках, скрытое, «Не моё» в онбординге
    prisma.$queryRaw`
      SELECT book_id AS id FROM ratings WHERE user_id = ${userId}
      UNION SELECT book_id FROM shelves WHERE user_id = ${userId}
      UNION SELECT book_id FROM hidden_books WHERE user_id = ${userId}
      UNION SELECT book_id FROM events
        WHERE user_id = ${userId} AND type = 'onboarding_answer' AND payload->>'answer' = 'dislike'`,
    prisma.user.findUnique({ where: { id: userId }, select: { readingLanguages: true } }),
  ])

  const liked = []
  const likedIds = new Set()
  for (const row of likedRows) {
    if (likedIds.has(row.id)) continue
    likedIds.add(row.id)
    liked.push({ ...toBook(row), score: row.score, via: row.via, little: row.little })
  }

  const rejected = { section: new Set(), subsection: new Set(), author: new Set() }
  for (const t of topics) if (t.rejected) rejected[t.kind].add(t.value)

  // Темы: сначала выбранные явно, затем разделы понравившихся книг по частоте
  const sections = []
  const addSection = (s) => {
    if (s && !rejected.section.has(s) && !sections.includes(s)) sections.push(s)
  }
  for (const t of topics) if (!t.rejected && t.kind === 'section') addSection(t.value)
  const freq = new Map()
  for (const b of liked) if (b.section) freq.set(b.section, (freq.get(b.section) ?? 0) + 1)
  for (const [s] of [...freq].sort((a, b) => b[1] - a[1])) addSection(s)

  const visibleLiked = liked.filter((b) => !rejected.subsection.has(b.subsection) && !rejected.author.has(b.author))
  const kids = liked.some((b) => b.little) || topics.some((t) => t.source === 'onboarding' && !t.rejected
    && t.kind === 'section' && t.value === CHILDREN_SECTION)
  return { liked: visibleLiked, sections, rejected, excluded: excludedRows.map((r) => r.id), ru: prefersRussian(user), kids }
}

// Фильтр выдачи: без исключённых книг и тем «Это не про меня»
function profileFilter(profile, alias = 'b') {
  const t = Prisma.raw(alias)
  if (!profile) return Prisma.empty
  return Prisma.sql`
    AND NOT (${t}.id = ANY(${profile.excluded}::varchar[]))
    AND coalesce(${t}.subsection, '') <> ALL(${[...profile.rejected.subsection]}::text[])
    AND coalesce(${t}.author, '') <> ALL(${[...profile.rejected.author]}::text[])
    ${profile.kids ? Prisma.empty : Prisma.sql`AND NOT ${littleKids(alias)}`}`
}

// ——— Объяснения «почему» ———

// Reason { kind: 'similar' | 'topic' | 'popular', text, seedId? }; short — для ленты (до двух строк),
// detailed — для плашки на странице книги
export function reasonFor(book, profile, { detailed = false } = {}) {
  if (!profile) return null
  const twin = profile.liked.find((l) => l.id !== book.id && l.subsection && l.subsection === book.subsection)
  if (twin) {
    const text = `Похожа на «${titleFor(twin, profile.ru)}»`
    const why = twin.via === 'rating' ? `вы оценили её на ${twin.score}` : 'она вам понравилась'
    return { kind: 'similar', text: detailed ? `${text} — ${why}` : text, seedId: twin.id }
  }
  if (profile.sections.includes(book.section)) {
    const section = sectionLabel(book.section)
    const text = detailed && book.rating != null
      ? `Из вашей темы «${section}», читатели оценивают её в ${book.rating.toFixed(1)}`
      : `Ваша тема: ${section}`
    return { kind: 'topic', text }
  }
  return null
}

const POPULAR_REASON = { kind: 'popular', text: 'Популярно у читателей' }

// ——— Запросы ———

// Одно издание на название: берём с запасом
async function popular({ limit, profile, ru = profile?.ru }) {
  const rows = await prisma.$queryRaw`
    SELECT ${bookColumns('b')} FROM books b
    WHERE b.section IS NOT NULL ${profileFilter(profile)}
    ORDER BY ${ruFirst(ru)} b.ratings_count DESC LIMIT ${limit * 2}`
  return oneEdition(rows.map((r) => toBook(r))).slice(0, limit)
}

// Популярное в каждом из разделов — одним запросом, по индексу (section, ratings_count)
async function topInSections(sections, { perSection, profile }) {
  if (!sections.length) return new Map()
  const rows = await prisma.$queryRaw`
    SELECT s.section AS topic, b.* FROM unnest(${sections}::text[]) AS s(section)
    CROSS JOIN LATERAL (
      SELECT * FROM (
        SELECT ${bookColumns('x')}, x.weighted_rating FROM books x
        WHERE x.section = s.section ${profileFilter(profile, 'x')}
        ORDER BY x.ratings_count DESC LIMIT ${POPULAR_POOL}
      ) pool ORDER BY weighted_rating + ${profile?.ru ? RU_FEED_BOOST : 0}::float8 * ru_known::int DESC LIMIT ${perSection}
    ) b`
  const bySection = new Map(sections.map((s) => [s, []]))
  for (const r of rows) bySection.get(r.topic).push(toBook(r))
  return bySection
}

// По очереди из каждой очереди, без повторов
function roundRobin(queues, limit, taken = new Set()) {
  const out = []
  for (let i = 0; out.length < limit && queues.some((q) => q[i]); i++) {
    for (const q of queues) {
      const b = q[i]
      if (b && !taken.has(b.id) && out.length < limit) {
        taken.add(b.id)
        out.push(b)
      }
    }
  }
  return out
}

// ——— Похожие книги ———

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'for', 'with', 'how', 'what', 'where', 'why', 'my', 'your'])
const FRANCHISE_MAX = 2 // книг «франшизы» самой книги в ряду (3.3: серию можно показать 1–2 книгами, остальное — другие авторы)
const hasPhrase = (text, phrase) => phrase.length >= 4 && ` ${text} `.includes(` ${phrase} `)
const fullText = (title) => (title.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).join(' ')

// Ряд похожих без засилья самой книги: одно издание на название; «франшиза» (тот же автор, книги о книге —
// «The Science of Dune», «The Hunger Games and Philosophy», сборники «The Complete Gillian Flynn») — не больше
// FRANCHISE_MAX; остальные авторы — не больше 2 книг каждый
function diversify(seed, books, limit) {
  const key = titleWords(seed.title).filter((w) => !STOP_WORDS.has(w)).slice(0, 2).join(' ')
  const author = seed.author ? fullText(seed.author) : ''
  const isFranchise = (b) => (seed.author && b.author === seed.author) || hasPhrase(fullText(b.title), key)
    || (author.includes(' ') && hasPhrase(fullText(b.title), author))
  const editions = new Set([editionKey(seed.title)])
  let franchise = 0
  const picked = []
  for (const b of books) {
    const edition = editionKey(b.title)
    if (editions.has(edition)) continue
    if (isFranchise(b)) {
      if (franchise >= FRANCHISE_MAX) continue
      franchise++
    }
    editions.add(edition)
    picked.push(b)
  }
  return capPerAuthor(picked).slice(0, limit)
}

// Похожие по смыслу (2.6, content-модель 3.2): соседи по вектору книги (без лимитов 84–90% соседей —
// книги того же автора и той же серии, см. diversify).
// Векторы e5 скучены: у 50-го и 200-го соседа близость различается на ~0,01, и внутри этой полосы порядок почти
// случаен — малоизвестная «The Hunger Pains: A Parody» выше «Legend» (370 оценок). Поэтому к близости — небольшая
// добавка за популярность (как в формуле ленты 3.3): близких соседей (0,9+) она не трогает, среди равных поднимает известных
const SIMILAR_CANDIDATES = 100
const POPULARITY_WEIGHT = 0.004 // × ln(1 + оценок): 10 оценок → +0,01, 400 → +0,024
async function similarByVector(seed, { limit, profile, skip, ru }) {
  try {
    const rows = await nearestBooksTo(seed.id, {
      model: config.embeddingModel,
      limit: SIMILAR_CANDIDATES,
      where: Prisma.sql`AND NOT (b.id = ANY(${skip}::varchar[])) ${profileFilter(profile)}`,
      columns: bookColumns('b'),
    })
    const boost = ru ? RU_SIMILAR_BOOST : 0
    const score = (r) => r.similarity + POPULARITY_WEIGHT * Math.log1p(r.ratings_count) + boost * r.ru_known
    rows.sort((a, b) => score(b) - score(a))
    return diversify(seed, rows.map((r) => toBook(r)), limit)
  } catch (err) {
    console.warn(`Похожие по вектору не получились (${err.message.split('\n')[0]}) — по разделу`)
    return []
  }
}

// Похожие без вектора (книги «из одного названия» в векторы не попали): тот же подраздел, затем раздел
async function similarByCategory(seed, { limit, profile, skip, ru }) {
  if (!seed.section && !seed.subsection) return []
  const exclude = [seed.id, ...skip]
  const rows = await prisma.$queryRaw`
    (SELECT * FROM (
      SELECT ${bookColumns('b')}, b.weighted_rating, 1 AS tier FROM books b
      WHERE b.subsection = ${seed.subsection} AND b.section IS NOT DISTINCT FROM ${seed.section}
        AND NOT (b.id = ANY(${exclude}::varchar[])) ${profileFilter(profile)}
      ORDER BY ${ruFirst(ru)} b.ratings_count DESC LIMIT ${POPULAR_POOL}) pool
    ORDER BY ${ruFirst(ru, 'pool')} weighted_rating DESC LIMIT ${limit * 2})
    UNION ALL
    (SELECT * FROM (
      SELECT ${bookColumns('b')}, b.weighted_rating, 2 AS tier FROM books b
      WHERE b.section = ${seed.section} AND b.subsection IS DISTINCT FROM ${seed.subsection}
        AND NOT (b.id = ANY(${exclude}::varchar[])) ${profileFilter(profile)}
      ORDER BY ${ruFirst(ru)} b.ratings_count DESC LIMIT ${POPULAR_POOL}) pool
    ORDER BY ${ruFirst(ru, 'pool')} weighted_rating DESC LIMIT ${limit * 2})
    ORDER BY tier, ${ruFirst(ru, '')} weighted_rating DESC`
  return capPerAuthor(rows.map((r) => toBook(r))).slice(0, limit)
}

// Сначала по вектору; не хватило (нет вектора, сбой, всё отфильтровано) — добор по разделу
async function similarTo(seed, { limit, profile, skip = [], ru = profile?.ru }) {
  const byVector = await similarByVector(seed, { limit, profile, skip, ru })
  if (byVector.length >= limit) return byVector
  const taken = new Set(byVector.map((b) => b.id))
  const fallback = (await similarByCategory(seed, { limit, profile, skip, ru })).filter((b) => !taken.has(b.id))
  return diversify(seed, [...byVector, ...fallback], limit)
}

// GET /books/:id/similar — по содержанию, не персонально (2.6); скрытые пользователем книги не показываем
export async function getSimilar(bookId, { userId, ru = false, limit = 12 } = {}) {
  const seed = await prisma.book.findUnique({ where: { id: bookId } })
  if (!seed) return null
  const hidden = userId
    ? (await prisma.hiddenBook.findMany({ where: { userId }, select: { bookId: true } })).map((h) => h.bookId)
    : []
  return similarTo(toBook(seed), { limit, skip: hidden, ru })
}

// ——— Другие книги серии ———
// Понравились 2+ книги одного автора с общим началом названия («Harry Potter and the …») или общей серией в скобках
// («(Jack Reacher, Book 1)») — отдельный ряд с остальными книгами серии: того же автора с названием серии, а других
// авторов — если название начинается с серии и книга из того же раздела (Cursed Child Джека Торна, издания, где автором
// записан иллюстратор; но не «The Unofficial Harry Potter Cookbook»). Одно издание на книгу, без подарочных наборов,
// по году первого издания и номеру в серии. Лимит «2 книги франшизы» — только в «Похожих», не здесь
const SERIES_ROW = 12
const SERIES_MIN_RATINGS = 20
const SERIES_STOP = new Set(['the', 'a', 'an', 'and', 'of', 'и', 'в', 'на', 'из', 'о', 'с'])
const BOX_SET = /box(ed)?\s*set|collection|books?\s*\d+\s*[-–]\s*\d+|years?\s*\d+\s*[-–]\s*\d+/i
const mainTitle = (title) => title.split(/[:(]/)[0].trim()
// Общее начало названий по словам, без служебных слов в конце: «Гарри Поттер и …» → «Гарри Поттер»
function commonStart(titles) {
  const words = titles.map((t) => mainTitle(t).split(/\s+/))
  const out = []
  for (let i = 0; words.every((w) => w[i] && w[i].toLowerCase() === words[0][i].toLowerCase()); i++) out.push(words[0][i])
  while (out.length && SERIES_STOP.has(out.at(-1).toLowerCase())) out.pop()
  // Целиком совпавшее название — не серия, а то же произведение
  return out.length && words.some((w) => w.length > out.length) ? out.join(' ') : null
}
// Серия в скобках: «(Jack Reacher, Book 1)», «(A Harry Bosch Novel Book 19)» → «Jack Reacher», «Harry Bosch»
function bracketSeries(title) {
  const m = title.match(/\(([^()]+?)(?:,\s*|\s+)(?:book|novel|#|vol)/i)
  return m ? m[1].replace(/^(a|the)\s+/i, '').replace(/\s+(novel|series|trilogy|saga|mystery)$/i, '').trim() || null : null
}
const seriesNumber = (title) => {
  const m = title.match(/\b(?:book|vol\.?|volume|#)\s*(\d+)/i) ?? title.match(/\((\d+)\)\s*$/)
  return m ? Number(m[1]) : null
}

function seriesGroups(liked) {
  const byAuthor = new Map()
  for (const b of liked) if (b.author) byAuthor.set(b.author, [...(byAuthor.get(b.author) ?? []), b])
  const groups = []
  for (const [author, books] of byAuthor) {
    if (books.length < 2) continue
    const brackets = books.map((b) => bracketSeries(b.title))
    const key = commonStart(books.map((b) => b.title)) ?? (brackets.every((x) => x && x === brackets[0]) ? brackets[0] : null)
    if (!key || key.length < 3) continue
    const ru = books.every((b) => b.titleRu) ? commonStart(books.map((b) => b.titleRu)) : null
    groups.push({ author, key, ru, seeds: books })
  }
  return groups
}

async function seriesRow(group, { profile, exclude }) {
  const sections = [...new Set(group.seeds.map((b) => b.section).filter(Boolean))]
  const rows = await prisma.$queryRaw`
    SELECT ${bookColumns('b')} FROM books b
    WHERE b.ratings_count >= ${SERIES_MIN_RATINGS} AND b.title ILIKE ${`%${group.key}%`}
      AND (b.author = ${group.author} OR (b.title ILIKE ${`${group.key}%`} AND b.section = ANY(${sections}::text[])))
      AND NOT (b.id = ANY(${exclude}::varchar[])) ${profileFilter(profile)}
    ORDER BY b.ratings_count DESC LIMIT 200`
  // Издания одной книги — вместе: самое популярное, самый ранний год, номер — с любого издания. Одна книга — один
  // ключ издания или одно русское название (Philosopher's Stone и Sorcerer's Stone — «Гарри Поттер и философский камень»)
  const editions = new Map(group.seeds.flatMap((b) => [[editionKey(b.title), null], ...(b.titleRu ? [[`ru:${b.titleRu}`, null]] : [])]))
  const keyOf = (r) => {
    const ru = r.title_ru && `ru:${r.title_ru}`
    return ru && editions.has(ru) ? ru : editionKey(r.title)
  }
  for (const r of rows) {
    if (BOX_SET.test(r.title)) continue
    const key = keyOf(r)
    if (editions.has(key) && !editions.get(key)) continue // понравившаяся книга в другом издании
    const e = editions.get(key)
    if (!e) {
      const entry = { book: toBook(r), year: r.year ?? 9999, number: seriesNumber(r.title) }
      editions.set(key, entry)
      if (r.title_ru) editions.set(`ru:${r.title_ru}`, entry)
    } else {
      e.year = Math.min(e.year, r.year ?? 9999)
      e.number ??= seriesNumber(r.title)
    }
  }
  const name = (profile.ru && group.ru) || group.key
  const reason = { kind: 'series', text: `Из серии «${name}»` }
  // Один номер в серии — одна книга (Philosopher's Stone и Sorcerer's Stone — «Book 1»), берём популярное издание;
  // номера понравившихся книг — уже прочитаны
  const taken = new Set(group.seeds.map((b) => seriesNumber(b.title)).filter((n) => n != null))
  const items = [...new Set(editions.values())].filter(Boolean)
    .sort((a, b) => b.book.ratingsCount - a.book.ratingsCount)
    .filter((e) => e.number == null || (!taken.has(e.number) && taken.add(e.number)))
    .sort((a, b) => a.year - b.year || (a.number ?? 99) - (b.number ?? 99) || b.book.ratingsCount - a.book.ratingsCount)
    .slice(0, SERIES_ROW)
    .map((e) => ({ book: e.book, reason }))
  const seeds = group.seeds.map(({ score: _s, via: _v, little: _l, ...book }) => book)
  return { name, key: group.key, seeds, items }
}

// ——— Свой каталог: «Русская литература» / «Казахская литература» (1.5) ———
// По вкусу (близость к вектору понравившихся книг), когда у своих книг есть векторы; иначе сначала книги тем
// пользователя, внутри — по известности (число статей в Википедиях)
const LOCAL_ROW = 12
const LOCAL_SOURCES = ['ru', 'kz']
const TASTE_REASON = { kind: 'similar', text: 'По вашему вкусу' }
const TOPIC_REASON = { kind: 'topic', text: 'По вашим темам' }
const FAMOUS_REASON = { kind: 'popular', text: 'Известное' }
async function localRows(profile) {
  const rows = await Promise.all(LOCAL_SOURCES.map(async (source) => {
    const where = Prisma.sql`AND b.source = ${source} ${profileFilter(profile)}`
    const tasted = profile?.liked.length
      ? await byTaste(profile.liked.map((b) => b.id), {
        model: config.embeddingModel, where, columns: bookColumns('b'), order: Prisma.sql`b.fame DESC`, limit: LOCAL_ROW,
      }).catch(() => null)
      : null
    if (tasted) return { source, items: tasted.map((r) => ({ book: toBook(r), reason: TASTE_REASON })) }
    const sections = profile?.sections ?? []
    const books = (await prisma.$queryRaw`
      SELECT ${bookColumns('b')} FROM books b WHERE true ${where}
      ORDER BY (b.section = ANY(${sections}::text[])) DESC, b.fame DESC LIMIT ${LOCAL_ROW}`).map((r) => toBook(r))
    return { source, items: books.map((book) => ({ book, reason: sections.includes(book.section) ? TOPIC_REASON : FAMOUS_REASON })) }
  }))
  return rows.filter((r) => r.items.length)
}

// GET /recommendations — { forYou: [{ book, reason }], series: [{ name, seeds, items }],
//   local: [{ source: 'ru' | 'kz', items: [{ book, reason }] }], becauseYouLiked: [{ seed, items: [{ book, reason }] }] }
export async function getRecommendations(userId, { limit = 16 } = {}) {
  if (!userId) {
    const [books, local] = await Promise.all([popular({ limit, ru: prefersRussian(null) }), localRows(null)])
    return { forYou: books.map((book) => ({ book, reason: POPULAR_REASON })), series: [], local, becauseYouLiked: [] }
  }

  const profile = await loadProfile(userId)
  const likedIds = profile.liked.map((b) => b.id)
  // Ряды серий — первыми; их книги (и другие издания, наборы серии) в остальных рядах не повторяем.
  // Другие издания понравившихся книг — тоже: «Sorcerer's Stone: The Illustrated Edition» после лайка Sorcerer's Stone
  const series = (await Promise.all(seriesGroups(profile.liked)
    .map((g) => seriesRow(g, { profile, exclude: [...profile.excluded, ...likedIds] }))))
    .filter((r) => r.items.length)
  const inSeries = series.flatMap((r) => r.items.map((i) => i.book.id))
  const filtered = { ...profile, excluded: [...profile.excluded, ...likedIds, ...inSeries] }
  const seen = new Set([...profile.liked, ...series.flatMap((r) => r.items.map((i) => i.book))].map((b) => editionKey(b.title)))
  const seriesKeys = series.map((r) => r.key.toLowerCase())
  const fresh = (b) => !seen.has(editionKey(b.title)) && !seriesKeys.some((k) => b.title.toLowerCase().includes(k))

  // «Для вас»: по очереди из тем профиля, внутри темы — по взвешенному рейтингу (2.4)
  const bySection = await topInSections(profile.sections.slice(0, 6), { perSection: limit * 2, profile: filtered })
  const queues = [...bySection.values()].map((q) => capPerAuthor(oneEdition(q.filter(fresh))))
  let forYou = roundRobin(queues, limit).map((book) => ({ book, reason: reasonFor(book, profile) }))
  // Мало данных о пользователе — добиваем популярным
  if (forYou.length < limit) {
    const taken = new Set(forYou.map((r) => r.book.id))
    const extra = (await popular({ limit: limit * 2, profile: filtered })).filter((b) => !taken.has(b.id) && fresh(b))
    forYou = forYou.concat(extra.slice(0, limit - forYou.length).map((book) => ({ book, reason: POPULAR_REASON })))
  }

  // «Потому что вам понравилась…»: две последние книги с высокой оценкой из разных подразделов
  const seeds = []
  for (const b of profile.liked) {
    if (seeds.length === 2) break
    if (b.section && !seeds.some((s) => s.subsection === b.subsection)) seeds.push(b)
  }
  const becauseYouLiked = await Promise.all(seeds.map(async (seed) => {
    const items = (await similarTo(seed, { limit: 18, profile: filtered })).filter(fresh).slice(0, 12)
    const reason = { kind: 'similar', text: `Похожа на «${titleFor(seed, profile.ru)}»`, seedId: seed.id }
    const { score: _s, via: _v, little: _l, ...book } = seed
    return { seed: book, items: items.map((b) => ({ book: b, reason })) }
  }))

  const local = await localRows(filtered)
  return { forYou, series: series.map(({ key: _k, ...row }) => row), local, becauseYouLiked }
}

// ——— Онбординг (2.3, 3.4) ———

// Сессии онбординга: каждый проход — своя сессия, закрывается событием onboarding_complete
// (настоящее завершение, completed: true). Раунды и остановка по «Нравится» считаются внутри сессии;
// ответы прошлых сессий остаются в профиле, а отвеченные книги больше не показываются.
// Ответы без номера сессии (до B2) — сессия 1
export async function onboardingSession(userId, db = prisma) {
  const events = await db.event.findMany({
    where: { userId, type: { in: ['onboarding_answer', 'onboarding_complete'] } },
    select: { type: true, bookId: true, payload: true },
  })
  const closed = events.filter((e) => e.type === 'onboarding_complete').map((e) => e.payload?.session ?? 1)
  const session = closed.length ? Math.max(...closed) + 1 : 1
  const all = events.filter((e) => e.type === 'onboarding_answer')
  const current = all.filter((e) => (e.payload?.session ?? 1) === session)
  return { session, all, current, answered: current.length }
}

async function onboardingState(userId) {
  const { session, all, current } = await onboardingSession(userId)
  // Номер раунда — по ответам на книги раундов; добавленные через поиск раунд не продвигают
  const rounds = current.filter((a) => a.payload?.source !== 'search').map((a) => a.payload?.round ?? 1)
  return {
    session,
    shown: all.map((a) => a.bookId),
    // Подразделы, уже проверенные в этой сессии (книги из поиска — не показ подраздела)
    shownInSession: current.filter((a) => a.payload?.source !== 'search').map((a) => a.bookId),
    likedIds: current.filter((a) => a.payload?.answer === 'like').map((a) => a.bookId),
    round: rounds.length ? Math.max(...rounds) + 1 : 1,
  }
}

// Разведка тем: самые популярные книги разделов — сначала по одной на ещё не показанный подраздел,
// затем, если подразделов мало, остальные популярные (не больше одной книги автора)
async function exploreSections(sections, { exclude, skipSubsections = new Set(), limit, ru, kids }) {
  const rows = await prisma.$queryRaw`
    SELECT s.section AS topic, b.* FROM unnest(${sections}::text[]) AS s(section)
    CROSS JOIN LATERAL (
      SELECT ${bookColumns('x')} FROM books x
      WHERE x.section = s.section AND x.cover IS NOT NULL AND x.author IS NOT NULL
        AND NOT (x.id = ANY(${exclude}::varchar[])) ${kids ? Prisma.empty : Prisma.sql`AND NOT ${littleKids('x')}`}
      ORDER BY ${ruFirst(ru, 'x')} x.ratings_count DESC LIMIT ${POPULAR_POOL}
    ) b`
  const fresh = new Map(sections.map((s) => [s, []]))
  const rest = new Map(sections.map((s) => [s, []]))
  const usedSubsections = new Set(skipSubsections)
  const editions = new Set()
  for (const r of rows) {
    const book = toBook(r)
    // Одно издание на название
    const edition = `${editionKey(book.title)}|${book.author}`
    if (editions.has(edition)) continue
    editions.add(edition)
    const key = `${r.topic}/${book.subsection}`
    ;(usedSubsections.has(key) ? rest : fresh).get(r.topic).push(book)
    usedSubsections.add(key)
  }
  const taken = new Set()
  const picked = roundRobin([...fresh.values()], limit, taken)
  const filler = roundRobin([...rest.values()].map((q) => capPerAuthor(q, 1)), limit - picked.length, taken)
  return [...picked, ...filler].map((book) => ({
    book,
    reason: { kind: 'topic', text: `Раздел «${sectionLabel(book.section)}»` },
  }))
}

// Книги по описанию должны быть узнаваемыми: пользователя спрашивают «читали?», а книгу с 6–90 оценками почти никто
// не читал — раунд уходит в «Не читал». Сначала ближайшие с RECOGNIZABLE+ оценками, не набралось — добор с FAMILIAR+
const DESCRIPTION_RECOGNIZABLE = 200
const DESCRIPTION_FAMILIAR = 50

// Предпочтение в подборе по описанию: книгам выбранных тем и читающим по-русски — известным по-русски
// (к близости; соседние книги различаются на ~0,005–0,01)
const DESCRIPTION_TOPIC_BOOST = 0.01
const DESCRIPTION_RU_BOOST = 0.01
const DESCRIPTION_CANDIDATES = 40

// Книги, ближайшие по смыслу к описанию своими словами из этой сессии онбординга, — по всему каталогу (в выбранных
// темах описание «все книги про Гарри Поттера» при теме «Комиксы» давало Hitchhiker's Guide), с обложкой и автором,
// по одной на автора. Темы выбраны — два поиска параллельно, по всему каталогу и внутри тем (одни лишь ближайшие по
// каталогу уводили «космическую фантастику про первый контакт» в подростковые и христианские книги), книгам тем —
// небольшое предпочтение. Описания нет или ML-сервис недоступен — []
async function describedBooks(userId, session, sections, exclude, { ru, kids }) {
  const event = await prisma.event.findFirst({
    where: { userId, type: 'onboarding_description', payload: { path: ['session'], equals: session } },
    orderBy: { id: 'desc' },
    select: { query: true },
  })
  if (!event?.query) return []
  const emb = await embedQuery(event.query)
  if (!emb) return []
  try {
    // Фильтр по числу оценок — в самом запросе: итеративный обход HNSW набирает кандидатов сквозь него
    const search = (inTopics) => semanticSearch(emb.vector, {
      model: emb.model,
      limit: DESCRIPTION_CANDIDATES,
      where: Prisma.sql`AND b.cover IS NOT NULL AND b.author IS NOT NULL
        AND b.ratings_count >= ${DESCRIPTION_FAMILIAR} AND NOT (b.id = ANY(${exclude}::varchar[]))
        ${kids ? Prisma.empty : Prisma.sql`AND NOT ${littleKids('b')}`}
        ${inTopics ? Prisma.sql`AND b.section = ANY(${sections}::text[])` : Prisma.empty}`,
      columns: bookColumns('b'),
    })
    const lists = await Promise.all([search(false), ...(sections.length ? [search(true)] : [])])
    const rows = [...new Map(lists.flatMap((l) => l ?? []).map((r) => [r.id, r])).values()]
    const score = (r) => r.similarity + (sections.includes(r.section) ? DESCRIPTION_TOPIC_BOOST : 0)
      + (ru && r.ru_known ? DESCRIPTION_RU_BOOST : 0)
    const books = [...(rows ?? [])].sort((a, b) => score(b) - score(a)).map((r) => toBook(r))
    const known = books.filter((b) => b.ratingsCount >= DESCRIPTION_RECOGNIZABLE)
    return capPerAuthor([...known, ...books.filter((b) => b.ratingsCount < DESCRIPTION_RECOGNIZABLE)], 1)
      .slice(0, DESCRIPTION_BOOKS)
      .map((book) => ({ book, reason: { kind: 'topic', text: 'Близко к вашему описанию' } }))
  } catch (err) {
    console.warn(`Книги по описанию не подобрались (${err.message.split('\n')[0]})`)
    return []
  }
}

// GET /onboarding/next-round — { session, round, done, items: [{ book, reason }] }
export async function getOnboardingRound(userId) {
  const [profile, state] = await Promise.all([loadProfile(userId), onboardingState(userId)])
  const done = state.round > ONBOARDING_MAX_ROUNDS || state.likedIds.length >= ONBOARDING_STOP_LIKES
  if (done) return { session: state.session, round: state.round, done: true, items: [] }

  const exclude = [...new Set([...state.shown, ...profile.excluded])]
  // Темы необязательны: без них разделы берутся из понравившихся книг (loadProfile), затем из книг по описанию
  const described = state.round === 1 ? await describedBooks(userId, state.session, profile.sections, exclude, profile) : []
  let sections = profile.sections
  if (!sections.length) sections = [...new Set(described.map((r) => r.book.section).filter(Boolean))]
  if (!sections.length) {
    // Ни тем, ни описания, ни понравившихся книг («Пропустить») — разведка по самым крупным разделам
    const rows = await prisma.$queryRaw`
      SELECT section FROM books WHERE section IS NOT NULL GROUP BY section ORDER BY count(*) DESC LIMIT 8`
    sections = rows.map((r) => r.section)
  }

  const shownBooks = state.shownInSession.length
    ? await prisma.book.findMany({ where: { id: { in: state.shownInSession } }, select: { section: true, subsection: true } })
    : []
  const shownSubsections = new Set(shownBooks.map((b) => `${b.section}/${b.subsection}`))

  // Половина книг вокруг понравившегося в этой сессии (в раунде 1 — любимые книги, добавленные поиском), половина —
  // из непроверенных подразделов; в раунде 1 вместо части похожих — книги по описанию
  const liked = profile.liked.filter((b) => state.likedIds.includes(b.id))
  let exploit = []
  if (liked.length) {
    const perSeed = Math.ceil(ONBOARDING_ROUND_SIZE / 2 / liked.length)
    const lists = await Promise.all(liked.map((seed) =>
      similarTo(seed, { limit: perSeed, skip: exclude, ru: profile.ru }).then((items) => items.map((book) => ({
        book,
        reason: { kind: 'similar', text: `Похожа на «${titleFor(seed, profile.ru)}»`, seedId: seed.id },
      }))),
    ))
    const taken = new Set(described.map((r) => r.book.id))
    exploit = lists.flat().filter((r) => !taken.has(r.book.id) && taken.add(r.book.id))
  }
  // Раунд 1: «Опишите своими словами» — книги, ближайшие к описанию по смыслу (3.4), затем похожие на любимые
  exploit = [...described, ...exploit].slice(0, ONBOARDING_ROUND_SIZE / 2)
  const explore = await exploreSections(sections, {
    exclude: [...exclude, ...exploit.map((r) => r.book.id)],
    skipSubsections: state.round > 1 ? shownSubsections : new Set(),
    limit: ONBOARDING_ROUND_SIZE - exploit.length,
    ru: profile.ru,
    // Темы не выбраны — разведка по крупным разделам, и малышовые книги в ней не нужны
    kids: profile.kids,
  })

  return { session: state.session, round: state.round, done: false, items: [...exploit, ...explore] }
}
