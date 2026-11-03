-- Векторы книг для поиска по смыслу и похожих книг (решения.md 3.5, 3.8).
-- Колонка vector без размерности: в одной таблице могут лежать модели 384 и 768 (сравнение кандидатов).
-- HNSW-индекс по косинусному расстоянию создаёт scripts/load-embeddings.js — отдельно для каждой модели:
--   CREATE INDEX … USING hnsw ((embedding::vector(dim)) vector_cosine_ops) WHERE model = '…'

-- CreateTable
CREATE TABLE "embedding_models" (
    "name" VARCHAR(100) NOT NULL,
    "dim" SMALLINT NOT NULL,
    "books" INTEGER NOT NULL DEFAULT 0,
    "loaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embedding_models_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "book_embeddings" (
    "book_id" VARCHAR(16) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "embedding" vector NOT NULL,

    CONSTRAINT "book_embeddings_pkey" PRIMARY KEY ("model","book_id")
);

-- CreateIndex
CREATE INDEX "book_embeddings_book_id_idx" ON "book_embeddings"("book_id");

-- AddForeignKey
ALTER TABLE "book_embeddings" ADD CONSTRAINT "book_embeddings_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_embeddings" ADD CONSTRAINT "book_embeddings_model_fkey" FOREIGN KEY ("model") REFERENCES "embedding_models"("name") ON DELETE CASCADE ON UPDATE CASCADE;


-- HNSW в pgvector индексирует vector до 2000 измерений
ALTER TABLE "embedding_models" ADD CONSTRAINT "embedding_models_dim_check" CHECK ("dim" BETWEEN 1 AND 2000);
