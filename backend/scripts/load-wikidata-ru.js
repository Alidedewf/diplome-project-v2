// Русские имена авторов и названия книг из Wikidata → authors_ru, books.author_ru / title_ru / ru_known (решения.md 2.8, 4.8).
//
// Ярлыки ищем и на английском, и в «mul» (многоязычный ярлык Wikidata: у многих людей и книг английского ярлыка больше
// нет — Douglas Adams, Q42, только «Douglas Adams»@mul; без mul он не находился).
// Авторы книг с RATINGS_AUTHORS+ оценками: человек (P31 Q5 или Q21070568 — существование оспаривается, Гомер), у которого
// имя или его вариант (rdfs:label или skos:altLabel @en/@mul) совпадает с именем в каталоге; варианты — «J.K. Rowling» / «J. K. Rowling». Несколько людей с таким
// именем — берём писателя (род занятий P106 из WRITER или автор хоть одного произведения P50), из нескольких писателей —
// только явно самого известного (статей в Википедиях вдвое больше, чем у следующего), иначе и без писателя — пропуск. Русское имя — rdfs:label@ru кириллицей.
// Псевдоним (найден по altLabel, фамилия основного имени другая: Robert Galbraith → Джоан Роулинг) — русское имя
// не показываем.
// «Известный» ≠ «переводной»: русское имя есть и у знаменитых американцев, чьи книги у нас не издавали (Раш Лимбо,
// Билл О'Рейли). Поэтому для ru_known автор засчитывается, если хоть у одной его книги в каталоге есть русское название,
// или у его произведений в Wikidata (P50) есть русское название (переводили), или он писатель по профессии (P106 из
// TRANSLATED_OCCUPATIONS) и не публичная фигура из PUBLIC_OCCUPATIONS (у телеведущих и политиков «writer» в профессиях
// тоже есть). Только «переводы в Wikidata» — слишком строго: у Сэндфорда, Корнуэлл, Слотер их там нет.
// Русское имя показываем в любом случае.
// Книги с RATINGS_TITLES+ оценками: произведение с автором (P50), чьё английское название совпадает с названием книги
// до «:» / «(» и у одного из авторов та же фамилия; русское название — rdfs:label@ru кириллицей.
//
// Русское описание: у произведения со статьёй в русской Википедии (sitelink) — начало статьи (API extracts, вступление
// без разметки, первые абзацы до ~WIKI_MAX_CHARS символов) → books.annotation_ru, annotation_source = 'wikipedia',
// annotation_url — ссылка на статью (CC BY-SA, подпись на карточке). Машинный перевод ('mt') этот скрипт не трогает.
//
// Пишет только книги Amazon (source = 'amazon'); QID сопоставленного произведения — в books.wikidata_qid (по нему
// scripts/load-own-books.js находит дубли). load-own-books запускать после этого скрипта: он дописывает русские поля
// книгам Amazon, совпавшим с русскими произведениями, а этот их сбрасывает.
//
// Ответы Wikidata и Википедии кэшируются в data/processed/wikidata_ru.json (по каждому запрошенному имени и названию, в том числе
// пустые): повторный запуск спрашивает только новое, --offline — без сети.
//
// Запуск из backend/:  npm run load:wikidata-ru [-- --offline] [--limit N]
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { config, ROOT } from '../src/config.js'

const CACHE = path.join(ROOT, 'data/processed/wikidata_ru.json')
const RATINGS_AUTHORS = 20
const RATINGS_TITLES = 50
const BATCH = 80
const PAUSE_MS = 1500
const WIKI_API = 'https://ru.wikipedia.org/w/api.php'
const WIKI_BATCH = 20 // столько статей отдаёт extracts со вступлением за раз
const WIKI_PAUSE_MS = 500
const WIKI_MAX_CHARS = 900
const UA = { 'User-Agent': 'diploma-research/0.1 (student project)', Accept: 'application/sparql-results+json' }
// writer, author, novelist, poet, children's writer, science fiction writer, playwright, essayist, journalist,
// screenwriter, short story writer
const WRITER = ['Q36180', 'Q482980', 'Q6625963', 'Q49757', 'Q4853732', 'Q18844224', 'Q214917', 'Q11774202', 'Q1930187',
  'Q28389', 'Q15949613']

