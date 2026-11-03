// Запасной режим без сервера (VITE_USE_MOCKS=1): данные из shared/mock/books_sample.json,
// пользователи и их действия — в localStorage. Формы ответов те же, что у настоящего API (см. ./index.js).
import { shortTitle } from '../lib/format.js'
import { sectionLabel } from '../lib/sections.js'
import { ApiError, getToken, setToken } from './http.js'

let dataPromise

function loadData() {
  dataPromise ??= import('@shared/mock/books_sample.json').then(({ default: raw }) => {
    const books = raw.books
    const byId = new Map(books.map((b) => [b.id, b]))
    const meanRating = books.reduce((s, b) => s + b.rating, 0) / books.length
    return { raw, books, byId, meanRating }
  })
  return dataPromise
}

function delay(value, ms = 150 + Math.random() * 200) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

async function fail(status, code, message, details) {
  await delay()
  throw new ApiError(status, code, message, details)
}

// ——— Пользователи и их действия (localStorage) ———

const STATE_KEY = 'bookmind-mock-state'

function readState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY)) ?? { users: {} }
  } catch {
    return { users: {} }
  }
}

function writeState(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state))
  } catch {
    // без localStorage моки работают до перезагрузки
  }
}

const publicUser = ({ id, email, name, createdAt, onboardingCompleted }) => ({ id, email, name, createdAt, onboardingCompleted })

// Токен в моках — «mock:<email>»
function currentAccount(state = readState()) {
  const token = getToken()
  return token?.startsWith('mock:') ? (state.users[token.slice(5)] ?? null) : null
}

function updateAccount(fn) {
  const state = readState()
  const account = currentAccount(state)
  if (!account) throw new ApiError(401, 'unauthorized', 'Нужно войти в аккаунт')
  fn(account)
  writeState(state)
  return account
}

export async function register({ email = '', password = '', name = '' }) {
  email = email.trim().toLowerCase()
  const details = []
  if (!/^\S+@\S+\.\S+$/.test(email)) details.push({ path: 'email', message: 'Некорректный email' })
  if (password.length < 8) details.push({ path: 'password', message: 'Пароль — не короче 8 символов' })
  if (!name.trim()) details.push({ path: 'name', message: 'Укажите имя' })
  if (details.length) return fail(400, 'validation_error', 'Некорректные данные запроса', details)
  const state = readState()
  if (state.users[email]) return fail(409, 'email_taken', 'Этот email уже зарегистрирован')
  const user = { id: Date.now(), email, name: name.trim(), createdAt: new Date().toISOString(), onboardingCompleted: false }
  state.users[email] = { user, password, my: {}, topics: [], answers: [] }
  writeState(state)
  return delay({ token: `mock:${email}`, user: publicUser(user) })
}

export async function login({ email = '', password = '' }) {
  const account = readState().users[email.trim().toLowerCase()]
  if (!account || account.password !== password) return fail(401, 'invalid_credentials', 'Неверный email или пароль')
  return delay({ token: `mock:${account.user.email}`, user: publicUser(account.user) })
}

export async function getMe() {
  const account = currentAccount()
  if (!account) return fail(401, 'invalid_token', 'Сессия истекла, войдите снова')
  return delay(publicUser(account.user))
}

// ——— Профиль для рекомендаций ———

// Байесовское среднее (2.4): мало оценок → рейтинг тянется к среднему по каталогу
function weightedRating(book, mean, m = 300) {
  const n = book.ratingsCount
  return (n / (n + m)) * book.rating + (m / (n + m)) * mean
}

const byWeighted = (mean) => (a, b) => weightedRating(b, mean) - weightedRating(a, mean)
const POPULAR_REASON = { kind: 'popular', text: 'Популярно у читателей' }

function profileOf(account, byId) {
  if (!account) return { liked: [], sections: [], excluded: new Set() }
  const likedIds = [
    ...Object.entries(account.my).filter(([, m]) => m.rating >= 4).map(([id]) => id),
    ...account.answers.filter((a) => a.answer === 'like').map((a) => a.bookId),
  ]
  const liked = [...new Set(likedIds)].map((id) => byId.get(id)).filter(Boolean).reverse()
  const sections = [...new Set([...account.topics, ...liked.map((b) => b.section)])]
  const excluded = new Set([
    ...Object.entries(account.my).filter(([, m]) => m.rating || m.shelf || m.hidden).map(([id]) => id),
    ...account.answers.filter((a) => a.answer === 'dislike').map((a) => a.bookId),
  ])
  return { liked, sections, excluded }
}

