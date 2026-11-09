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
npm run load:wikidata-ru        # русские имена и названия из Wikidata (см. «Книги на языке читателя»)
npm run load:own-books          # свой каталог русских и казахских книг (после load:wikidata-ru, см. «Свой каталог»)
npm run dev                     # API: http://localhost:3000/api
npm test                        # vitest + supertest, отдельная база bookmind_test
```

## Запросы

Все адреса с префиксом `/api`, ответы — JSON, ошибки — `{ error: { code, message, details? } }`.
Вход — заголовок `Authorization: Bearer <token>`. Книга — в форме слоя данных фронтенда:
`{ id, title, titleRu, author, authorRu, year, section, subsection, cover, rating, ratingsCount, annotation }`
(`titleRu` / `authorRu` — из Wikidata, чаще `null`) и `source: 'amazon' | 'ru' | 'kz'`. Пользователь — `{ id, email, name, createdAt, onboardingCompleted, readingLanguages }`.

| Запрос | Ответ |
|---|---|
| `POST /auth/register` `{ email, password, name }` · `POST /auth/login` `{ email, password }` | `{ token, user }` |
| `GET /auth/me` | `{ user }` |
| `GET /sections` | `[{ name, booksCount }]` |
| `GET /books?section=&source=amazon\|ru\|kz&sort=popular\|rating&limit=&offset=` | `{ items: Book[], total }` |
| `GET /books/:id` | `Book & { annotationRu, annotationSource: 'wikipedia' \| 'mt' \| null, annotationUrl, recommendation: Reason \| null, my: { rating, shelf, hidden } \| null }` |
| `GET /books/:id/similar?limit=` | `Book[]` |
| `GET /search?q=&section=&year=2015\|2010-2015&rating=&hideRead=1&mode=hybrid\|keyword\|semantic&semWeight=&limit=&offset=` | `{ items: Book[], total, fuzzy, mode }` |
| `GET /search/suggest?q=` | `[{ id, title, titleRu, author, authorRu, year, cover }]` |
| `GET /recommendations?limit=` | `{ forYou: [{ book, reason }], series: [{ name, seeds: Book[], items: [{ book, reason }] }], local: [{ source: 'ru' \| 'kz', items: [{ book, reason }] }], becauseYouLiked: [{ seed, items: [{ book, reason }] }] }` |
| `GET /onboarding/next-round` | `{ session, round, done, items: [{ book, reason }] }` |
| `POST /onboarding/answers` `{ topics?, description?, readingLanguages?, round?, answers?: [{ bookId, answer: like\|dislike\|unread, source?: round\|search }], completed? }` | `{ saved, user }` |
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
| `PATCH /me/profile` `{ name?, email?, password?, currentPassword?, readingLanguages? }` · `DELETE /me` `{ password }` | `{ user }` · 204 |

`Reason` — `{ kind: 'similar' | 'topic' | 'popular' | 'series', text, seedId? }`. Ошибки проверки (`validation_error`) — по-русски, в `details: [{ path, message }]`.

Онбординг идёт сессиями: `completed: true` (настоящее завершение) закрывает сессию и ставит `onboardingCompleted`; следующие ответы — новая сессия с раунда 1. Без `completed` («Пропустить») сессия остаётся открытой, возврат продолжает её раунды. Ответы прошлых сессий остаются в профиле. Подсказки `/search/suggest` после входа не показывают скрытые книги.

### Кабинет

- Списки: по умолчанию `limit=20`, сначала новые (`sort=date`; на полке «Прочитал» — по дате прочтения); `title` — по названию, `rating` — по моей оценке (без оценки — в конце). `addedAt` — когда книга попала на эту полку.
- `readAt` — дата прочтения: ставится при первом попадании на «Прочитал» (полкой или оценкой), при переезде между полками сохраняется. Задать вручную — `PUT /me/shelves/:id` `{ shelf: 'read', readAt: '2025-12-31' }` (день или дата со временем в ISO, не в будущем). `DELETE` полки удаляет и её.
- `taste`: `source` — `onboarding` (выбрано в онбординге) или `profile` (выведено из понравившегося либо возвращено после «Это не про меня»); `weight` — сколько понравившихся книг в теме. Выведенные подразделы и авторы с одной книгой не показываются. `description` — последнее «Опишите своими словами» из онбординга или `null`.
- `stats` — всё, кроме `readTotal`, за выбранный год (по умолчанию текущий). `tz` — часовой пояс пользователя (`Intl.DateTimeFormat().resolvedOptions().timeZone`, по умолчанию UTC): по нему книга попадает в месяц и год (по `readAt`). `years` — годы для переключателя (где есть прочитанное, оценки или цель, плюс текущий), по убыванию. `byMonth` — 12 месяцев `{ month: 1–12, count }`. `bySection` — до 10 разделов `{ section, label, count, averageRating }` по числу прочитанного; книги без раздела онбординга (служебные категории Amazon) — одной строкой `{ section: null, label: 'Другое' }` в конце. `ratings` — `{ count, average, distribution: { 1…5 } }` по оценкам за год. `goal` — `{ year, target, done }` или `null`.
- `DELETE /me` и смена email/пароля в `PATCH /me/profile` — только с паролем (`password` / `currentPassword`), иначе 403 `wrong_password`.
- `POST /me/events` — `view` (просмотр карточки), `rec_click` (клик по рекомендации, `payload: { kind, seedId?, place }`); запросы поиска сервер пишет сам.

## Поиск

`GET /search` по умолчанию гибридный ([src/routes/search.js](src/routes/search.js)):

- **обычный** — полнотекстовый + подстрока + ISBN/ASIN, подъём книг автора, при малом числе совпадений — похожие по написанию (`fuzzy: true`);
- **смысловой** — запрос → вектор от ML-сервиса (`ML_SERVICE_URL`, таймаут `ML_TIMEOUT_MS`) → 100 ближайших книг по HNSW с теми же фильтрами (`ef_search = 400`, итеративный обход; отдельный пул соединений, запрос дольше 2 с обрывается);
- оба выполняются параллельно и смешиваются по RRF (`RRF_K = 60`): книга получает Σ 1 / (60 + место) по двум спискам. **Точные совпадения всегда сверху**: название целиком или до «:» / «(», ISBN/ASIN, полное имя автора, а при опечатке — похожее имя автора и название с похожестью ≥ 0,7;
- `total` — совпадения обычного поиска плюс смысловые находки, которых среди них нет; страницы после смешанного списка продолжают обычный поиск;
- `mode` в ответе — каким поиском найдено на самом деле. ML-сервис не ответил или его модели нет в базе — `keyword`, без ошибки; после сбоя сервис 15 с не спрашиваем. `?mode=keyword|semantic` — только одна часть (для сравнения, эксперимент E5). `?semWeight=` — вес смысловой части в RRF: 0–5 или `auto` (от 4 слов — 2, короче — 1), по умолчанию 2 (замер ML, 3.5).

## Векторы книг

Таблицы `embedding_models` (модель, размерность, сколько книг) и `book_embeddings` (книга, модель, `vector`). Моделей может быть несколько сразу; у каждой свой HNSW-индекс по косинусному расстоянию (`embedding::vector(dim)` с условием `model = …`). Поиск берёт векторы той модели, которую называет ML-сервис; запросы — [src/lib/embeddings.js](src/lib/embeddings.js). Сейчас загружена `intfloat/multilingual-e5-base` (768).

```powershell
npm run load:embeddings -- [путь к parquet] [--model имя] [--work-mem 900MB] [--append]   # по умолчанию data/processed/book_embeddings.parquet; --append — дописать часть книг без пересборки
```

Файл: `book_id` (или `parent_asin`), `embedding` — список чисел; название модели — колонка `model`, метаданные parquet `model` или `--model`; размерность — по длине векторов. Запуск заменяет все векторы этой модели, книги вне каталога пропускаются. e5-base (405 тыс. × 768): загрузка ~100 с, индекс (m 24, ef_construction 200) ~24 мин (параллельно; нужен `shm_size` из docker-compose.yml — `--work-mem` не больше ~900MB при 1 ГБ).

Рекомендации и онбординг считаются в [src/services/recommender.js](src/services/recommender.js); с рекомендациями ML-сервиса (3.8) меняется только этот модуль.

- **Похожие книги** (`/books/:id/similar`, «Потому что вам понравилась», раунды 2+ онбординга) — соседи по вектору книги (`EMBEDDING_MODEL`), порядок — близость + небольшая добавка за популярность; одно издание на название, «франшиза» самой книги (тот же автор, книги о книге) — не больше 2, другие авторы — не больше 2. Нет вектора — тот же подраздел, затем раздел.
- **Популярное** (`/books?section=`, «Для вас», добор ленты, разведка онбординга) — одно издание на название и автора (обычное и *Illustrated Edition* — одна книга); `total` в `/books` — все издания.
- **Книги для малышей** (картонные или по возрасту читателя из карточки Amazon — до 8 лет, либо «от N лет» при N ≤ 3; `reading_age_min` / `reading_age_max` загружает `load:books` из `books_meta.parquet`) в ленте, «Потому что…» и онбординге — только если пользователь сам выбрал раздел Children's Books или ему понравилась такая книга. В самом разделе и в «Похожих» на странице книги — как есть.
- **Онбординг**: темы необязательны. Раунд 1 — до 4 узнаваемых книг (сначала с 200+ оценками, добор — с 50+), ближайших к описанию своими словами (через ML-сервис) по всему каталогу и внутри выбранных тем (темам — небольшое предпочтение), и похожие на любимые книги, добавленные поиском (`source: 'search'`); остальное — разведка по подразделам: выбранных тем, без них — разделов понравившихся книг или книг по описанию, без всего — 8 крупнейших разделов. Раунды 2+ — половина похожих на понравившиеся.
- **Другие книги серии** (`series`, первым рядом): понравились 2+ книги одного автора с общим началом названия («Harry Potter and the …») или серией в скобках («(Jack Reacher, Book 1)») — остальные книги серии: того же автора с названием серии; других авторов — если название начинается с серии и книга из того же раздела. Одно издание на книгу (то же русское название — тоже одна книга), без подарочных наборов, 20+ оценок, по году первого издания и номеру; эти книги не повторяются в других рядах. `name` — по-русски для читающих по-русски, если есть.

## Книги на языке читателя

Эксперимент 2.8: популярность в каталоге — американская, читающим по-русски поднимаем книги, известные по-русски (переводные), а не русских авторов.

- `readingLanguages` пользователя — `ru` / `kk` / `en`, несколько (онбординг или `PATCH /me/profile`, без пароля); `[]` — не выбрано.
- **Читает по-русски** — все, кроме отметивших `en`: и гость, и не выбравший язык (сайт русскоязычный). Для него книги с `ru_known` (русское название в Wikidata или автор-писатель с русским именем) мягко выше: в «Для вас» (+0,08 к взвешенному рейтингу), «Похожих» (+0,01 к близости), поиске (+0,003 в RRF, +0,2 к релевантности обычного поиска; точные совпадения по-прежнему сверху). «Популярное» (`/books?section=`, добор ленты, разведка онбординга) — сначала среди `ru_known`, за ними остальные. «Похожа на «…»» и название ряда серии — по-русски. С `en` — всё как раньше.
- Поиск и подсказки находят и по русскому названию (`title_ru`, триграммный индекс), точное русское название закрепляется сверху.

```powershell
npm run load:wikidata-ru -- [--offline] [--limit N]
npm run load:annotations-ru -- [путь к parquet]   # машинный перевод от ML: book_id, annotation_ru
```

**Русские описания** (только на странице книги): у книг с русским названием, чьё произведение в Wikidata связано со статьёй русской Википедии, — начало статьи (вступление без разметки, 1–2 абзаца до ~900 символов), `annotationSource: 'wikipedia'`, `annotationUrl` — статья (CC BY-SA: на карточке подпись «Описание: Википедия» со ссылкой). Машинный перевод — `load:annotations-ru`, `annotationSource: 'mt'`; описания из Википедии он не перетирает, а `load:wikidata-ru` не трогает перевод (после повторного `load:wikidata-ru` книги, потерявшие статью, остаются без описания — перевод загрузить заново).

Авторы книг с 20+ оценками и названия книг с 50+ оценками — в Wikidata (SPARQL, пачки по 80, пауза 1,5 с); ответы кэшируются в `data/processed/wikidata_ru.json`, повторный запуск спрашивает только новое, `--offline` — без сети. Ярлыки ищутся и на английском, и в `mul` (у многих известных людей английского ярлыка больше нет). Русское имя автора засчитывается в `ru_known`, только если он писатель по профессии (P106, список `TRANSLATED_OCCUPATIONS`) или у его книги есть русское название — «известный» ≠ «переводной». Пишет `authors_ru` (автор, русское имя, QID; у псевдонимов имя пустое) и `books.title_ru` / `author_ru` / `ru_known` — всё заново в одной транзакции. `load:books` эти колонки не трогает. Правила сопоставления — в начале [scripts/load-wikidata-ru.js](scripts/load-wikidata-ru.js).

## Свой каталог русских и казахских книг

Пилот 1.5: книги, которых нет в Amazon, — из Wikidata ([scripts/load-own-books.js](scripts/load-own-books.js)), `source: 'ru' | 'kz'`, `id` — `wd:` + QID, оценок нет (`rating: null`, `ratingsCount: 0`), вместо популярности — `fame` (число статей в Википедиях), `originalLanguage` — `ru` / `kk` (у книг Amazon — `null`).

- **Русские** — литературные произведения со статьёй в русской Википедии, язык оригинала русский (или автор пишет по-русски и другого языка оригинала нет), автор — писатель по профессии, не политик / лингвист, плюс стоп-список; 150 самых известных + 150 самых известных с 1917 года. **Казахские** — писатели (гражданство Казахстан / Казахская ССР, этнос казахи или пишет по-казахски) со статьёй в ru или kk Википедии и их произведения: черновик для автора — `data/processed/kz_draft.csv` (колонка «казахская литература» — да / под вопросом, в конце — отметка «убрать» и комментарий); в базу — произведения на казахском или этнических казахов со статьёй о них (до 60). У казахских `title` / `author` — оригинал, `titleRu` / `authorRu` — по-русски. Названия — без уточнений в скобках, имена — «Имя Фамилия», без ударений.
- **Дубли:** произведение уже есть в Amazon (по `wikidata_qid` из `load:wikidata-ru` или по английскому названию и началу фамилии автора) — новой записи нет, книгам Amazon дописываются русское название и описание из Википедии. Поэтому `load:own-books` — после `load:wikidata-ru` (тот сбрасывает русские поля книг Amazon).
- **Описание** — начало статьи Википедии (в `annotation` и `annotationRu`, `annotationSource: 'wikipedia'`), раздел — по жанру (P136; неизвестный — Literature & Fiction), обложка — Open Library по ISBN, если он есть.
- **Показ:** `GET /books?source=ru|kz` — по известности, после входа — по близости к вкусу (средний вектор понравившихся книг), когда у своих книг есть векторы; в `/recommendations` — ряды `local` (по вкусу → «По вашему вкусу», иначе сначала книги тем пользователя → «По вашим темам», остальное → «Известное»).
- **«Похожие»:** векторы e5 кучкуются по языку, поэтому соседи своей книги — отдельно в своём каталоге (точный перебор) и в Amazon (HNSW), через одного; книге Amazon читающему по-русски — 2 свои книги на 4-е и 8-е место (того же автора — вперёд).
- **Векторы** считает ML: `data/processed/own_books.parquet` (`book_id`, `source`, `text` — название, автор, жанр, описание); загрузка — `npm run load:embeddings -- файл.parquet --append` (без `--append` загрузка заменяет все векторы модели — векторы Amazon пропадут).

```powershell
npm run load:own-books -- [--offline]   # кэш ответов — data/processed/own_books_wd.json, после каждой пачки (упал — продолжит); пилот заменяется целиком
```

