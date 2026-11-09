import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { AUTHOR_BOOKS, BOOKS } from './fixtures.js'
import { app, registerUser } from './helpers.js'

const BOOK_KEYS = ['annotation', 'author', 'authorRu', 'cover', 'id', 'originalLanguage', 'rating', 'ratingsCount', 'section', 'source', 'subsection', 'title', 'titleRu', 'year']

describe('каталог и поиск', () => {
  it('книга в форме слоя данных фронтенда; нет книги — 404', async () => {
    const res = await request(app).get(`/api/books/${BOOKS[0].id}`).expect(200)
    expect(Object.keys(res.body).sort()).toEqual([...BOOK_KEYS, 'annotationRu', 'annotationSource', 'annotationUrl', 'my', 'recommendation'].sort())
    expect(res.body).toMatchObject({ recommendation: null, my: null })
    await request(app).get('/api/books/NOPE').expect(404)
  })

  it('разделы и списки по разделу', async () => {
    const sections = await request(app).get('/api/sections').expect(200)
    expect(sections.body).toEqual(expect.arrayContaining([
      { name: 'Science Fiction & Fantasy', booksCount: 10 },
      { name: 'Mystery, Thriller & Suspense', booksCount: 10 },
    ]))
    const list = await request(app).get('/api/books').query({ section: 'Mystery, Thriller & Suspense', limit: 3 }).expect(200)
    expect(list.body.total).toBe(10)
    expect(Object.keys(list.body.items[0]).sort()).toEqual(BOOK_KEYS)
    const counts = list.body.items.map((b) => b.ratingsCount)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
  })

  it('поиск по названию, по автору и с опечаткой', async () => {
    const byTitle = await request(app).get('/api/search').query({ q: 'fantasy book 3' }).expect(200)
    expect(byTitle.body.items[0].title).toBe('Fantasy Book 3')

    const author = BOOKS[7].author
    const byAuthor = await request(app).get('/api/search').query({ q: author }).expect(200)
    expect(byAuthor.body.items[0].author).toBe(author)

    const typo = await request(app).get('/api/search').query({ q: 'fantazy book' }).expect(200)
    expect(typo.body.fuzzy).toBe(true)
    expect(typo.body.items[0].subsection).toBe('Fantasy')
  })

  it('запрос по имени автора: сначала его книги по популярности, потом книги о нём (SRCH-02)', async () => {
    const order = AUTHOR_BOOKS.filter((b) => b.author === 'Mara Quill')
      .sort((a, b) => b.ratingsCount - a.ratingsCount).map((b) => b.id)
    for (const q of ['mara quill', 'MARA  QUILL', 'Mara-Quill']) {
      const res = await request(app).get('/api/search').query({ q }).expect(200)
      expect(res.body.items.map((b) => b.id)).toEqual([...order, 'Q000000004'])
    }
  })

  it('скрытая книга не попадает в подсказки, но гость её видит (SRCH-15)', async () => {
    const u = await registerUser()
    const [hidden, kept] = AUTHOR_BOOKS
    const ids = async (auth) => (await request(app).get('/api/search/suggest').query({ q: 'mara' }).set(auth).expect(200))
      .body.map((b) => b.id)
    await request(app).put(`/api/me/hidden/${hidden.id}`).set(u.auth).expect(200)
    expect(await ids(u.auth)).not.toContain(hidden.id)
    expect(await ids(u.auth)).toContain(kept.id)
    expect(await ids({})).toContain(hidden.id)
  })

  it('опечатки: стоп-слова не мешают, слова в другом порядке и слова из названия вместе с автором', async () => {
    const titles = async (q) => {
      const res = await request(app).get('/api/search').query({ q, mode: 'keyword' }).expect(200)
      expect(res.body.fuzzy).toBe(true)
      return res.body.items.map((b) => b.title)
    }
    // Стоп-слово в запросе и опечатка
    expect((await titles('the silent rivr'))[0]).toBe('Silent River')
    expect((await titles('the rivr'))).toContain('Silent River') // одно значимое слово — ищем по нему
    // Фраза не похожа (слова переставлены) — по словам: каждое похоже на слово имени автора или названия
    expect(await titles('quil mara')).toEqual(expect.arrayContaining(AUTHOR_BOOKS.map((b) => b.title)))
    // Слова названия и фамилия автора в одном запросе
    expect((await titles('glas orchard quil'))[0]).toBe('Glass Orchard')
  })

  it('фильтры поиска', async () => {
    const res = await request(app).get('/api/search')
      .query({ q: 'book', section: 'Science Fiction & Fantasy', year: '2012-2013' }).expect(200)
    expect(res.body.total).toBe(4)
    expect(res.body.items.every((b) => b.year >= 2012 && b.year <= 2013)).toBe(true)
    await request(app).get('/api/search').query({ q: 'book', year: '12' }).expect(400)
  })
})