function reasonFor(book, profile, { detailed = false } = {}) {
  const twin = profile.liked.find((l) => l.id !== book.id && l.subsection && l.subsection === book.subsection)
  if (twin) {
    const text = `Похожа на «${shortTitle(twin.title)}»`
    return { kind: 'similar', text: detailed ? `${text} — она вам понравилась` : text, seedId: twin.id }
  }
  if (profile.sections.includes(book.section)) {
    const section = sectionLabel(book.section)
    const text = detailed
      ? `Из вашей темы «${section}», читатели оценивают её в ${book.rating.toFixed(1)}`
      : `Ваша тема: ${section}`
    return { kind: 'topic', text }
  }
  return null
}

function roundRobin(queues, limit) {
  const out = []
  const taken = new Set()
  for (let i = 0; out.length < limit && queues.some((q) => q[i]); i++) {
    for (const q of queues) {
      if (q[i] && !taken.has(q[i].id) && out.length < limit) {
        taken.add(q[i].id)
        out.push(q[i])
      }
    }
  }
  return out
}

// ——— Книги ———

export async function getSections() {
  const { raw } = await loadData()
  return delay(raw.sections.map((s) => ({ name: s.name, booksCount: s.books })))
}

export async function getBooks({ section, sort = 'popular', limit = 20, offset = 0 } = {}) {
  const { books, meanRating } = await loadData()
  const list = section ? books.filter((b) => b.section === section) : [...books]
  list.sort(sort === 'rating' ? byWeighted(meanRating) : (a, b) => b.ratingsCount - a.ratingsCount)
  return delay({ items: list.slice(offset, offset + limit), total: list.length })
}

export async function getBook(id) {
  const { byId } = await loadData()
  const book = byId.get(id)
  if (!book) return fail(404, 'book_not_found', `Книга ${id} не найдена`)
  const account = currentAccount()
  if (!account) return delay({ ...book, recommendation: null, my: null })
  const m = account.my[id] ?? {}
  return delay({
    ...book,
    recommendation: m.rating ? null : reasonFor(book, profileOf(account, byId), { detailed: true }),
    my: { rating: m.rating ?? null, shelf: m.shelf ?? null, hidden: Boolean(m.hidden) },
  })
}

export async function getSimilarBooks(id, { limit = 12 } = {}) {
  const { books, byId, meanRating } = await loadData()
  const book = byId.get(id)
  if (!book) return fail(404, 'book_not_found', `Книга ${id} не найдена`)
  const hidden = new Set(Object.entries(currentAccount()?.my ?? {}).filter(([, m]) => m.hidden).map(([k]) => k))
  const score = (b) => (b.subsection && b.subsection === book.subsection ? 2 : 0) + (b.section === book.section ? 1 : 0)
  const list = books
    .filter((b) => b.id !== id && !hidden.has(b.id) && score(b) > 0)
    .sort((a, b) => score(b) - score(a) || byWeighted(meanRating)(a, b))
  return delay(list.slice(0, limit))
}

export async function getRecommendations({ limit = 16 } = {}) {
  const { books, byId, meanRating } = await loadData()
  const account = currentAccount()
  const popular = () => [...books].sort(byWeighted(meanRating))
  if (!account) {
    return delay({ forYou: popular().slice(0, limit).map((book) => ({ book, reason: POPULAR_REASON })), becauseYouLiked: [] })
  }

  const profile = profileOf(account, byId)
  const skip = (b) => profile.excluded.has(b.id) || profile.liked.some((l) => l.id === b.id)
  const queues = profile.sections.slice(0, 6).map((s) => books.filter((b) => b.section === s && !skip(b)).sort(byWeighted(meanRating)))
  let forYou = roundRobin(queues, limit).map((book) => ({ book, reason: reasonFor(book, profile) ?? POPULAR_REASON }))
  if (forYou.length < limit) {
    const taken = new Set(forYou.map((r) => r.book.id))
    const extra = popular().filter((b) => !taken.has(b.id) && !skip(b))
    forYou = forYou.concat(extra.slice(0, limit - forYou.length).map((book) => ({ book, reason: POPULAR_REASON })))
  }

  const becauseYouLiked = profile.liked.slice(0, 2).map((seed) => ({
    seed,
    items: books
      .filter((b) => b.section === seed.section && !skip(b))
      .sort(byWeighted(meanRating))
      .slice(0, 12)
      .map((book) => ({ book, reason: { kind: 'similar', text: `Похожа на «${shortTitle(seed.title)}»`, seedId: seed.id } })),
  }))
  return delay({ forYou, becauseYouLiked })
}

