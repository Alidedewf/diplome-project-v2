// Свой каталог русских и казахских книг из Wikidata (решения.md 1.5, 4.10) → books с source 'ru' / 'kz'.
//
// Русские: литературные произведения (P31 из WORK_TYPES) со статьёй в русской Википедии, у которых язык оригинала
// русский (P407 Q7737) или автор пишет по-русски (P1412 / P6886 Q7737); RU_FAMOUS + RU_MODERN самых известных (по числу статей в
// Википедиях, sitelinks); у найденных через язык автора не должно быть другого языка оригинала (Швейк, Калевипоэг).
// Только литературные типы: с «письменным произведением» и «книгой» шли «Протоколы сионских мудрецов», «Рухнама», Ленин.
// У произведения должен быть автор — писатель по профессии (RU_WRITER) и не политик / лингвист (RU_NOT_WRITER): без этого
// шли «Основы эсперанто» Заменгофа, «Государство и революция», «Основы геополитики», «Фонд SCP» (без автора).
// Пилот — RU_FAMOUS самых известных и RU_MODERN самых известных с XX века (год ≥ MODERN_FROM): в одном топе XIX век — 54 %.
// Казахские: писатели (гражданство Казахстан / Казахская ССР, этнос казахи или пишет по-казахски — у классиков советского
// времени вроде Ауэзова гражданство только СССР; место рождения не берём — с ним шли Лукьяненко и Волков; писательская
// профессия) со статьёй в ru или kk Википедии. «Казахская литература» — произведение на казахском (P407 Q9252) или автор —
// этнический казах (P172 Q80040); остальные (гражданство или язык автора без этого) — в черновике с пометкой, решает автор.
// Названия — без уточнений Википедии в скобках, транслит в kk-названии — не берём; имена — «Имя Фамилия»; ударения снимаем и их произведения (P800 и обратная P50) — черновик для автора
// data/processed/kz_draft.csv; в базу — произведения со статьёй о них (до KZ_PILOT), остальное — после правки автора.
//
// Дубли с Amazon: произведение уже есть в каталоге (по QID из load-wikidata-ru.js или по английскому названию и началу
// фамилии автора — «Dostoyevsky» / «Dostoevsky») — новой записи нет, у книг Amazon дописываются русское название и
// описание из Википедии. Поэтому запускать после load:wikidata-ru (тот сбрасывает русские поля книг Amazon).
// Описание — начало статьи (как в load-wikidata-ru.js), обложка — Open Library по ISBN, если есть.
// Для векторов ML — data/processed/own_books.parquet (book_id, source, text: название, автор, жанр, описание).
//
// Ответы Wikidata и Википедии кэшируются в data/processed/own_books_wd.json после каждой пачки (упал — следующий запуск
// продолжает с места); --offline — без сети.
// --dupes-only (по кэшу, без сети) — только дописать русские поля книгам Amazon, совпавшим со своими (как в конце полного
// запуска): свои книги, kz_draft.csv и own_books.parquet не трогает. Нужен после load-wikidata-ru, если own-books целиком
// не перезапускается.
//
// Запуск из backend/:  npm run load:own-books [-- --offline] [--dupes-only]
import fs from 'node:fs'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import pg from 'pg'
import { config, ROOT } from '../src/config.js'
import { fetchExtracts, fetchMissing, nameKey, shortTitle, sleep, sparql, wikiIntro } from './load-wikidata-ru.js'

const CACHE = path.join(ROOT, 'data/processed/own_books_wd.json')
const KZ_DRAFT = path.join(ROOT, 'data/processed/kz_draft.csv')
const OWN_PARQUET = path.join(ROOT, 'data/processed/own_books.parquet')
const RU_FAMOUS = 150
const RU_MODERN = 150
const MODERN_FROM = 1917
// writer, novelist, poet, playwright, journalist, essayist, science fiction writer, children's writer, short story writer,
// screenwriter
const RU_WRITER = new Set(['Q36180', 'Q6625963', 'Q49757', 'Q214917', 'Q1930187', 'Q11774202', 'Q18844224', 'Q4853732',
  'Q15949613', 'Q28389'])
