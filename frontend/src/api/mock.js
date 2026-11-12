// Запасной режим без сервера (VITE_USE_MOCKS=1): данные из shared/mock/books_sample.json,
// пользователи и их действия — в localStorage. Формы ответов те же, что у настоящего API (см. ./index.js).
import { readsRussian } from '../lib/bookNames.js'
import { sectionLabel, subsectionLabel } from '../lib/sections.js'
import { ApiError, getToken, setToken } from './http.js'

let dataPromise

// Русские названия и имена авторов (2.8) — небольшая ручная выборка, чтобы в моках было что показать;
// у остальных книг titleRu / authorRu = null, как у большинства книг на сервере
const TITLES_RU = {
  B00L9B7IKE: 'Девушка в поезде',
  B006LSZECO: 'Исчезнувшая',
  B00JO8PEN2: 'Соловей',
  B00DPM7TIG: 'Весь невидимый нам свет',
  B01COJUEZ0: 'Джентльмен в Москве',
  '0735219095': 'Там, где раки поют',
  B072BLVM83: 'Ученица. Предать, чтобы обрести себя',
  B00AA20E5Y: 'Зов кукушки',
  B07D2C6J4K: 'Безмолвный пациент',
  '0439023521': 'Голодные игры',
  '0375842209': 'Книжный вор',
  '1607747308': 'Магическая уборка',
  '0316055433': 'Щегол',
  '0307887448': 'Первому игроку приготовиться',
  '0439023513': 'Сойка-пересмешница',
  '0439023491': 'И вспыхнет пламя',
  '0316024961': 'Новолуние',
  '0399226907': 'Очень голодная гусеница',
  '1524763136': 'Becoming. Моя история',
  '0062300547': 'Элегия Хиллбилли',
  '0316015849': 'Сумерки',
  '1338099132': 'Гарри Поттер и Проклятое дитя',
  '0062024035': 'Дивергент',
  '1439156816': 'Как писать книги',
  '0439784549': 'Гарри Поттер и Принц-полукровка',
  '0451524934': '1984',
  '0440212561': 'Чужестранка',
  '1594746036': 'Дом странных детей',
  '031606792X': 'Рассвет',
  '0525478817': 'Виноваты звёзды',
  '1451673310': '451 градус по Фаренгейту',
  '038549081X': 'Рассказ служанки',
}
const AUTHORS_RU = {
  'Paula Hawkins': 'Пола Хокинс',
  'Gillian Flynn': 'Гиллиан Флинн',
  'Kristin Hannah': 'Кристин Ханна',
  'Anthony Doerr': 'Энтони Дорр',
  'John Grisham': 'Джон Гришэм',
  'Amor Towles': 'Амор Тоулз',
  'Delia Owens': 'Делия Оуэнс',
  'Tara Westover': 'Тара Вестовер',
  'Robert Galbraith': 'Роберт Гэлбрейт',
  'Alex Michaelides': 'Алекс Михаэлидес',
  'Suzanne Collins': 'Сьюзен Коллинз',
  'Markus Zusak': 'Маркус Зусак',
  'Marie Kondo': 'Мари Кондо',
  'Donna Tartt': 'Донна Тартт',
  'Ernest Cline': 'Эрнест Клайн',
  'Eric Carle': 'Эрик Карл',
  'Michelle Obama': 'Мишель Обама',
  'Vance, J. D.': 'Джей Ди Вэнс',
  'Stephenie Meyer': 'Стефани Майер',
  'J.K. Rowling': 'Джоан Роулинг',
  'Veronica Roth': 'Вероника Рот',
  'Stephen King': 'Стивен Кинг',
  'George Orwell': 'Джордж Оруэлл',
  'Diana Gabaldon': 'Диана Гэблдон',
  'Ransom Riggs': 'Ренсом Риггз',
  'John Green': 'Джон Грин',
  'Ray Bradbury': 'Рэй Брэдбери',
  'Margaret Atwood': 'Маргарет Этвуд',
  'Malcolm Gladwell': 'Малкольм Гладуэлл',
  'Bill Bryson': 'Билл Брайсон',
  'Erik Larson': 'Эрик Ларсон',
  'Mitch Albom': 'Митч Элбом',
  'Walter Isaacson': 'Уолтер Айзексон',
  'Eckhart Tolle': 'Экхарт Толле',
  'Neal Stephenson': 'Нил Стивенсон',
  'Elizabeth Gilbert': 'Элизабет Гилберт',
  'Rhonda Byrne': 'Ронда Берн',
  'Alan Moore': 'Алан Мур',
}