// ——— Поиск ———

export async function searchBooks({ q = '', section, year, rating, hideRead, limit = 20, offset = 0 }) {
  const { books } = await loadData()
  const query = q.trim().toLowerCase()
  if (!query) return fail(400, 'validation_error', 'Пустой запрос')
  const [from, to = from] = year ? String(year).split('-').map(Number) : []
  const my = currentAccount()?.my ?? {}
  const list = books.filter(
    (b) =>
      (b.title.toLowerCase().includes(query) || b.author?.toLowerCase().includes(query)) &&
      (!section || b.section === section) &&
      (!year || (b.year >= from && b.year <= to)) &&
      (!rating || b.rating >= Number(rating)) &&
      (!hideRead || my[b.id]?.shelf !== 'read'),
  )
  list.sort((a, b) => Number(b.title.toLowerCase().startsWith(query)) - Number(a.title.toLowerCase().startsWith(query)) || b.ratingsCount - a.ratingsCount)
  return delay({ items: list.slice(offset, offset + limit), total: list.length, fuzzy: false })
}

export async function suggestBooks(q) {
  const { books } = await loadData()
  const query = q.trim().toLowerCase()
  return delay(
    books
      .filter((b) => b.title.toLowerCase().includes(query) || b.author?.toLowerCase().includes(query))
      .sort((a, b) => Number(b.title.toLowerCase().startsWith(query)) - Number(a.title.toLowerCase().startsWith(query)) || b.ratingsCount - a.ratingsCount)
      .slice(0, 8)
      .map(({ id, title, author, year, cover }) => ({ id, title, author, year, cover })),
  )
}

// ——— Онбординг (2.3): до 3 раундов по 12 книг, конец после 5 «Нравится» ———

export async function getOnboardingRound() {
  const { books, raw } = await loadData()
  const account = currentAccount()
  if (!account) return fail(401, 'unauthorized', 'Нужно войти в аккаунт')
  const round = account.answers.length ? Math.max(...account.answers.map((a) => a.round)) + 1 : 1
  const likes = account.answers.filter((a) => a.answer === 'like').length
  if (round > 3 || likes >= 5) return delay({ round, done: true, items: [] })

  const shown = new Set(account.answers.map((a) => a.bookId))
  const sections = account.topics.length ? account.topics : raw.sections.slice(0, 8).map((s) => s.name)
  const queues = sections.map((s) => books.filter((b) => b.section === s && !shown.has(b.id)).sort((a, b) => b.ratingsCount - a.ratingsCount))
  const items = roundRobin(queues, 12).map((book) => ({ book, reason: { kind: 'topic', text: `Раздел «${sectionLabel(book.section)}»` } }))
  return delay({ round, done: items.length === 0, items })
}

export async function sendOnboardingAnswers({ topics, round = 1, answers = [], completed }) {
  const { byId } = await loadData()
  if (answers.some((a) => !byId.has(a.bookId))) return fail(404, 'book_not_found', 'Книга не найдена')
  const account = updateAccount((acc) => {
    if (topics) acc.topics = topics.filter((t) => t.kind === 'section').map((t) => t.value)
    const ids = new Set(answers.map((a) => a.bookId))
    acc.answers = acc.answers.filter((a) => !ids.has(a.bookId)).concat(answers.map((a) => ({ ...a, round })))
    if (completed !== undefined) acc.user.onboardingCompleted = completed
  })
  return delay({ saved: answers.length, user: publicUser(account.user) })
}