// Из нескольких писателей с одним именем — самый известный, если статей в Википедиях у него не меньше
// DOMINANT_MIN_LINKS и в DOMINANT_RATIO раз больше, чем у следующего
const DOMINANT_MIN_LINKS = 5
// Профессии, при которых русское имя автора засчитывается в ru_known: writer, novelist, poet, children's writer,
// journalist, essayist, screenwriter, historian, biographer и разновидности писателя — science fiction writer,
// playwright, short story writer
export const TRANSLATED_OCCUPATIONS = new Set(['Q36180', 'Q6625963', 'Q49757', 'Q4853732', 'Q1930187', 'Q11774202',
  'Q28389', 'Q201788', 'Q864380', 'Q18844224', 'Q214917', 'Q15949613'])
// Публичные профессии, при которых «писатель» в Wikidata не значит «переводной»: politician, businessperson, entrepreneur,
// television presenter, news presenter, presenter, radio personality, radio pundit, disc jockey, television personality,
// motivational speaker, model
export const PUBLIC_OCCUPATIONS = new Set(['Q82955', 'Q43845', 'Q131524', 'Q947873', 'Q270389', 'Q13590141', 'Q2722764',
  'Q112122634', 'Q130857', 'Q44508716', 'Q15982858', 'Q4610556'])
const DOMINANT_RATIO = 2
const CYRILLIC = /[А-Яа-яЁё]/
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quoted = (s) => `"${s.replaceAll('\\', '').replaceAll('"', '\\"')}"`
const literals = (list) => list.flatMap((s) => [`${quoted(s)}@en`, `${quoted(s)}@mul`]).join(' ')
// Версия кэша: 2 — ярлыки и @mul (ответы версии 1 без mul неполные, спрашиваем заново)
const CACHE_VERSION = 2
// Ключ имени для сравнения: регистр, точки, пробелы, диакритика — «J.K. Rowling» = «J. K. Rowling»
export const nameKey = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '')
const lastName = (s) => nameKey(s.split(/[ ,]+/).filter(Boolean).pop() ?? '')
export const shortTitle = (t) => t.split(/[:(]/)[0].trim()

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())

// Как имя может быть записано в Wikidata
export function nameVariants(author) {
  const clean = author.replace(/\s+/g, ' ').trim()
  const v = new Set([clean])
  v.add(clean.replace(/\b(\p{Lu})\.(?=\p{Lu})/gu, '$1. ')) // J.K. Rowling → J. K. Rowling
  v.add(clean.replace(/\b(\p{Lu})\. (?=\p{Lu}\.)/gu, '$1.')) // J. K. Rowling → J.K. Rowling
  if (clean === clean.toUpperCase() || clean === clean.toLowerCase()) v.add(titleCase(clean))
  return [...v]
}

// Как название может быть записано в Wikidata: «The Lord Of The Rings» → «The Lord of the Rings»
const SMALL = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'with', 'from', 'as'])
export function titleVariants(title) {
  const v = new Set([title])
  v.add(title.split(' ').map((w, i) => (i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w)).join(' '))
  return [...v]
}

const authorQuery = (names) => `SELECT ?n ?p ?en ?ru ?links ?writer WHERE {
  VALUES ?n { ${literals(names)} }
  { ?p rdfs:label ?n } UNION { ?p skos:altLabel ?n }
  VALUES ?human { wd:Q5 wd:Q21070568 }
  ?p wdt:P31 ?human .
  OPTIONAL { ?p rdfs:label ?en FILTER(lang(?en) IN ("en", "mul")) }
  OPTIONAL { ?p rdfs:label ?ru FILTER(lang(?ru) = "ru") }
  OPTIONAL { ?p wikibase:sitelinks ?links }
  BIND((EXISTS { ?p wdt:P106 ?occ . VALUES ?occ { ${WRITER.map((w) => `wd:${w}`).join(' ')} } }
    || EXISTS { ?work wdt:P50 ?p }) AS ?writer)
}`

// Сколько произведений человека (P50) с русским названием
const ruWorksQuery = (qids) => `SELECT ?p (COUNT(DISTINCT ?w) AS ?n) WHERE {
  VALUES ?p { ${qids.map((q) => `wd:${q}`).join(' ')} }
  ?w wdt:P50 ?p ; rdfs:label ?l . FILTER(lang(?l) = "ru")
} GROUP BY ?p`

