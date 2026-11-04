-- Возраст читателя из карточки Amazon («Reading age»: «2 - 5 years», «18 years and up») — books_meta.parquet,
-- scripts/load-books.js. По нему книги для малышей не попадают в ленту взрослых (решения.md 4.8)
-- AlterTable
ALTER TABLE "books" ADD COLUMN     "reading_age_min" SMALLINT,
ADD COLUMN     "reading_age_max" SMALLINT;
