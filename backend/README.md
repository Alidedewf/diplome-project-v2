# Бэкенд сайта

Node.js 24, Express 5, Prisma 7 (адаптер `pg`), PostgreSQL 17 + pgvector в Docker, zod, JWT + bcryptjs. Решения — [решения.md](../решения.md), разделы 4, 4.1, 4.2.

## Запуск

```powershell
copy .env.example .env          # в корне проекта; поменять пароли и JWT_SECRET
docker compose up -d            # база: localhost:5432
cd backend
npm install
npm run db:generate             # Prisma Client → src/generated/
npm run db:migrate              # таблицы, индексы, расширения pg_trgm и vector
npm run load:books              # data/processed/books_clean.parquet → books (~40 с; повторно — без дублей)
npm run dev                     # API: http://localhost:3000/api
npm test                        # vitest + supertest, отдельная база bookmind_test
```

## Запросы

Все адреса с префиксом `/api`, ответы — JSON, ошибки — `{ error: { code, message, details? } }`.
Вход — заголовок `Authorization: Bearer <token>`. Книга — в форме слоя данных фронтенда:
`{ id, title, author, year, section, subsection, cover, rating, ratingsCount, annotation }`.

| Запрос | Ответ |
|---|---|
| `POST /auth/register` `{ email, password, name }` · `POST /auth/login` `{ email, password }` | `{ token, user }` |
| `GET /auth/me` | `{ user }` |
| `GET /sections` | `[{ name, booksCount }]` |
| `GET /books?section=&sort=popular\|rating&limit=&offset=` | `{ items: Book[], total }` |
| `GET /books/:id` | `Book & { recommendation: Reason \| null, my: { rating, shelf, hidden } \| null }` |
| `GET /books/:id/similar?limit=` | `Book[]` |
| `GET /search?q=&section=&year=2015\|2010-2015&rating=&hideRead=1&limit=&offset=` | `{ items: Book[], total, fuzzy }` |
| `GET /search/suggest?q=` | `[{ id, title, author, year, cover }]` |
| `GET /recommendations?limit=` | `{ forYou: [{ book, reason }], becauseYouLiked: [{ seed, items: [{ book, reason }] }] }` |
| `GET /onboarding/next-round` | `{ round, done, items: [{ book, reason }] }` |
| `POST /onboarding/answers` `{ topics?, round?, answers?: [{ bookId, answer: like\|dislike\|unread }], completed? }` | `{ saved, user }` |
| `PUT /me/ratings/:bookId` `{ value: 1–5 }` · `DELETE` | `{ bookId, rating, shelf: 'read' }` · 204 |
| `PUT /me/shelves/:bookId` `{ shelf: want\|reading\|read }` · `DELETE` | `{ bookId, shelf }` · 204 |
| `PUT /me/hidden/:bookId` · `DELETE` | `{ bookId, hidden: true }` · 204 |
| `POST /me/events` `{ type: view\|rec_click\|search, bookId?, query?, payload? }` или `{ events: [...] }` | `{ saved }` (202) |
| `GET /me/shelves?shelf=` | `{ items: [{ book, shelf, rating, addedAt }], total, counts }` |
| `GET /me/ratings` · `GET /me/hidden` | `{ items: [{ book, rating, ratedAt }], total }` · `{ items: [{ book, hiddenAt }], total }` |
| `GET /me/taste` · `PATCH /me/taste` `{ kind, value, rejected }` | `{ items: [{ kind, value, label, source, weight }], rejected }` |
| `GET /me/stats?year=` | `{ year, readTotal, readThisYear, byMonth, bySection, ratings, goal }` |
| `PUT /me/goal` `{ target, year? }` | `{ year, target, done }` |
| `PATCH /me/profile` `{ name?, email?, password?, currentPassword? }` · `DELETE /me` `{ password }` | `{ user }` · 204 |

`Reason` — `{ kind: 'similar' | 'topic' | 'popular', text, seedId? }`.

Рекомендации, онбординг и похожие книги пока считаются заглушками в [src/services/recommender.js](src/services/recommender.js); с появлением ML-сервиса (3.8) меняется только этот модуль.
