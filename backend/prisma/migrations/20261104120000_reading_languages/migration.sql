-- Книги на языке читателя (решения.md 2.8, 4.8): русские имена авторов и названия из Wikidata
-- (scripts/load-wikidata-ru.js), признак «известна по-русски» и языки чтения пользователя
-- AlterTable
ALTER TABLE "books" ADD COLUMN     "title_ru" TEXT,
ADD COLUMN     "author_ru" TEXT,
ADD COLUMN     "ru_known" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "reading_languages" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "authors_ru" (
    "author" TEXT NOT NULL,
    "name_ru" TEXT,
    "qid" VARCHAR(16) NOT NULL,

    CONSTRAINT "authors_ru_pkey" PRIMARY KEY ("author")
);

-- CreateIndex
CREATE INDEX "books_section_ru_known_ratings_count_idx" ON "books"("section", "ru_known" DESC, "ratings_count" DESC);

-- CreateIndex
CREATE INDEX "books_section_ru_known_weighted_rating_idx" ON "books"("section", "ru_known" DESC, "weighted_rating" DESC);

-- CreateIndex
CREATE INDEX "books_ru_known_ratings_count_idx" ON "books"("ru_known" DESC, "ratings_count" DESC);

-- CreateIndex
CREATE INDEX "books_title_ru_trgm_idx" ON "books" USING GIN ("title_ru" gin_trgm_ops);
