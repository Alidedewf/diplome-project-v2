// Временные заглушки вместо ML-сервиса (решения.md, 3.8 и 4.2): популярное в темах пользователя,
// похожие по разделу/подразделу, раунды онбординга по подразделам. Маршруты зовут только функции
// этого модуля — при появлении ML-сервиса они заменяются HTTP-запросами к нему, форма ответов та же.
import { Prisma, prisma } from '../db.js'
import { bookColumns, capPerAuthor, shortTitle, toBook } from '../lib/books.js'
import { sectionLabel } from '../lib/sections.js'

const ONBOARDING_ROUND_SIZE = 12
const ONBOARDING_MAX_ROUNDS = 3
const ONBOARDING_STOP_LIKES = 5 // «остановка при 5+ ответах «Нравится»» (3.4)
// «Популярное в теме»: из стольких самых популярных книг темы берутся лучшие по взвешенному рейтингу.
// Чистый взвешенный рейтинг поднимает малоизвестные циклы с небольшим числом преданных читателей
const POPULAR_POOL = 200

// ——— Профиль пользователя ———

// Что известно о пользователе: понравившиеся книги, темы, что исключить из выдачи
export async function loadProfile(userId) {
  const [likedRows, topics, excludedRows] = await Promise.all([
    // Понравилось: оценки 4–5 и «Нравится» в онбординге; сначала пятёрки, затем свежие
    prisma.$queryRaw`
      SELECT ${bookColumns('b')}, src.score, src.via
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
  ])

  const liked = []
  const likedIds = new Set()
  for (const row of likedRows) {
    if (likedIds.has(row.id)) continue
    likedIds.add(row.id)
    liked.push({ ...toBook(row), score: row.score, via: row.via })
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
  return { liked: visibleLiked, sections, rejected, excluded: excludedRows.map((r) => r.id) }
}

// Фильтр выдачи: без исключённых книг и тем «Это не про меня»
function profileFilter(profile, alias = 'b') {
  const t = Prisma.raw(alias)
  if (!profile) return Prisma.empty
  return Prisma.sql`
    AND NOT (${t}.id = ANY(${profile.excluded}::varchar[]))
    AND coalesce(${t}.subsection, '') <> ALL(${[...profile.rejected.subsection]}::text[])
    AND coalesce(${t}.author, '') <> ALL(${[...profile.rejected.author]}::text[])`
}

// ——— Объяснения «почему» ———

// Reason { kind: 'similar' | 'topic' | 'popular', text, seedId? }; short — для ленты (до двух строк),
// detailed — для плашки на странице книги
export function reasonFor(book, profile, { detailed = false } = {}) {
  if (!profile) return null
  const twin = profile.liked.find((l) => l.id !== book.id && l.subsection && l.subsection === book.subsection)
  if (twin) {
    const text = `Похожа на «${shortTitle(twin.title)}»`
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

async function popular({ limit, profile }) {
  const rows = await prisma.$queryRaw`
    SELECT ${bookColumns('b')} FROM books b
    WHERE b.section IS NOT NULL ${profileFilter(profile)}
    ORDER BY b.ratings_count DESC LIMIT ${limit}`
  return rows.map((r) => toBook(r))
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
      ) pool ORDER BY weighted_rating DESC LIMIT ${perSection}
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

async function similarTo(seed, { limit, profile, skip = [] }) {
  const exclude = [seed.id, ...skip]
  const rows = await prisma.$queryRaw`
    (SELECT * FROM (
      SELECT ${bookColumns('b')}, b.weighted_rating, 1 AS tier FROM books b
      WHERE b.subsection = ${seed.subsection} AND b.section IS NOT DISTINCT FROM ${seed.section}
        AND NOT (b.id = ANY(${exclude}::varchar[])) ${profileFilter(profile)}
      ORDER BY b.ratings_count DESC LIMIT ${POPULAR_POOL}) pool
    ORDER BY weighted_rating DESC LIMIT ${limit * 2})
    UNION ALL
    (SELECT * FROM (
      SELECT ${bookColumns('b')}, b.weighted_rating, 2 AS tier FROM books b
      WHERE b.section = ${seed.section} AND b.subsection IS DISTINCT FROM ${seed.subsection}
        AND NOT (b.id = ANY(${exclude}::varchar[])) ${profileFilter(profile)}
      ORDER BY b.ratings_count DESC LIMIT ${POPULAR_POOL}) pool
    ORDER BY weighted_rating DESC LIMIT ${limit * 2})
    ORDER BY tier, weighted_rating DESC`
  return capPerAuthor(rows.map((r) => toBook(r))).slice(0, limit)
}

// GET /books/:id/similar — по содержанию, не персонально (2.6); скрытые пользователем книги не показываем
export async function getSimilar(bookId, { userId, limit = 12 } = {}) {
  const seed = await prisma.book.findUnique({ where: { id: bookId } })
  if (!seed) return null
  const hidden = userId
    ? (await prisma.hiddenBook.findMany({ where: { userId }, select: { bookId: true } })).map((h) => h.bookId)
    : []
  if (!seed.section && !seed.subsection) return []
  return similarTo(toBook(seed), { limit, skip: hidden })
}

// GET /recommendations — { forYou: [{ book, reason }], becauseYouLiked: [{ seed, items: [{ book, reason }] }] }
export async function getRecommendations(userId, { limit = 16 } = {}) {
  if (!userId) {
    const books = await popular({ limit })
    return { forYou: books.map((book) => ({ book, reason: POPULAR_REASON })), becauseYouLiked: [] }
  }

  const profile = await loadProfile(userId)
  const likedIds = profile.liked.map((b) => b.id)
  const filtered = { ...profile, excluded: [...profile.excluded, ...likedIds] }

  // «Для вас»: по очереди из тем профиля, внутри темы — по взвешенному рейтингу (2.4)
  const bySection = await topInSections(profile.sections.slice(0, 6), { perSection: limit * 2, profile: filtered })
  const queues = [...bySection.values()].map((q) => capPerAuthor(q))
  let forYou = roundRobin(queues, limit).map((book) => ({ book, reason: reasonFor(book, profile) }))
  // Мало данных о пользователе — добиваем популярным
  if (forYou.length < limit) {
    const taken = new Set(forYou.map((r) => r.book.id))
    const extra = (await popular({ limit: limit * 2, profile: filtered })).filter((b) => !taken.has(b.id))
    forYou = forYou.concat(extra.slice(0, limit - forYou.length).map((book) => ({ book, reason: POPULAR_REASON })))
  }

  // «Потому что вам понравилась…»: две последние книги с высокой оценкой из разных подразделов
  const seeds = []
  for (const b of profile.liked) {
    if (seeds.length === 2) break
    if (b.section && !seeds.some((s) => s.subsection === b.subsection)) seeds.push(b)
  }
  const becauseYouLiked = await Promise.all(seeds.map(async (seed) => {
    const items = await similarTo(seed, { limit: 12, profile: filtered })
    const reason = { kind: 'similar', text: `Похожа на «${shortTitle(seed.title)}»`, seedId: seed.id }
    const { score: _s, via: _v, ...book } = seed
    return { seed: book, items: items.map((b) => ({ book: b, reason })) }
  }))

  return { forYou, becauseYouLiked }
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
async function exploreSections(sections, { exclude, skipSubsections = new Set(), limit }) {
  const rows = await prisma.$queryRaw`
    SELECT s.section AS topic, b.* FROM unnest(${sections}::text[]) AS s(section)
    CROSS JOIN LATERAL (
      SELECT ${bookColumns('x')} FROM books x
      WHERE x.section = s.section AND x.cover IS NOT NULL AND x.author IS NOT NULL
        AND NOT (x.id = ANY(${exclude}::varchar[]))
      ORDER BY x.ratings_count DESC LIMIT ${POPULAR_POOL}
    ) b`
  const fresh = new Map(sections.map((s) => [s, []]))
  const rest = new Map(sections.map((s) => [s, []]))
  const usedSubsections = new Set(skipSubsections)
  for (const r of rows) {
    const book = toBook(r)
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

// GET /onboarding/next-round — { session, round, done, items: [{ book, reason }] }
export async function getOnboardingRound(userId) {
  const [profile, state] = await Promise.all([loadProfile(userId), onboardingState(userId)])
  const done = state.round > ONBOARDING_MAX_ROUNDS || state.likedIds.length >= ONBOARDING_STOP_LIKES
  if (done) return { session: state.session, round: state.round, done: true, items: [] }

  const exclude = [...new Set([...state.shown, ...profile.excluded])]
  let sections = profile.sections
  if (!sections.length) {
    // Темы не выбраны («Пропустить») — разведка по самым крупным разделам
    const rows = await prisma.$queryRaw`
      SELECT section FROM books WHERE section IS NOT NULL GROUP BY section ORDER BY count(*) DESC LIMIT 8`
    sections = rows.map((r) => r.section)
  }

  const shownBooks = state.shownInSession.length
    ? await prisma.book.findMany({ where: { id: { in: state.shownInSession } }, select: { section: true, subsection: true } })
    : []
  const shownSubsections = new Set(shownBooks.map((b) => `${b.section}/${b.subsection}`))

  // Раунд 1 — разведка; дальше половина книг вокруг понравившегося, половина — из непроверенных подразделов
  const liked = profile.liked.filter((b) => state.likedIds.includes(b.id))
  let exploit = []
  if (state.round > 1 && liked.length) {
    const perSeed = Math.ceil(ONBOARDING_ROUND_SIZE / 2 / liked.length)
    const lists = await Promise.all(liked.map((seed) =>
      similarTo(seed, { limit: perSeed, skip: exclude }).then((items) => items.map((book) => ({
        book,
        reason: { kind: 'similar', text: `Похожа на «${shortTitle(seed.title)}»`, seedId: seed.id },
      }))),
    ))
    const taken = new Set()
    exploit = lists.flat().filter((r) => !taken.has(r.book.id) && taken.add(r.book.id)).slice(0, ONBOARDING_ROUND_SIZE / 2)
  }
  const explore = await exploreSections(sections, {
    exclude: [...exclude, ...exploit.map((r) => r.book.id)],
    skipSubsections: state.round > 1 ? shownSubsections : new Set(),
    limit: ONBOARDING_ROUND_SIZE - exploit.length,
  })

  return { session: state.session, round: state.round, done: false, items: [...exploit, ...explore] }
}