// ——— Мои действия с книгой ———

// Время действий — для порядка в кабинете и статистики по месяцам (как updated_at на сервере)
function setMy(bookId, patch) {
  updateAccount((acc) => {
    const prev = acc.my[bookId] ?? {}
    const now = new Date().toISOString()
    const next = { ...prev, ...patch }
    if ('shelf' in patch && patch.shelf !== prev.shelf) next.shelfAt = now
    if ('rating' in patch) next.ratedAt = now
    if ('hidden' in patch && patch.hidden) next.hiddenAt = now
    acc.my[bookId] = next
  })
}

export async function setRating(bookId, value) {
  setMy(bookId, value ? { rating: value, shelf: 'read' } : { rating: null })
  return delay(value ? { bookId, rating: value, shelf: 'read' } : null)
}

export async function setShelf(bookId, shelf) {
  setMy(bookId, { shelf })
  return delay(shelf ? { bookId, shelf } : null)
}

export async function setHidden(bookId, hidden) {
  setMy(bookId, { hidden })
  return delay(hidden ? { bookId, hidden: true } : null)
}

// ——— Кабинет ———

const SHELVES = ['want', 'reading', 'read']

async function myEntries(filter, sortKey) {
  const { byId } = await loadData()
  const account = currentAccount()
  if (!account) return fail(401, 'unauthorized', 'Нужно войти в аккаунт')
  return Object.entries(account.my)
    .filter(([id, m]) => byId.has(id) && filter(m))
    .map(([id, m]) => ({ book: byId.get(id), m }))
    .sort((a, b) => (b.m[sortKey] ?? '').localeCompare(a.m[sortKey] ?? ''))
}

export async function getShelves({ shelf, limit = 20, offset = 0 } = {}) {
  const all = await myEntries((m) => m.shelf, 'shelfAt')
  const counts = Object.fromEntries(SHELVES.map((s) => [s, all.filter((e) => e.m.shelf === s).length]))
  const list = shelf ? all.filter((e) => e.m.shelf === shelf) : all
  return delay({
    items: list.slice(offset, offset + limit).map(({ book, m }) => ({ book, shelf: m.shelf, rating: m.rating ?? null, addedAt: m.shelfAt })),
    total: list.length,
    counts,
  })
}

export async function getRatings({ limit = 20, offset = 0 } = {}) {
  const list = await myEntries((m) => m.rating, 'ratedAt')
  return delay({ items: list.slice(offset, offset + limit).map(({ book, m }) => ({ book, rating: m.rating, ratedAt: m.ratedAt })), total: list.length })
}

export async function getHidden({ limit = 20, offset = 0 } = {}) {
  const list = await myEntries((m) => m.hidden, 'hiddenAt')
  return delay({ items: list.slice(offset, offset + limit).map(({ book, m }) => ({ book, hiddenAt: m.hiddenAt })), total: list.length })
}

// Как на сервере: темы из онбординга + выведенные из понравившихся книг; weight — сколько книг в теме
async function tasteOf(account) {
  const { byId } = await loadData()
  const rejected = account?.rejected ?? []
  const isRejected = (kind, value) => rejected.some((r) => r.kind === kind && r.value === value)
  const items = new Map()
  const add = (kind, value, source, weight = 0) => {
    if (!value || isRejected(kind, value)) return
    const k = `${kind}:${value}`
    const item = items.get(k) ?? { kind, value, label: kind === 'section' ? sectionLabel(value) : value, source, weight: 0 }
    item.weight += weight
    items.set(k, item)
  }
  for (const value of account?.topics ?? []) add('section', value, 'onboarding')
  for (const b of profileOf(account, byId).liked) {
    add('section', b.section, 'profile', 1)
    add('subsection', b.subsection, 'profile', 1)
    add('author', b.author, 'profile', 1)
  }
  const list = [...items.values()]
    .filter((i) => i.source === 'onboarding' || i.kind === 'section' || i.weight >= 2)
    .sort((a, b) => (a.source === 'onboarding' ? -1 : 0) - (b.source === 'onboarding' ? -1 : 0) || b.weight - a.weight)
  return { items: list, rejected: rejected.map((r) => ({ ...r, label: r.kind === 'section' ? sectionLabel(r.value) : r.value })) }
}

