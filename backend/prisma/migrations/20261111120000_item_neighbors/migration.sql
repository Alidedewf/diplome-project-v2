-- Соседи книг по ItemKNN (решения.md 3.8, 4.11): топ-20 на книгу из models/serve/<сборка>/item_neighbors.parquet,
-- загрузка — scripts/load-item-neighbors.js. rank — место соседа (1 — ближайший), score — сходство ItemKNN.
-- Без внешних ключей: таблица перезаливается целиком при новой сборке, а соседи книг, которых нет в каталоге,
-- отсекаются соединением с books при чтении
-- CreateTable
CREATE TABLE "item_neighbors" (
    "book_id" VARCHAR(16) NOT NULL,
    "rank" SMALLINT NOT NULL,
    "neighbor_id" VARCHAR(16) NOT NULL,
    "score" REAL NOT NULL,

    CONSTRAINT "item_neighbors_pkey" PRIMARY KEY ("book_id","rank")
);
