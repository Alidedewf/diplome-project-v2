-- Русское описание книги (решения.md 2.8, 4.8): начало статьи русской Википедии (source 'wikipedia', url — статья,
-- лицензия CC BY-SA) или машинный перевод аннотации (source 'mt', файл ML)
-- AlterTable
ALTER TABLE "books" ADD COLUMN     "annotation_ru" TEXT,
ADD COLUMN     "annotation_source" VARCHAR(16),
ADD COLUMN     "annotation_url" TEXT;
