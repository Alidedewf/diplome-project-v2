import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { BOOKS } from './fixtures.js'
import { app } from './helpers.js'

const BOOK_KEYS = ['annotation', 'author', 'cover', 'id', 'rating', 'ratingsCount', 'section', 'subsection', 'title', 'year']

describe('каталог и поиск', () => {
  it('книга в форме слоя данных фронтенда; нет книги — 404', async () => {
    const res = await request(app).get(`/api/books/${BOOKS[0].id}`).expect(200)
    expect(Object.keys(res.body).sort()).toEqual([...BOOK_KEYS, 'my', 'recommendation'].sort())
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

  it('фильтры поиска', async () => {
    const res = await request(app).get('/api/search')
      .query({ q: 'book', section: 'Science Fiction & Fantasy', year: '2012-2013' }).expect(200)
    expect(res.body.total).toBe(4)
    expect(res.body.items.every((b) => b.year >= 2012 && b.year <= 2013)).toBe(true)
    await request(app).get('/api/search').query({ q: 'book', year: '12' }).expect(400)
  })
})