// Русские описания (2.8, п. 5) — на карточке книги: из Википедии (со ссылкой) или машинный перевод аннотации.
// В моках — несколько книг, текст краткий
const ANNOTATIONS_RU = {
  B006LSZECO: {
    annotationRu:
      'В день пятой годовщины свадьбы Эми Данн исчезает. Под подозрением оказывается её муж Ник: полиция находит следы борьбы, соседи вспоминают ссоры, а дневник Эми рассказывает о браке совсем не то, что говорит Ник.',
    annotationSource: 'wikipedia',
    annotationUrl: 'https://ru.wikipedia.org/wiki/Исчезнувшая_(роман)',
  },
  B00L9B7IKE: {
    annotationRu:
      'Рейчел каждый день ездит на одном и том же поезде и смотрит в окно на дом, где живёт «идеальная» пара. Однажды она видит там то, что меняет всё, — а потом женщина из этого дома пропадает.',
    annotationSource: 'mt',
    annotationUrl: null,
  },
  '0439784549': {
    annotationRu:
      'Шестая книга о Гарри Поттере. Волан-де-Морт набирает силу, а Дамблдор готовит Гарри к решающей схватке, открывая ему прошлое Тёмного Лорда. В руки Гарри попадает учебник с пометками таинственного Принца-полукровки.',
    annotationSource: 'wikipedia',
    annotationUrl: 'https://ru.wikipedia.org/wiki/Гарри_Поттер_и_Принц-полукровка',
  },
}

// Серии (2.8, п. 3): в выборке нет поля серии — узнаём несколько известных по названию
const SERIES = [
  { re: /Harry Potter/, name: 'Гарри Поттер', nameEn: 'Harry Potter' },
  { re: /Hunger Games|Mockingjay|Catching Fire/, name: 'Голодные игры', nameEn: 'The Hunger Games' },
  { re: /Twilight Saga|^Twilight\b/, name: 'Сумерки', nameEn: 'The Twilight Saga' },
  { re: /Divergent|Insurgent|Allegiant/, name: 'Дивергент', nameEn: 'Divergent' },
  { re: /Outlander/, name: 'Чужестранка', nameEn: 'Outlander' },
]
const seriesOf = (book) => SERIES.find((s) => s.re.test(book.title)) ?? null