// politician, linguist, political scientist, revolutionary, statesperson
const RU_NOT_WRITER = new Set(['Q82955', 'Q14467526', 'Q1238570', 'Q3242115', 'Q372436'])
// Явный стоп-список на случай, если фильтры пропустят: подделка, политические работы, учебники эсперанто
const STOP_AUTHORS = new Set(['Q1394', 'Q11758']) // Ленин, Заменгоф
const STOP_TITLES = [/сионских мудрецов/i, /эсперанто/i]
const stopped = (w) => w.authors.some((a) => STOP_AUTHORS.has(a)) || STOP_TITLES.some((re) => re.test(w.ru ?? '') || re.test(w.en ?? ''))
const occupationsQuery = (qids) => `SELECT ?p ?occ WHERE { VALUES ?p { ${values(qids)} } ?p wdt:P106 ?occ }`
const KZ_PILOT = 60
const CANDIDATES = 1500
// literary work, novel, novella, short story, play, poem, short story collection, poetry collection
const WORK_TYPES = ['Q7725634', 'Q8261', 'Q149537', 'Q49084', 'Q25379', 'Q5185279', 'Q1279564', 'Q12106333']
const KZ_WRITER = ['Q36180', 'Q49757', 'Q6625963', 'Q214917', 'Q4853732', 'Q1930187', 'Q482980']
const RU_WIKI = 'https://ru.wikipedia.org/w/api.php'
const KK_WIKI = 'https://kk.wikipedia.org/w/api.php'
const values = (qids) => qids.map((q) => `wd:${q}`).join(' ')
const types = values(WORK_TYPES)
const qidOf = (uri) => uri.split('/').pop()

// Жанр Wikidata (английское название) → раздел и подраздел каталога; неизвестное — художественная литература
const GENRES = [
  [/science fiction|fantasy|dystop|utopi|speculative/i, 'Science Fiction & Fantasy', null],
  [/detective|crime|mystery|thriller/i, 'Mystery, Thriller & Suspense', null],
  [/children|fairy tale|fable/i, "Children's Books", null],
  [/memoir|autobiograph|diary|biograph/i, 'Biographies & Memoirs', null],
  [/romance/i, 'Romance', null],
  [/poem|poetry|verse|epic/i, 'Literature & Fiction', 'Poetry'],
  [/play|drama|comedy|tragedy/i, 'Literature & Fiction', 'Dramas & Plays'],
  [/short story/i, 'Literature & Fiction', 'Short Stories & Anthologies'],
  [/satir|humor/i, 'Literature & Fiction', 'Humor & Satire'],
]
function sectionFor(genres, typeQids) {
  for (const [re, section, subsection] of GENRES) if (genres.some((g) => re.test(g))) return { section, subsection }
  if (typeQids.includes('Q5185279') || typeQids.includes('Q12106333')) return { section: 'Literature & Fiction', subsection: 'Poetry' }
  if (typeQids.includes('Q25379')) return { section: 'Literature & Fiction', subsection: 'Dramas & Plays' }
  if (typeQids.includes('Q49084') || typeQids.includes('Q1279564')) return { section: 'Literature & Fiction', subsection: 'Short Stories & Anthologies' }
  return { section: 'Literature & Fiction', subsection: 'World Literature' }
}

