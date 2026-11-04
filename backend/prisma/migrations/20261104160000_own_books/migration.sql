-- Свой каталог русских и казахских книг (решения.md 1.5, 4.10): источник книги, известность и QID Wikidata
-- (у книг Amazon — произведение, сопоставленное в load-wikidata-ru.js; у своих — само произведение, id = 'wd:' || qid)
-- AlterTable
ALTER TABLE "books" ADD COLUMN     "source" VARCHAR(8) NOT NULL DEFAULT 'amazon',
ADD COLUMN     "fame" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "wikidata_qid" VARCHAR(16);

-- CreateIndex
CREATE INDEX "books_source_fame_idx" ON "books"("source", "fame" DESC);

-- CreateIndex
CREATE INDEX "books_wikidata_qid_idx" ON "books"("wikidata_qid");
