-- Дата прочтения отдельно от даты попадания на полку (решения.md 2.2, п. 5): переезд книги между полками
-- её не сбрасывает, её можно задать вручную. Для уже прочитанных — из updated_at
-- AlterTable
ALTER TABLE "shelves" ADD COLUMN     "read_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "shelves_user_id_read_at_idx" ON "shelves"("user_id", "read_at" DESC);


UPDATE "shelves" SET "read_at" = "updated_at" WHERE "shelf" = 'read';