// Свои русские и казахские книги (1.5): без оценок, описания — из русской Википедии, как на бэкенде (B8) —
// в annotation и в annotationRu один и тот же русский текст. У казахских title — оригинал, titleRu — русское
// название. Буквы ә ғ қ ң ө ұ ү һ і и длинное название — чтобы проверить заглушку обложки
const WIKI = 'https://ru.wikipedia.org/wiki/'
const local = ({ text, ...book }) => ({
  year: null, section: null, subsection: null, cover: null, rating: null, ratingsCount: 0, titleRu: null, authorRu: null,
  annotation: text, annotationRu: text, annotationSource: 'wikipedia', annotationUrl: null,
  ...book,
})
const LOCAL_BOOKS = [
  local({
    id: 'ru-master', source: 'ru', title: 'Мастер и Маргарита', author: 'Михаил Булгаков', year: 1967,
    text: 'Роман о визите дьявола в Москву 1930-х годов и о Мастере, написавшем роман о Понтии Пилате. Сатира на советский быт переплетается с евангельской историей и историей любви Мастера и Маргариты.',
    annotationUrl: WIKI + 'Мастер_и_Маргарита',
  }),
  local({
    id: 'ru-piknik', source: 'ru', title: 'Пикник на обочине', author: 'Аркадий и Борис Стругацкие', year: 1972,
    text: 'После визита инопланетян на Земле остались Зоны — места, полные загадочных предметов и смертельных ловушек. Сталкер Рэдрик Шухарт нелегально ходит в Зону за находками, пока не решается дойти до Золотого шара, исполняющего желания.',
    annotationUrl: WIKI + 'Пикник_на_обочине',
  }),
  local({
    id: 'kz-abai', source: 'kz', title: 'Абай жолы', titleRu: 'Путь Абая', author: 'Мұхтар Әуезов', authorRu: 'Мухтар Ауэзов', year: 1956,
    text: 'Роман-эпопея о жизни поэта и мыслителя Абая Кунанбаева — от детства до зрелых лет, на фоне жизни казахской степи XIX века.',
    annotationUrl: WIKI + 'Путь_Абая',
  }),
  local({
    id: 'kz-koshpendiler', source: 'kz', title: 'Көшпенділер: Алмас қылыш. Жанталас. Қаһар', titleRu: 'Кочевники', author: 'Ілияс Есенберлин', authorRu: 'Ильяс Есенберлин', year: 1976,
    text: 'Историческая трилогия о Казахском ханстве — от его основания в XV веке до восстания Кенесары Касымова в XIX веке.',
    annotationUrl: WIKI + 'Кочевники_(трилогия)',
  }),
  local({
    id: 'kz-koja', source: 'kz', title: 'Менің атым Қожа', titleRu: 'Меня зовут Кожа', author: 'Бердібек Соқпақбаев', authorRu: 'Бердибек Сокпакбаев', year: 1957,
    text: 'Повесть о школьнике-озорнике Кожа, который никак не может стать примерным, — одна из самых любимых детских книг в Казахстане.',
    annotationUrl: WIKI + 'Меня_зовут_Кожа',
  }),
  local({
    id: 'kz-ulpan', source: 'kz', title: 'Ұлпан', titleRu: 'Улпан её имя', author: 'Ғабит Мүсірепов', authorRu: 'Габит Мусрепов', year: 1974,
    text: 'Роман о казахской женщине XIX века, которая сумела стать хозяйкой своей судьбы и уважаемой в степи.',
    annotationUrl: WIKI + 'Улпан_её_имя',
  }),
]