const ruByLanguage = `SELECT ?w ?links WHERE {
  VALUES ?type { ${types} }
  ?w wdt:P31 ?type ; wdt:P407 wd:Q7737 ; wikibase:sitelinks ?links .
  ?a schema:about ?w ; schema:isPartOf <https://ru.wikipedia.org/> .
} ORDER BY DESC(?links) LIMIT ${CANDIDATES}`
const ruByAuthor = `SELECT ?w ?links WHERE {
  VALUES ?type { ${types} }
  ?w wdt:P31 ?type ; wdt:P50 ?au ; wikibase:sitelinks ?links .
  { ?au wdt:P1412 wd:Q7737 } UNION { ?au wdt:P6886 wd:Q7737 }
  FILTER NOT EXISTS { ?w wdt:P407 ?lang FILTER(?lang != wd:Q7737) }
  ?a schema:about ?w ; schema:isPartOf <https://ru.wikipedia.org/> .
} ORDER BY DESC(?links) LIMIT ${CANDIDATES}`
const kzWriters = `SELECT DISTINCT ?p ?links WHERE {
  { ?p wdt:P27 wd:Q232 } UNION { ?p wdt:P27 wd:Q168811 } UNION { ?p wdt:P172 wd:Q80040 }
  UNION { ?p wdt:P1412 wd:Q9252 } UNION { ?p wdt:P6886 wd:Q9252 }
  VALUES ?occ { ${values(KZ_WRITER)} } ?p wdt:P106 ?occ ; wikibase:sitelinks ?links .
  { ?x schema:about ?p ; schema:isPartOf <https://ru.wikipedia.org/> } UNION { ?x schema:about ?p ; schema:isPartOf <https://kk.wikipedia.org/> }
}`
const kzWorksOf = (qids) => `SELECT ?p ?w ?notable WHERE {
  VALUES ?p { ${values(qids)} }
  { ?p wdt:P800 ?w . VALUES ?t1 { ${types} } ?w wdt:P31 ?t1 . BIND(true AS ?notable) }
  UNION { ?w wdt:P50 ?p . VALUES ?t2 { ${types} } ?w wdt:P31 ?t2 . BIND(false AS ?notable) }
}`
// Подробности произведения или человека: названия ru / kk / en, оригинальное название, статьи ru / kk, год, жанр,
// тип, ISBN, авторы
const detailsQuery = (qids) => `SELECT ?w ?ru ?kk ?en ?orig ?links ?ruArticle ?kkArticle ?date ?genre ?type ?isbn13 ?isbn10 ?au ?lang ?ethnic ?spoken WHERE {
  VALUES ?w { ${values(qids)} }
  ?w wikibase:sitelinks ?links .
  OPTIONAL { ?w rdfs:label ?ru FILTER(lang(?ru) = "ru") }
  OPTIONAL { ?w rdfs:label ?kk FILTER(lang(?kk) = "kk") }
  OPTIONAL { ?w rdfs:label ?en FILTER(lang(?en) IN ("en", "mul")) }
  OPTIONAL { ?w wdt:P1476 ?orig }
  OPTIONAL { ?ra schema:about ?w ; schema:isPartOf <https://ru.wikipedia.org/> ; schema:name ?ruArticle }
  OPTIONAL { ?ka schema:about ?w ; schema:isPartOf <https://kk.wikipedia.org/> ; schema:name ?kkArticle }
  OPTIONAL { ?w wdt:P577 ?date }
  OPTIONAL { ?w wdt:P136 ?genre }
  OPTIONAL { ?w wdt:P31 ?type }
  OPTIONAL { ?w wdt:P212 ?isbn13 }
  OPTIONAL { ?w wdt:P957 ?isbn10 }
  OPTIONAL { ?w wdt:P50 ?au }
  OPTIONAL { ?w wdt:P407 ?lang }
  OPTIONAL { ?w wdt:P172 ?ethnic }
  OPTIONAL { ?w wdt:P1412 ?spoken }
}`
const labelsQuery = (qids) => `SELECT ?x ?l WHERE { VALUES ?x { ${values(qids)} } ?x rdfs:label ?l FILTER(lang(?l) IN ("en", "mul")) }`