const occupationQuery = (qids) => `SELECT ?p ?occ WHERE {
  VALUES ?p { ${qids.map((q) => `wd:${q}`).join(' ')} }
  ?p wdt:P106 ?occ .
}`

const articleQuery = (qids) => `SELECT ?w ?name WHERE {
  VALUES ?w { ${qids.map((q) => `wd:${q}`).join(' ')} }
  ?article schema:about ?w ; schema:isPartOf <https://ru.wikipedia.org/> ; schema:name ?name .
}`

// Вступления статей: { название статьи: текст | '' }
export async function fetchExtracts(titles, store, save, api = WIKI_API) {
  const missing = titles.filter((t) => !(t in store))
  if (!missing.length) return 0
  console.log(`Статьи Википедии: спрашиваем ${missing.length}`)
  const started = Date.now()
  for (let i = 0; i < missing.length; i += WIKI_BATCH) {
    const batch = missing.slice(i, i + WIKI_BATCH)
    const url = new URL(api)
    for (const [k, v] of Object.entries({ action: 'query', prop: 'extracts', exintro: 1, explaintext: 1, redirects: 1,
      exlimit: WIKI_BATCH, format: 'json', formatversion: 2, titles: batch.join('|') })) url.searchParams.set(k, v)
    let body
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, { headers: { 'User-Agent': UA['User-Agent'] }, signal: AbortSignal.timeout(60_000) }).catch(() => null)
      if (res?.ok) { body = await res.json(); break }
      if (attempt >= 5) throw new Error(`Википедия: HTTP ${res?.status ?? 'нет ответа'}`)
      await sleep(5000 * attempt)
    }
    // Переадресации: запрошенное название → итоговое
    const target = new Map(batch.map((t) => [t, t]))
    for (const r of [...(body.query.normalized ?? []), ...(body.query.redirects ?? [])]) {
      for (const [from, to] of target) if (to === r.from) target.set(from, r.to)
    }
    const text = new Map((body.query.pages ?? []).map((pg) => [pg.title, pg.extract ?? '']))
    for (const t of batch) store[t] = text.get(target.get(t)) ?? ''
    if ((i / WIKI_BATCH) % 10 === 9) save()
    await sleep(WIKI_PAUSE_MS)
  }
  save()
  return (Date.now() - started) / 1000
}

// Начало статьи: первые абзацы, пока не наберётся ~WIKI_MAX_CHARS (не меньше одного)
export function wikiIntro(extract) {
  const paragraphs = extract.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 40)
  const out = []
  for (const p of paragraphs) {
    if (out.length && out.join(' ').length + p.length > WIKI_MAX_CHARS) break
    out.push(p)
    if (out.length === 2) break
  }
  return out.join('\n\n') || null
}

const titleQuery = (titles) => `SELECT ?t ?w ?ru ?aEn WHERE {
  VALUES ?t { ${literals(titles)} }
  ?w rdfs:label ?t ; wdt:P50 ?a .
  OPTIONAL { ?w rdfs:label ?ru FILTER(lang(?ru) = "ru") }
  OPTIONAL { ?a rdfs:label ?aEn FILTER(lang(?aEn) IN ("en", "mul")) }
}`

export async function sparql(query) {
  const url = new URL('https://query.wikidata.org/sparql')
  url.searchParams.set('query', query)
  for (let attempt = 1; ; attempt++) {
    let res
    try {
      res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(90_000) })
    } catch (err) {
      if (attempt >= 5) throw err
      await sleep(5000 * attempt)
      continue
    }
    if (res.ok) return (await res.json()).results.bindings
    // Таймаут запроса на стороне Wikidata — 500: пачку дробим (вызывающий код), перегрузка — ждём
    if (res.status >= 500 && attempt >= 2) return null
    if (attempt >= 6) throw new Error(`Wikidata: HTTP ${res.status}`)
    const retry = Number(res.headers.get('retry-after'))
    await sleep(retry ? retry * 1000 : 5000 * attempt)
  }
}