function loadData() {
  dataPromise ??= import('@shared/mock/books_sample.json').then(({ default: raw }) => {
    const amazon = raw.books.map((b) => ({ ...b, source: 'amazon', titleRu: TITLES_RU[b.id] ?? null, authorRu: AUTHORS_RU[b.author] ?? null }))
    const books = [...amazon, ...LOCAL_BOOKS]
    const byId = new Map(books.map((b) => [b.id, b]))
    const meanRating = amazon.reduce((s, b) => s + b.rating, 0) / amazon.length
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

const publicUser = ({ id, email, name, createdAt, onboardingCompleted, readingLanguages = [] }) => ({
  id,
  email,
  name,
  createdAt,
  onboardingCompleted,
  readingLanguages,
})
const LANGUAGES = ['ru', 'kk', 'en']
const cleanLanguages = (list) => LANGUAGES.filter((l) => list.includes(l))

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
  const user = { id: Date.now(), email, name: name.trim(), createdAt: new Date().toISOString(), onboardingCompleted: false, readingLanguages: [] }
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
const POPULAR_REASON = { kind: 'popular' }

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

// Причины — как будут приходить от ML-сервиса через бэкенд (3.8): тип и книга-зерно / раздел, без готового
// текста — его собирает фронтенд (lib/reasons.js). Правила моков грубые, лишь бы встречались все типы
const seedOf = ({ id, title, titleRu, author, authorRu }) => ({ id, title, titleRu, author, authorRu })

function reasonFor(book, profile) {
  const inTopics = profile.sections.includes(book.section)
  if (inTopics && book.year >= 2021) return { kind: 'new' }
  const sameAuthor = profile.liked.find((l) => l.id !== book.id && l.author && l.author === book.author)
  if (sameAuthor) return { kind: 'same_author', seed: seedOf(sameAuthor) }
  if (inTopics && book.year >= 2018 && book.ratingsCount >= 3000) return { kind: 'trending', section: book.section }
  const twin = profile.liked.find((l) => l.id !== book.id && l.subsection && l.subsection === book.subsection)
  if (twin) return { kind: 'similar', seed: seedOf(twin) }
  // «в ваших темах» — только первая тема; остальное без причины, как у ML-ленты (reason: null)
  return book.section === profile.sections[0] ? { kind: 'topic', section: book.section } : null
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

export async function getBooks({ section, source, sort = 'popular', limit = 20, offset = 0 } = {}) {
  const { books, meanRating } = await loadData()
  const list = books.filter((b) => (!section || b.section === section) && (!source || b.source === source))
  list.sort(sort === 'rating' ? byWeighted(meanRating) : (a, b) => b.ratingsCount - a.ratingsCount)
  return delay({ items: list.slice(offset, offset + limit), total: list.length })
}

export async function getBook(id) {
  const { byId } = await loadData()
  const book = byId.get(id)
  if (!book) return fail(404, 'book_not_found', `Книга ${id} не найдена`)
  // у своих книг описание уже в данных (LOCAL_BOOKS), у книг Amazon — из ANNOTATIONS_RU, если есть
  const full = book.source === 'amazon' ? { ...book, annotationRu: null, annotationSource: null, annotationUrl: null, ...ANNOTATIONS_RU[id] } : book
  const account = currentAccount()
  if (!account) return delay({ ...full, recommendation: null, my: null })
  const m = account.my[id] ?? {}
  return delay({
    ...full,
    recommendation: m.rating ? null : reasonFor(book, profileOf(account, byId)),
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
  const popular = () => books.filter((b) => b.source === 'amazon').sort(byWeighted(meanRating))
  const localRows = ['ru', 'kz'].map((source) => ({
    source,
    items: books.filter((b) => b.source === source).map((book) => ({ book, reason: null })),
  }))
  if (!account) {
    return delay({ forYou: popular().slice(0, limit).map((book) => ({ book, reason: POPULAR_REASON })), becauseYouLiked: [], series: [], local: localRows })
  }

  const profile = profileOf(account, byId)
  const skip = (b) => profile.excluded.has(b.id) || profile.liked.some((l) => l.id === b.id)
  const queues = profile.sections.slice(0, 6).map((s) => books.filter((b) => b.section === s && !skip(b)).sort(byWeighted(meanRating)))
  // как ML-лента (4.11): у части книг причины нет — reason: null, без подписи
  let forYou = roundRobin(queues, limit).map((book) => ({ book, reason: reasonFor(book, profile) }))
  if (forYou.length < limit) {
    const taken = new Set(forYou.map((r) => r.book.id))
    const extra = popular().filter((b) => !taken.has(b.id) && !skip(b))
    forYou = forYou.concat(extra.slice(0, limit - forYou.length).map((book) => ({ book, reason: POPULAR_REASON })))
  }
  // слот своего каталога (4.12: 4-е и 9-е места) читающим по-русски: русская книга с книгой-зерном и казахская без
  if (readsRussian(account.user)) {
    const own = ['ru', 'kz'].map((source) => books.find((b) => b.source === source && !skip(b))).filter(Boolean)
    const seed = profile.liked.find((l) => l.source === 'amazon')
    own.forEach((book, i) => {
      const reason = { kind: 'own_catalog', ...(i === 0 && seed && { seed: seedOf(seed), seedId: seed.id }) }
      forYou.splice(i === 0 ? 3 : 8, 0, { book, reason })
    })
    forYou = forYou.slice(0, limit)
  }

  const becauseYouLiked = profile.liked.slice(0, 2).map((seed) => ({
    seed,
    items: books
      .filter((b) => b.section === seed.section && !skip(b))
      .sort(byWeighted(meanRating))
      .slice(0, 12)
      .map((book) => ({ book, reason: { kind: 'similar', seed: seedOf(seed) } })),
  }))
  // «Другие книги серии»: понравились 2+ книги одной серии — остальные её книги отдельным рядом
  const ru = !account.user.readingLanguages?.length || account.user.readingLanguages.includes('ru')
  const groups = new Map()
  for (const b of profile.liked) {
    const s = seriesOf(b)
    if (s) groups.set(s, [...(groups.get(s) ?? []), b])
  }
  const series = [...groups]
    .filter(([, seeds]) => seeds.length >= 2)
    .map(([s, seeds]) => ({
      name: ru ? s.name : s.nameEn,
      seeds,
      items: books
        .filter((b) => seriesOf(b) === s && !skip(b))
        .map((book) => ({ book, reason: { kind: 'series', text: `Из серии «${ru ? s.name : s.nameEn}»` } })),
    }))
    .filter((r) => r.items.length)
  return delay({ forYou, becauseYouLiked, series, local: localRows })
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
      [b.title, b.titleRu, b.author, b.authorRu].some((x) => x?.toLowerCase().includes(query)) &&
      (!section || b.section === section) &&
      (!year || (b.year >= from && b.year <= to)) &&
      (!rating || b.rating >= Number(rating)) &&
      (!hideRead || my[b.id]?.shelf !== 'read'),
  )
  list.sort((a, b) => Number(b.title.toLowerCase().startsWith(query)) - Number(a.title.toLowerCase().startsWith(query)) || b.ratingsCount - a.ratingsCount)
  return delay({ items: list.slice(offset, offset + limit), total: list.length, fuzzy: false, mode: 'keyword' })
}

export async function suggestBooks(q) {
  const { books } = await loadData()
  const query = q.trim().toLowerCase()
  return delay(
    books
      .filter((b) => [b.title, b.titleRu, b.author, b.authorRu].some((s) => s?.toLowerCase().includes(query)))
      .sort((a, b) => Number(b.title.toLowerCase().startsWith(query)) - Number(a.title.toLowerCase().startsWith(query)) || b.ratingsCount - a.ratingsCount)
      .slice(0, 8)
      .map(({ id, title, titleRu, author, authorRu, year, cover }) => ({ id, title, titleRu, author, authorRu, year, cover })),
  )
}

// ——— Онбординг (2.3): до 3 раундов по 12 книг, конец после 5 «Нравится» ———

export async function getOnboardingRound() {
  const { books, byId, raw } = await loadData()
  const account = currentAccount()
  if (!account) return fail(401, 'unauthorized', 'Нужно войти в аккаунт')
  // книги, названные через поиск («Назовите любимые книги»), раунд не засчитывают
  const answered = account.answers.filter((a) => a.source !== 'search')
  const round = answered.length ? Math.max(...answered.map((a) => a.round)) + 1 : 1
  const likes = account.answers.filter((a) => a.answer === 'like').length
  if (round > 3 || likes >= 5) return delay({ round, done: true, items: [] })

  const shown = new Set(account.answers.map((a) => a.bookId))
  const likedSections = [...new Set(profileOf(account, byId).liked.map((b) => b.section))]
  const sections = account.topics.length ? account.topics : likedSections.length ? likedSections : raw.sections.slice(0, 8).map((s) => s.name)
  const queues = sections.map((s) => books.filter((b) => b.section === s && !shown.has(b.id)).sort((a, b) => b.ratingsCount - a.ratingsCount))
  const items = roundRobin(queues, 12).map((book) => ({ book, reason: { kind: 'topic', text: `Раздел «${sectionLabel(book.section)}»` } }))
  return delay({ round, done: items.length === 0, items })
}

export async function sendOnboardingAnswers({ topics, readingLanguages, round = 1, answers = [], completed }) {
  const { byId } = await loadData()
  if (answers.some((a) => !byId.has(a.bookId))) return fail(404, 'book_not_found', 'Книга не найдена')
  const account = updateAccount((acc) => {
    if (topics) acc.topics = topics.filter((t) => t.kind === 'section').map((t) => t.value)
    if (readingLanguages) acc.user.readingLanguages = cleanLanguages(readingLanguages)
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

const topicLabel = (kind, value) => (kind === 'section' ? sectionLabel(value) : kind === 'subsection' ? subsectionLabel(value) : value)

// Как на сервере: темы из онбординга + выведенные из понравившихся книг; weight — сколько книг в теме
async function tasteOf(account) {
  const { byId } = await loadData()
  const rejected = account?.rejected ?? []
  const isRejected = (kind, value) => rejected.some((r) => r.kind === kind && r.value === value)
  const items = new Map()
  const add = (kind, value, source, weight = 0) => {
    if (!value || isRejected(kind, value)) return
    const k = `${kind}:${value}`
    const item = items.get(k) ?? { kind, value, label: topicLabel(kind, value), source, weight: 0 }
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
  return { items: list, rejected: rejected.map((r) => ({ ...r, label: topicLabel(r.kind, r.value) })) }
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

export async function updateProfile({ name, email, password, currentPassword, readingLanguages }) {
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
  if (readingLanguages) account.user.readingLanguages = cleanLanguages(readingLanguages)
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