const detailRow = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'w').map(([k, v]) => [k, v.value]))
// Строки подробностей (декартово произведение необязательных полей) → одна запись
function collect(rows = []) {
  const one = (k) => rows.find((r) => r[k])?.[k] ?? null
  const all = (k) => [...new Set(rows.map((r) => r[k]).filter(Boolean))]
  const years = all('date').map((d) => Number.parseInt(d.replace(/^\+/, ''), 10)).filter((y) => Number.isFinite(y))
  return {
    ru: one('ru'), kk: one('kk'), en: one('en'), orig: one('orig'), links: Number(one('links') ?? 0),
    ruArticle: one('ruArticle'), kkArticle: one('kkArticle'), year: years.length ? Math.min(...years) : null,
    genres: all('genre').map(qidOf), types: all('type').map(qidOf),
    isbn: all('isbn13').map((i) => i.replace(/-/g, ''))[0] ?? null, isbn10: all('isbn10').map((i) => i.replace(/-/g, ''))[0] ?? null,
    authors: all('au').map(qidOf),
    langs: all('lang').map(qidOf), ethnic: all('ethnic').map(qidOf), spoken: all('spoken').map(qidOf),
  }
}

const RU = 'Q7737'
const KK = 'Q9252'
const KAZAKHS = 'Q80040'
const noStress = (s) => s?.replace(/\u0301/g, '') ?? s
// «Меня зовут Кожа (повесть)» → «Меня зовут Кожа»
const cleanTitle = (s) => noStress(s)?.replace(/\s*\([^)]*\)\s*$/, '').trim() || null
// Казахское название — только кириллицей и без латиницы («Tantsy na snegu, Танцы на снегу (Russian)» — транслит, не берём)
const kkTitle = (s) => (s && /[А-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі]/.test(s) && !/[A-Za-z]/.test(s) ? cleanTitle(s) : null)
// «Сокпакбаев, Бердибек Ыдырысович» → «Бердибек Сокпакбаев», «Мұхтар Омарханұлы Әуезов» → «Мұхтар Әуезов»
function personName(s) {
  if (!s) return null
  const swapped = noStress(s).replace(/^([^,]+),\s*(.+)$/, '$2 $1').trim()
  const parts = swapped.split(/\s+/)
  if (parts.length === 3 && /(вич|вна|ична|инична|ұлы|қызы|улы|кызы)$/i.test(parts[1])) return `${parts[0]} ${parts[2]}`
  return swapped
}

const csvCell = (v) => (v == null ? '' : /[",\n;]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v))
const wikiUrl = (lang, article) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(article.replaceAll(' ', '_'))}`
const lastKey = (name) => nameKey(name?.split(/[ ,]+/).filter(Boolean).pop() ?? '')
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

async function coverFor(isbn) {
  if (!isbn) return null
  const url = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`
  const res = await fetch(`${url}?default=false`, { method: 'HEAD', signal: AbortSignal.timeout(20_000) }).catch(() => null)
  await sleep(300)
  return res?.ok ? url : null
}

