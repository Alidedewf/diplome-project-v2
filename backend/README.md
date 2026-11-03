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
| `GET /onboarding/next-round` | `{ session, round, done, items: [{ book, reason }] }` |
| `POST /onboarding/answers` `{ topics?, description?, round?, answers?: [{ bookId, answer: like\|dislike\|unread, source?: round\|search }], completed? }` | `{ saved, user }` |
| `PUT /me/ratings/:bookId` `{ value: 1–5 }` · `DELETE` | `{ bookId, rating, shelf: 'read', readAt }` · 204 |
| `PUT /me/shelves/:bookId` `{ shelf: want\|reading\|read, readAt? }` · `DELETE` | `{ bookId, shelf, readAt }` · 204 |
| `PUT /me/hidden/:bookId` · `DELETE` | `{ bookId, hidden: true }` · 204 |
| `POST /me/events` `{ type: view\|rec_click\|search, bookId?, query?, payload? }` или `{ events: [...] }` | `{ saved }` (202) |
| `GET /me/shelves?shelf=&sort=date\|title\|rating&limit=&offset=` | `{ items: [{ book, shelf, rating, addedAt, readAt }], total, counts: { want, reading, read } }` |
| `GET /me/ratings?sort=date\|rating&limit=&offset=` | `{ items: [{ book, rating, ratedAt }], total }` |
| `GET /me/hidden?limit=&offset=` | `{ items: [{ book, hiddenAt }], total }` |
| `GET /me/taste` · `PATCH /me/taste` `{ kind: section\|subsection\|author, value, rejected }` | `{ items: [{ kind, value, label, source, weight }], rejected: [{ kind, value, label }], description }` |
| `GET /me/stats?year=&tz=` | `{ year, timeZone, years, readTotal, readThisYear, byMonth, bySection, ratings, goal }` |
| `PUT /me/goal` `{ target, year?, tz? }` · `DELETE /me/goal?year=&tz=` | `{ year, target, done }` · 204 |
| `PATCH /me/profile` `{ name?, email?, password?, currentPassword? }` · `DELETE /me` `{ password }` | `{ user }` · 204 |

`Reason` — `{ kind: 'similar' | 'topic' | 'popular', text, seedId? }`. Ошибки проверки (`validation_error`) — по-русски, в `details: [{ path, message }]`.

Онбординг идёт сессиями: `completed: true` (настоящее завершение) закрывает сессию и ставит `onboardingCompleted`; следующие ответы — новая сессия с раунда 1. Без `completed` («Пропустить») сессия остаётся открытой, возврат продолжает её раунды. Ответы прошлых сессий остаются в профиле. Подсказки `/search/suggest` после входа не показывают скрытые книги.

### Кабинет

- Списки: по умолчанию `limit=20`, сначала новые (`sort=date`; на полке «Прочитал» — по дате прочтения); `title` — по названию, `rating` — по моей оценке (без оценки — в конце). `addedAt` — когда книга попала на эту полку.
- `readAt` — дата прочтения: ставится при первом попадании на «Прочитал» (полкой или оценкой), при переезде между полками сохраняется. Задать вручную — `PUT /me/shelves/:id` `{ shelf: 'read', readAt: '2025-12-31' }` (день или дата со временем в ISO, не в будущем). `DELETE` полки удаляет и её.
- `taste`: `source` — `onboarding` (выбрано в онбординге) или `profile` (выведено из понравившегося либо возвращено после «Это не про меня»); `weight` — сколько понравившихся книг в теме. Выведенные подразделы и авторы с одной книгой не показываются. `description` — последнее «Опишите своими словами» из онбординга или `null`.
- `stats` — всё, кроме `readTotal`, за выбранный год (по умолчанию текущий). `tz` — часовой пояс пользователя (`Intl.DateTimeFormat().resolvedOptions().timeZone`, по умолчанию UTC): по нему книга попадает в месяц и год (по `readAt`). `years` — годы для переключателя (где есть прочитанное, оценки или цель, плюс текущий), по убыванию. `byMonth` — 12 месяцев `{ month: 1–12, count }`. `bySection` — до 10 разделов `{ section, label, count, averageRating }` по числу прочитанного; книги без раздела онбординга (служебные категории Amazon) — одной строкой `{ section: null, label: 'Другое' }` в конце. `ratings` — `{ count, average, distribution: { 1…5 } }` по оценкам за год. `goal` — `{ year, target, done }` или `null`.
- `DELETE /me` и смена email/пароля в `PATCH /me/profile` — только с паролем (`password` / `currentPassword`), иначе 403 `wrong_password`.
- `POST /me/events` — `view` (просмотр карточки), `rec_click` (клик по рекомендации, `payload: { kind, seedId?, place }`); запросы поиска сервер пишет сам.

## Векторы книг

Таблицы `embedding_models` (модель, размерность, сколько книг) и `book_embeddings` (книга, модель, `vector`). Моделей может быть несколько сразу; у каждой свой HNSW-индекс по косинусному расстоянию (`embedding::vector(dim)` с условием `model = …`). Пока ни к поиску, ни к ленте не подключено; запросы — [src/lib/embeddings.js](src/lib/embeddings.js).

```powershell
npm run load:embeddings -- ..\data\processed\book_embeddings.parquet [--model имя] [--work-mem 1GB]
```

Файл: `book_id` (или `parent_asin`), `embedding` — список чисел; название модели — колонка `model`, метаданные parquet `model` или `--model`; размерность — по длине векторов. Запуск заменяет все векторы этой модели, книги вне каталога пропускаются.

Рекомендации, онбординг и похожие книги пока считаются заглушками в [src/services/recommender.js](src/services/recommender.js); с появлением ML-сервиса (3.8) меняется только этот модуль.