// Спросить в Wikidata всё, чего нет в кэше; ответы раскладываются по ключам (имя / название), пустые — тоже
export async function fetchMissing({ keys, store, query, keyOf, toCandidate, label, save, batch: size = BATCH }) {
  const missing = keys.filter((k) => !(k in store))
  if (!missing.length) return 0
  console.log(`${label}: спрашиваем ${missing.length} из ${keys.length}`)
  const started = Date.now()
  const queue = []
  for (let i = 0; i < missing.length; i += size) queue.push(missing.slice(i, i + size))
  let done = 0
  let batches = 0
  while (queue.length) {
    const batch = queue.shift()
    const rows = await sparql(query(batch))
    if (rows === null) {
      // Не уложились в таймаут — пополам; одно значение не ответило — считаем пустым
      if (batch.length > 1) queue.unshift(batch.slice(0, batch.length / 2), batch.slice(batch.length / 2))
      else store[batch[0]] = []
      continue
    }
    for (const k of batch) store[k] = []
    for (const r of rows) store[keyOf(r)]?.push(toCandidate(r))
    done += batch.length
    if (++batches % 10 === 0) {
      save()
      const min = (Date.now() - started) / 60000
      console.log(`  ${done} / ${missing.length}, ${min.toFixed(1)} мин`)
    }
    await sleep(PAUSE_MS)
  }
  save()
  return (Date.now() - started) / 1000
}

// Кандидаты одного автора (по всем вариантам имени) → человек или null
export function resolveAuthor(author, candidates) {
  const byId = new Map()
  for (const c of candidates) {
    const prev = byId.get(c.qid)
    // Один и тот же человек мог найтись и по label, и по altLabel — главное совпадение по label
    byId.set(c.qid, prev ? { ...prev, alt: prev.alt && c.alt } : c)
  }
  let people = [...byId.values()]
  if (people.length > 1) people = people.filter((p) => p.writer)
  if (!people.length) return null
  const [person, second] = people.sort((a, b) => b.links - a.links)
  // Несколько писателей-тёзок — только если один явно известнее (иначе «Robin Brown», «Justin Wilson» из каталога
  // получали имя случайного тёзки)
  if (second && !(person.links >= DOMINANT_MIN_LINKS && person.links >= DOMINANT_RATIO * second.links)) return null
  if (!person.ru || !CYRILLIC.test(person.ru)) return null
  // Найден по варианту имени с другой фамилией — псевдоним: русское имя другого человека не показываем
  const pseudonym = person.alt && person.en && lastName(person.en) !== lastName(author)
  // «Крюгер, Уильям Кент» → «Уильям Кент Крюгер»
  const nameRu = person.ru.replace(/^([^,]+),\s*([^,]+)$/, '$2 $1')
  return { qid: person.qid, nameRu: pseudonym ? null : nameRu }
}

export function resolveTitle(book, candidates) {
  const last = lastName(book.author)
  const hit = candidates.find((c) => c.ru && CYRILLIC.test(c.ru) && c.authors.some((a) => lastName(a) === last))
  return hit ? { ru: hit.ru, qid: hit.qid } : null
}