async function main() {
  const dupesOnly = process.argv.includes('--dupes-only')
  const offline = dupesOnly || process.argv.includes('--offline')
  const started = Date.now()
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {}
  for (const k of ['works', 'people', 'labels', 'kzWorks', 'extractsRu', 'extractsKk', 'covers', 'occupations']) cache[k] ??= {}
  const save = () => {
    fs.writeFileSync(`${CACHE}.tmp`, JSON.stringify({ ...cache, updatedAt: new Date().toISOString() }))
    fs.renameSync(`${CACHE}.tmp`, CACHE)
  }
  const details = (store, label) => (keys) => (offline ? 0 : fetchMissing({
    keys, store, query: detailsQuery, keyOf: (r) => qidOf(r.w.value), toCandidate: detailRow, label, save, batch: 40, saveEvery: 1,
  }))

  // ——— Кандидаты
  if (!offline && !cache.ruCandidates) {
    const [a, b] = [await sparql(ruByLanguage), await sparql(ruByAuthor)]
    console.log(`Русские кандидаты: по языку оригинала ${a?.length ?? 'таймаут'}, по языку автора ${b?.length ?? 'таймаут'}`)
    const links = new Map()
    for (const r of [...(a ?? []), ...(b ?? [])]) links.set(qidOf(r.w.value), Number(r.links.value))
    cache.ruCandidates = [...links].sort((x, y) => y[1] - x[1]).map(([qid, n]) => ({ qid, links: n }))
    save()
  }
  if (!offline && !cache.kzWriters) {
    cache.kzWriters = (await sparql(kzWriters)).map((r) => ({ qid: qidOf(r.p.value), links: Number(r.links.value) }))
    save()
  }
  const ruCandidates = cache.ruCandidates ?? []
  const kzWriterIds = (cache.kzWriters ?? []).map((w) => w.qid)
  console.log(`Кандидаты: русских произведений ${ruCandidates.length}, казахских писателей ${kzWriterIds.length}`)

  await details(cache.works, 'Русские произведения')(ruCandidates.map((c) => c.qid))
  await details(cache.people, 'Казахские писатели')(kzWriterIds)
  if (!offline) {
    await fetchMissing({
      keys: kzWriterIds, store: cache.kzWorks, query: kzWorksOf, keyOf: (r) => qidOf(r.p.value),
      toCandidate: (r) => ({ qid: qidOf(r.w.value), notable: r.notable.value === 'true' }), label: 'Произведения казахских писателей', save, batch: 20, saveEvery: 1,
    })
  }
  const kzWorkIds = [...new Set(Object.entries(cache.kzWorks).filter(([p]) => kzWriterIds.includes(p)).flatMap(([, ws]) => ws.map((w) => w.qid)))]
  await details(cache.works, 'Казахские произведения')(kzWorkIds)
  const work = (qid) => collect(cache.works[qid])
  // Авторы русских произведений, жанры — названия
  const authorIds = [...new Set([...ruCandidates.map((c) => c.qid), ...kzWorkIds].flatMap((q) => work(q).authors))]
  await details(cache.people, 'Авторы')(authorIds)
  const genreIds = [...new Set([...ruCandidates.map((c) => c.qid), ...kzWorkIds].flatMap((q) => work(q).genres))]
  if (!offline) {
    await fetchMissing({ keys: genreIds, store: cache.labels, query: labelsQuery, keyOf: (r) => qidOf(r.x.value), toCandidate: (r) => r.l.value, label: 'Жанры', save })
  }
  const person = (qid) => collect(cache.people[qid])
  const genreNames = (w) => w.genres.flatMap((g) => cache.labels[g] ?? [])
  if (!offline) {
    await fetchMissing({ keys: authorIds, store: cache.occupations, query: occupationsQuery, keyOf: (r) => qidOf(r.p.value),
      toCandidate: (r) => qidOf(r.occ.value), label: 'Профессии авторов', save })
  }
  const isWriter = (qid) => {
    const occ = cache.occupations[qid] ?? []
    return occ.some((o) => RU_WRITER.has(o)) && !occ.some((o) => RU_NOT_WRITER.has(o))
  }

  const db = new pg.Client({ connectionString: config.databaseUrl })
  await db.connect()
  try {
    // ——— Дубли с Amazon
    async function amazonMatches(qid, w) {
      const byQid = (await db.query(`SELECT id FROM books WHERE source = 'amazon' AND wikidata_qid = $1`, [qid])).rows
      if (byQid.length) return { how: 'qid', ids: byQid.map((r) => r.id) }
      const en = w.en && shortTitle(w.en)
      const authorsEn = w.authors.map((a) => person(a).en).filter(Boolean)
      if (!en || en.length < 4 || !authorsEn.length) return null
      const rows = (await db.query(`SELECT id, title, author FROM books WHERE source = 'amazon' AND ratings_count >= 5
        AND lower(title) LIKE lower($1) || '%'`, [escapeLike(en)])).rows
      const ids = rows.filter((r) => shortTitle(r.title).toLowerCase() === en.toLowerCase()
        && authorsEn.some((a) => lastKey(a).slice(0, 4) === lastKey(r.author).slice(0, 4))).map((r) => r.id)
      return ids.length ? { how: 'title', ids } : null
    }

    // ——— Русские: RU_FAMOUS самых известных, затем RU_MODERN самых известных с MODERN_FROM (новые, не дубли Amazon)
    const ruNew = []
    const dupes = []
    const skipped = { stop: 0, notRussian: 0, noAuthor: 0, notWriter: 0 }
    const fits = ruCandidates.map(({ qid }) => ({ qid, w: work(qid) })).filter(({ w }) => {
      if (!w.ru || !w.ruArticle) return false
      if (stopped(w)) return skipped.stop++ && false
      if (w.langs.length && !w.langs.includes(RU)) return skipped.notRussian++ && false
      if (!w.authors.length) return skipped.noAuthor++ && false
      if (!w.authors.some(isWriter)) return skipped.notWriter++ && false
      return true
    })
    const take = async (list, n) => {
      for (const c of list) {
        if (ruNew.filter((x) => x.pick === n.label).length >= n.count) break
        if (ruNew.some((x) => x.qid === c.qid) || dupes.some((d) => d.qid === c.qid)) continue
        const match = await amazonMatches(c.qid, c.w)
        if (match) dupes.push({ ...c, ...match })
        else ruNew.push({ ...c, pick: n.label })
      }
    }
    await take(fits, { label: 'famous', count: RU_FAMOUS })
    await take(fits.filter((c) => c.w.year >= MODERN_FROM), { label: 'modern', count: RU_MODERN })
    // ——— Казахские: черновик и пилот
    const draft = []
    for (const p of kzWriterIds) {
      const a = person(p)
      for (const { qid, notable } of cache.kzWorks[p] ?? []) {
        const w = work(qid)
        if (!w.ru && !w.kk && !w.orig) continue
        draft.push({ p, a, qid, notable, w })
      }
    }
    draft.sort((x, y) => Number(Boolean(y.w.ruArticle || y.w.kkArticle)) - Number(Boolean(x.w.ruArticle || x.w.kkArticle)) || y.w.links - x.w.links)
    // Казахская литература: произведение на казахском или автор — этнический казах
    const isKazakh = (w) => w.langs.includes(KK) || w.authors.some((a) => person(a).ethnic.includes(KAZAKHS))
    const header = ['kazakh_literature', 'author_qid', 'author_ru', 'author_kk', 'work_qid', 'work_ru', 'work_kk', 'work_original', 'year',
      'notable_work', 'ru_article', 'kk_article', 'sitelinks', 'url', 'remove (x)', 'comment']
    const lines = [header, ...draft.map(({ p, a, qid, notable, w }) => [isKazakh(w) ? 'да' : 'под вопросом', p, personName(a.ru), personName(a.kk),
      qid, cleanTitle(w.ru), kkTitle(w.kk), cleanTitle(w.orig), w.year, notable ? 'да' : '',
      w.ruArticle ? 'да' : '', w.kkArticle ? 'да' : '', w.links,
      w.ruArticle ? wikiUrl('ru', w.ruArticle) : w.kkArticle ? wikiUrl('kk', w.kkArticle) : `https://www.wikidata.org/wiki/${qid}`, '', ''])]
    if (!dupesOnly) fs.writeFileSync(KZ_DRAFT, '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n')
    const kzNew = []
    const seenKz = new Set()
    for (const d of draft) {
      if (kzNew.length >= KZ_PILOT) break
      if (seenKz.has(d.qid) || !(d.w.ruArticle || d.w.kkArticle) || stopped(d.w) || !isKazakh(d.w)) continue
      seenKz.add(d.qid)
      const match = await amazonMatches(d.qid, d.w)
      if (match) dupes.push({ qid: d.qid, w: d.w, ...match, kz: true })
      else kzNew.push({ qid: d.qid, w: d.w })
    }

    // ——— Описания и обложки
    if (!offline) {
      await fetchExtracts([...new Set([...ruNew, ...kzNew, ...dupes].map((x) => x.w.ruArticle).filter(Boolean))], cache.extractsRu, save, RU_WIKI)
      await fetchExtracts([...new Set(kzNew.filter((x) => !x.w.ruArticle && x.w.kkArticle).map((x) => x.w.kkArticle))], cache.extractsKk, save, KK_WIKI)
      for (const x of [...ruNew, ...kzNew]) {
        const isbn = x.w.isbn ?? x.w.isbn10
        if (isbn && !(isbn in cache.covers)) cache.covers[isbn] = await coverFor(isbn)
      }
      save()
    }
    const ruText = (w) => (w.ruArticle ? wikiIntro(cache.extractsRu[w.ruArticle] ?? '') : null)
    const kkText = (w) => (w.kkArticle ? wikiIntro(cache.extractsKk[w.kkArticle] ?? '') : null)

    const { rows: [{ prior }] } = await db.query(`SELECT coalesce(avg(weighted_rating), 4)::float AS prior FROM books WHERE ratings_count = 0 AND source = 'amazon'`)
    const record = (source) => ({ qid, w }) => {
      const { section, subsection } = sectionFor(genreNames(w), w.types)
      // «Борис Стругацкий, Аркадий Стругацкий, братья Стругацкие» → «братья Стругацкие»
      const everyone = w.authors.map(person)
      const together = everyone.filter((a) => /^братья /i.test(a.ru ?? ''))
      const authors = together.length ? together : everyone
      const ru = ruText(w)
      const kk = source === 'kz' && !ru ? kkText(w) : null
      const isbn = w.isbn ?? w.isbn10
      return {
        id: `wd:${qid}`, qid, source, section, subsection, year: w.year, fame: w.links,
        title: source === 'kz' ? (kkTitle(w.kk) ?? kkTitle(w.orig) ?? cleanTitle(w.ru)) : cleanTitle(w.ru),
        titleRu: source === 'kz' && w.ru && cleanTitle(w.ru) !== (kkTitle(w.kk) ?? kkTitle(w.orig)) ? cleanTitle(w.ru) : null,
        author: authors.map((a) => personName(source === 'kz' ? a.kk ?? a.ru : a.ru)).filter(Boolean).join(', ') || null,
        authorRu: source === 'kz' ? authors.map((a) => personName(a.ru)).filter(Boolean).join(', ') || null : null,
        annotation: ru ?? kk ?? '',
        annotationRu: ru, annotationUrl: ru ? wikiUrl('ru', w.ruArticle) : kk ? wikiUrl('kk', w.kkArticle) : null,
        isbn13: isbn?.length === 13 ? isbn : null, cover: isbn ? cache.covers[isbn] ?? null : null,
        // Язык оригинала: по P407, без него — по языку автора, иначе по каталогу
        language: w.langs.includes(KK) ? 'Kazakh' : w.langs.includes(RU) ? 'Russian'
          : authors.some((a) => a.spoken.includes(KK)) && source === 'kz' ? 'Kazakh' : source === 'kz' && authors.some((a) => a.spoken.includes(RU)) ? 'Russian'
            : source === 'kz' ? 'Kazakh' : 'Russian',
        ruKnown: source === 'ru' || Boolean(w.ru),
        genres: genreNames(w),
      }
    }
    const own = [...ruNew.map(record('ru')), ...kzNew.map(record('kz'))]

    // ——— Запись
    await db.query('BEGIN')
    if (dupesOnly) {
      await fillDupes()
      await db.query('COMMIT')
      console.log(`Дубли с Amazon: ${dupes.length} произведений, книг Amazon ${dupes.reduce((n, d) => n + d.ids.length, 0)} (только русские поля)`)
      return
    }
    const cols = ['id', 'title', 'author', 'year', 'section', 'category', 'subsection', 'language', 'isbn13', 'cover', 'annotation',
      'rating', 'ratings_count', 'weighted_rating', 'source', 'fame', 'wikidata_qid', 'title_ru', 'author_ru', 'ru_known',
      'annotation_ru', 'annotation_source', 'annotation_url']
    const asRow = (b) => [b.id, b.title, b.author, b.year, b.section, b.section, b.subsection, b.language, b.isbn13, b.cover, b.annotation,
      null, 0, prior, b.source, b.fame, b.qid, b.titleRu, b.authorRu, b.ruKnown, b.annotationRu, b.annotationRu || b.annotationUrl ? 'wikipedia' : null, b.annotationUrl]
    for (const b of own) {
      await db.query(`INSERT INTO books (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
        ON CONFLICT (id) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`, asRow(b))
    }
    // Своих книг, выпавших из пилота, больше нет (оценки и полки по ним удаляются каскадом)
    const removed = await db.query(`DELETE FROM books WHERE source IN ('ru', 'kz') AND NOT (id = ANY($1::varchar[]))`, [own.map((b) => b.id)])
    await fillDupes()
    await db.query('COMMIT')
    // Дубли: книгам Amazon — русское название, QID, описание из Википедии (если своего из Википедии нет)
    async function fillDupes() {
      for (const d of dupes) {
        const text = ruText(d.w)
        await db.query(`UPDATE books SET title_ru = coalesce(title_ru, $2), wikidata_qid = coalesce(wikidata_qid, $3), ru_known = true,
            annotation_ru = CASE WHEN $4::text IS NOT NULL AND annotation_source IS DISTINCT FROM 'wikipedia' THEN $4 ELSE annotation_ru END,
            annotation_url = CASE WHEN $4::text IS NOT NULL AND annotation_source IS DISTINCT FROM 'wikipedia' THEN $5 ELSE annotation_url END,
            annotation_source = CASE WHEN $4::text IS NOT NULL AND annotation_source IS DISTINCT FROM 'wikipedia' THEN 'wikipedia' ELSE annotation_source END
          WHERE id = ANY($1::varchar[])`, [d.ids, d.w.ru, d.qid, text, d.w.ruArticle ? wikiUrl('ru', d.w.ruArticle) : null])
      }
    }

    // ——— Тексты для векторов ML
    const tmp = `${OWN_PARQUET}.json`
    fs.writeFileSync(tmp, own.map((b) => JSON.stringify({
      book_id: b.id, source: b.source,
      text: [b.title, b.titleRu, b.author, b.genres.join(', '), b.annotation].filter(Boolean).join('. '),
    })).join('\n'))
    const duck = await (await DuckDBInstance.create(':memory:')).connect()
    const p = (f) => `'${f.replaceAll('\\', '/')}'`
    await duck.run(`COPY (SELECT * FROM read_json_auto(${p(tmp)}, format = 'newline_delimited')) TO ${p(OWN_PARQUET)} (FORMAT parquet)`)
    duck.closeSync?.()
    fs.rmSync(tmp)

    const withText = (list) => list.filter((b) => b.annotation).length
    const withCover = (list) => list.filter((b) => b.cover).length
    const ru = own.filter((b) => b.source === 'ru')
    const kz = own.filter((b) => b.source === 'kz')
    const era = (y) => (y == null ? 'год неизвестен' : y < 1800 ? 'до XIX века' : y < 1900 ? 'XIX век' : y < 1917 ? '1900–1916' : y < 1991 ? '1917–1990' : 'с 1991')
    const eras = {}
    for (const b of ru) eras[era(b.year)] = (eras[era(b.year)] ?? 0) + 1
    console.log(`Русских: ${ru.length} (описание ${withText(ru)}, обложка ${withCover(ru)}); по эпохам: ${JSON.stringify(eras)};`
      + ` отброшено: стоп-список ${skipped.stop}, язык не русский ${skipped.notRussian}, без автора ${skipped.noAuthor},`
      + ` автор не писатель ${skipped.notWriter}`)
    console.log(`Казахских: ${kz.length} (описание ${withText(kz)}, обложка ${withCover(kz)}; на казахском ${kz.filter((b) => b.language === 'Kazakh').length})`)
    console.log(`Дубли с Amazon: ${dupes.length} произведений (по QID ${dupes.filter((d) => d.how === 'qid').length}, по названию и автору ${dupes.filter((d) => d.how === 'title').length}), книг Amazon дополнено ${dupes.reduce((n, d) => n + d.ids.length, 0)}`)
    console.log(`Казахский черновик: ${draft.length} строк, ${new Set(draft.map((d) => d.p)).size} писателей → ${KZ_DRAFT}; удалено своих книг вне пилота: ${removed.rowCount}`)
    console.log(`Время ${((Date.now() - started) / 60000).toFixed(1)} мин`)
    return { ru, kz, dupes, draft }
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await db.end()
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