export async function getTaste() {
  return delay(await tasteOf(currentAccount()))
}

export async function updateTaste({ kind, value, rejected }) {
  const account = updateAccount((acc) => {
    acc.rejected = (acc.rejected ?? []).filter((r) => !(r.kind === kind && r.value === value))
    if (rejected) acc.rejected.push({ kind, value })
  })
  return delay(await tasteOf(account))
}

export async function getStats(year = new Date().getFullYear()) {
  const { byId } = await loadData()
  const account = currentAccount()
  if (!account) return fail(401, 'unauthorized', 'Нужно войти в аккаунт')
  const read = Object.entries(account.my).filter(([id, m]) => m.shelf === 'read' && byId.has(id))
  const byMonth = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, count: 0 }))
  for (const [, m] of read) {
    const d = new Date(m.shelfAt ?? 0)
    if (d.getFullYear() === Number(year)) byMonth[d.getMonth()].count++
  }
  const sections = new Map()
  for (const [id] of read) {
    const s = byId.get(id).section
    if (s) sections.set(s, (sections.get(s) ?? 0) + 1)
  }
  const ratings = Object.values(account.my).map((m) => m.rating).filter(Boolean)
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const r of ratings) distribution[r]++
  const readThisYear = byMonth.reduce((s, m) => s + m.count, 0)
  const target = account.goals?.[year]
  return delay({
    year: Number(year),
    readTotal: read.length,
    readThisYear,
    byMonth,
    bySection: [...sections].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([section, count]) => ({ section, label: sectionLabel(section), count })),
    ratings: {
      count: ratings.length,
      average: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : null,
      distribution,
    },
    goal: target ? { year: Number(year), target, done: readThisYear } : null,
  })
}

export async function setGoal({ target, year = new Date().getFullYear() }) {
  if (!Number.isInteger(target) || target < 1 || target > 1000) {
    return fail(400, 'validation_error', 'Некорректные данные запроса', [{ path: 'target', message: 'Цель — от 1 до 1000 книг' }])
  }
  updateAccount((acc) => {
    acc.goals = { ...acc.goals, [year]: target }
  })
  const { readThisYear } = await getStats(year)
  return { year, target, done: readThisYear }
}

export async function updateProfile({ name, email, password, currentPassword }) {
  const state = readState()
  const account = currentAccount(state)
  if (!account) return fail(401, 'unauthorized', 'Нужно войти в аккаунт')
  email = email?.trim().toLowerCase()
  const details = []
  if (name !== undefined && !name.trim()) details.push({ path: 'name', message: 'Укажите имя' })
  if (email !== undefined && !/^\S+@\S+\.\S+$/.test(email)) details.push({ path: 'email', message: 'Некорректный email' })
  if (password !== undefined && password.length < 8) details.push({ path: 'password', message: 'Пароль — не короче 8 символов' })
  if (details.length) return fail(400, 'validation_error', 'Некорректные данные запроса', details)
  const emailChanged = email && email !== account.user.email
  if ((emailChanged || password) && currentPassword !== account.password) return fail(403, 'wrong_password', 'Неверный текущий пароль')
  if (emailChanged && state.users[email]) return fail(409, 'email_taken', 'Этот email уже зарегистрирован')
  if (name !== undefined) account.user.name = name.trim()
  if (password) account.password = password
  if (emailChanged) {
    delete state.users[account.user.email]
    account.user.email = email
    state.users[email] = account
  }
  writeState(state)
  // токен моков — это email: при смене email меняется и он
  if (emailChanged) setToken(`mock:${email}`)
  return delay(publicUser(account.user))
}

export async function deleteAccount(password) {
  const state = readState()
  const account = currentAccount(state)
  if (!account) return fail(401, 'unauthorized', 'Нужно войти в аккаунт')
  if (account.password !== password) return fail(403, 'wrong_password', 'Неверный пароль')
  delete state.users[account.user.email]
  writeState(state)
  return delay(null)
}

// Сигналы в моках никуда не уходят — только считаются
export async function sendEvents(events) {
  updateAccount((acc) => {
    acc.events = (acc.events ?? 0) + events.length
  })
  return delay({ saved: events.length })
}