async function main() {
  const args = process.argv.slice(2)
  const offline = args.includes('--offline')
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity
  const started = Date.now()

  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : { authors: {}, titles: {} }
  if (cache.version !== CACHE_VERSION) Object.assign(cache, { version: CACHE_VERSION, authors: {}, titles: {} })
  cache.occupations ??= {}
  cache.ruWorks ??= {}
  cache.articles ??= {}
  cache.extracts ??= {}
  const save = () => {
    const tmp = `${CACHE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ...cache, updatedAt: new Date().toISOString() }))
    fs.renameSync(tmp, CACHE)
  }

  const db = new pg.Client({ connectionString: config.databaseUrl })
  await db.connect()
  try {
    const authors = (await db.query(`
      SELECT author FROM books WHERE author IS NOT NULL AND ratings_count >= $1
      GROUP BY author ORDER BY max(ratings_count) DESC`, [RATINGS_AUTHORS])).rows.map((r) => r.author).slice(0, limit)
    const books = (await db.query(`
      SELECT id, title, author FROM books WHERE author IS NOT NULL AND ratings_count >= $1
      ORDER BY ratings_count DESC`, [RATINGS_TITLES])).rows.slice(0, limit)
      .map((b) => ({ ...b, short: shortTitle(b.title) })).filter((b) => b.short)

    const authorVariants = new Map(authors.map((a) => [a, nameVariants(a)]))
    const bookVariants = new Map(books.map((b) => [b.id, titleVariants(b.short)]))
    if (!offline) {
      const tA = await fetchMissing({
        keys: [...new Set([...authorVariants.values()].flat())],
        store: cache.authors,
        query: authorQuery,
        keyOf: (r) => r.n.value,
        toCandidate: (r) => ({
          qid: r.p.value.split('/').pop(), en: r.en?.value ?? null, ru: r.ru?.value ?? null,
          // Найден не по основному английскому имени, а по варианту (altLabel)
          links: Number(r.links?.value ?? 0), alt: r.en?.value !== r.n.value, writer: r.writer?.value === 'true',
        }),
        label: 'Авторы',
        save,
      })
      // Строки названий: одно произведение с несколькими авторами — несколько строк, собираем авторов вместе
      const tT = await fetchMissing({
        keys: [...new Set([...bookVariants.values()].flat())],
        store: cache.titles,
        query: titleQuery,
        keyOf: (r) => r.t.value,
        toCandidate: (r) => ({ qid: r.w.value.split('/').pop(), ru: r.ru?.value ?? null, authors: r.aEn ? [r.aEn.value] : [] }),
        label: 'Названия',
        save,
      })
      if (tA || tT) console.log(`Wikidata: авторы ${Math.round(tA)} с, названия ${Math.round(tT)} с`)
    }

    // Сопоставление
    const resolved = []
    for (const [author, variants] of authorVariants) {
      const person = resolveAuthor(author, variants.flatMap((v) => cache.authors[v] ?? []))
      if (person) resolved.push({ author, ...person })
    }
    const titled = []
    for (const b of books) {
      const byWork = new Map()
      for (const c of bookVariants.get(b.id).flatMap((v) => cache.titles[v] ?? [])) {
        const w = byWork.get(c.qid) ?? { ...c, authors: [] }
        w.authors.push(...c.authors)
        w.ru ??= c.ru
        byWork.set(c.qid, w)
      }
      const hit = resolveTitle(b, [...byWork.values()])
      if (hit) titled.push({ id: b.id, ru: hit.ru, qid: hit.qid, author: b.author })
    }

    // Профессии найденных людей — для правила «известный ≠ переводной»
    if (!offline) {
      const tO = await fetchMissing({
        keys: [...new Set(resolved.map((r) => r.qid))],
        store: cache.occupations,
        query: occupationQuery,
        keyOf: (r) => r.p.value.split('/').pop(),
        toCandidate: (r) => r.occ.value.split('/').pop(),
        label: 'Профессии',
        save,
      })
      const tW = await fetchMissing({
        keys: [...new Set(resolved.map((r) => r.qid))],
        store: cache.ruWorks,
        query: ruWorksQuery,
        keyOf: (r) => r.p.value.split('/').pop(),
        toCandidate: (r) => Number(r.n.value),
        label: 'Переведённые произведения',
        save,
      })
      if (tO || tW) console.log(`Wikidata: профессии ${Math.round(tO)} с, переводы ${Math.round(tW)} с`)
    }
    // Статьи русской Википедии о произведениях с русским названием → начало статьи
    if (!offline) {
      const tA = await fetchMissing({
        keys: [...new Set(titled.map((t) => t.qid))],
        store: cache.articles,
        query: articleQuery,
        keyOf: (r) => r.w.value.split('/').pop(),
        toCandidate: (r) => r.name.value,
        label: 'Статьи (sitelinks)',
        save,
      })
      const tE = await fetchExtracts([...new Set(Object.values(cache.articles).flat())], cache.extracts, save)
      if (tA || tE) console.log(`Википедия: ссылки ${Math.round(tA)} с, тексты ${Math.round(tE)} с`)
    }
    const described = []
    for (const t of titled) {
      const article = cache.articles[t.qid]?.[0]
      const intro = article && wikiIntro(cache.extracts[article] ?? '')
      if (intro) described.push({ id: t.id, text: intro, url: `https://ru.wikipedia.org/wiki/${encodeURIComponent(article.replaceAll(' ', '_'))}` })
    }

    const translatedAuthors = new Set(titled.map((t) => t.author))
    for (const r of resolved) {
      const occupations = cache.occupations[r.qid] ?? []
      r.writer = occupations.some((o) => TRANSLATED_OCCUPATIONS.has(o)) && !occupations.some((o) => PUBLIC_OCCUPATIONS.has(o))
      r.translated = (cache.ruWorks[r.qid]?.[0] ?? 0) > 0
      r.counts = r.writer || r.translated || translatedAuthors.has(r.author)
    }
    const counted = resolved.filter((r) => r.counts).map((r) => r.author)

    // Запись: всё заново в одной транзакции
    await db.query('BEGIN')
    await db.query('TRUNCATE authors_ru')
    await db.query(`INSERT INTO authors_ru (author, name_ru, qid)
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[])`,
    [resolved.map((r) => r.author), resolved.map((r) => r.nameRu), resolved.map((r) => r.qid)])
    await db.query(`UPDATE books SET title_ru = NULL, author_ru = NULL, ru_known = false, wikidata_qid = NULL
      WHERE source = 'amazon' AND (title_ru IS NOT NULL OR author_ru IS NOT NULL OR ru_known OR wikidata_qid IS NOT NULL)`)
    await db.query(`UPDATE books b SET author_ru = a.name_ru FROM authors_ru a WHERE b.author = a.author AND b.source = 'amazon'`)
    await db.query(`UPDATE books SET ru_known = true WHERE author = ANY($1::text[]) AND source = 'amazon'`, [counted])
    await db.query(`UPDATE books b SET title_ru = t.ru, wikidata_qid = t.qid, ru_known = true
      FROM unnest($1::text[], $2::text[], $3::text[]) AS t(id, ru, qid) WHERE b.id = t.id`,
    [titled.map((t) => t.id), titled.map((t) => t.ru), titled.map((t) => t.qid)])
    await db.query(`UPDATE books SET annotation_ru = NULL, annotation_source = NULL, annotation_url = NULL
      WHERE annotation_source = 'wikipedia' AND source = 'amazon'`)
    await db.query(`UPDATE books b SET annotation_ru = d.text, annotation_source = 'wikipedia', annotation_url = d.url
      FROM unnest($1::text[], $2::text[], $3::text[]) AS d(id, text, url) WHERE b.id = d.id`,
    [described.map((d) => d.id), described.map((d) => d.text), described.map((d) => d.url)])
    await db.query('COMMIT')

    const { rows: [s] } = await db.query(`SELECT
      count(*) FILTER (WHERE ratings_count >= ${RATINGS_AUTHORS}) AS a_all,
      count(*) FILTER (WHERE ratings_count >= ${RATINGS_AUTHORS} AND ru_known) AS a_ru,
      count(*) FILTER (WHERE ratings_count >= ${RATINGS_TITLES}) AS t_all,
      count(*) FILTER (WHERE ratings_count >= ${RATINGS_TITLES} AND ru_known) AS t_ru,
      count(*) FILTER (WHERE ratings_count >= ${RATINGS_TITLES} AND title_ru IS NOT NULL) AS t_title,
      count(*) FILTER (WHERE ru_known) AS ru_known
      FROM books`)
    const pct = (a, b) => `${Math.round((1000 * a) / b) / 10}%`
    console.log(`Авторов: ${authors.length}, с русским именем ${resolved.length} (${pct(resolved.length, authors.length)}),`
      + ` из них псевдонимов ${resolved.filter((r) => !r.nameRu).length}; засчитано в ru_known ${counted.length}`
      + ` (писатели по профессии ${resolved.filter((r) => r.writer).length}, с переводами в Wikidata`
      + ` ${resolved.filter((r) => r.translated).length}, остальные — по русскому названию книги)`)
    console.log(`Книг с ${RATINGS_TITLES}+ оценками: ${books.length}, с русским названием ${titled.length} (${pct(titled.length, books.length)}),`
      + ` с описанием из Википедии ${described.length} (${pct(described.length, books.length)})`)
    console.log(`ru_known: книги с ${RATINGS_AUTHORS}+ оценками ${pct(s.a_ru, s.a_all)}, с ${RATINGS_TITLES}+ — ${pct(s.t_ru, s.t_all)}`
      + `; всего ${s.ru_known}. Время ${((Date.now() - started) / 60000).toFixed(1)} мин`)
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
