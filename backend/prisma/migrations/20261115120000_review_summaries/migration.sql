-- Сводка отзывов на карточке книги (решения.md 2.6.1, 3.6, 4.13): файл ML data/processed/review_summary_site.parquet,
-- загрузка — scripts/load-review-summary.js (заменяет обе таблицы целиком).
-- review_summaries — книга и сколько отзывов проанализировано; review_summary_items — показанные пункты сводки
-- («в целом», аспекты, справка) в порядке rank. Значения kind / verdict проверяются здесь: файл с чужими значениями
-- не загрузится, а не попадёт на сайт
-- CreateTable
CREATE TABLE "review_summaries" (
    "book_id" VARCHAR(16) NOT NULL,
    "analyzed" INTEGER NOT NULL,

    CONSTRAINT "review_summaries_pkey" PRIMARY KEY ("book_id")
);

-- CreateTable
CREATE TABLE "review_summary_items" (
    "book_id" VARCHAR(16) NOT NULL,
    "rank" SMALLINT NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "aspect" VARCHAR(32) NOT NULL,
    "label_ru" TEXT NOT NULL,
    "verdict" VARCHAR(10),
    "share_pos" REAL,
    "mentions" INTEGER NOT NULL,
    "mention_share" REAL,
    "quote_pos" TEXT,
    "quote_neg" TEXT,

    CONSTRAINT "review_summary_items_pkey" PRIMARY KEY ("book_id","rank"),
    CONSTRAINT "review_summary_items_kind_check" CHECK ("kind" IN ('overall', 'aspect', 'info')),
    CONSTRAINT "review_summary_items_verdict_check" CHECK (
        CASE "kind" WHEN 'info' THEN "verdict" IS NULL ELSE coalesce("verdict" IN ('praise', 'mixed', 'criticize'), false) END)
);

-- AddForeignKey
ALTER TABLE "review_summaries" ADD CONSTRAINT "review_summaries_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_summary_items" ADD CONSTRAINT "review_summary_items_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "review_summaries"("book_id") ON DELETE CASCADE ON UPDATE CASCADE;
