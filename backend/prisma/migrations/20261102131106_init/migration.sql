-- Расширения: pg_trgm — поиск по подстроке и с опечатками; vector — эмбеддинги (book_embeddings, позже)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "shelf_kind" AS ENUM ('want', 'reading', 'read');

-- CreateEnum
CREATE TYPE "topic_kind" AS ENUM ('section', 'subsection', 'author');

-- CreateEnum
CREATE TYPE "topic_source" AS ENUM ('onboarding', 'profile');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "onboarding_completed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "books" (
    "id" VARCHAR(16) NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "year" SMALLINT,
    "section" TEXT,
    "category" TEXT,
    "subsection" TEXT,
    "format" TEXT,
    "language" TEXT,
    "isbn13" VARCHAR(13),
    "cover" TEXT,
    "annotation" TEXT NOT NULL DEFAULT '',
    "rating" REAL,
    "ratings_count" INTEGER NOT NULL DEFAULT 0,
    "amazon_ratings_count" INTEGER NOT NULL DEFAULT 0,
    "editions_count" SMALLINT NOT NULL DEFAULT 1,
    "weighted_rating" REAL NOT NULL DEFAULT 0,
    -- Название (со стеммингом) важнее автора; Prisma видит колонку как Unsupported("tsvector")
    "search_vector" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', "title"), 'A') ||
        setweight(to_tsvector('simple', coalesce("author", '')), 'B')
    ) STORED,

    CONSTRAINT "books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ratings" (
    "user_id" INTEGER NOT NULL,
    "book_id" VARCHAR(16) NOT NULL,
    "value" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("user_id","book_id")
);

-- CreateTable
CREATE TABLE "shelves" (
    "user_id" INTEGER NOT NULL,
    "book_id" VARCHAR(16) NOT NULL,
    "shelf" "shelf_kind" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shelves_pkey" PRIMARY KEY ("user_id","book_id")
);

-- CreateTable
CREATE TABLE "hidden_books" (
    "user_id" INTEGER NOT NULL,
    "book_id" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hidden_books_pkey" PRIMARY KEY ("user_id","book_id")
);

-- CreateTable
CREATE TABLE "user_topics" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "kind" "topic_kind" NOT NULL,
    "value" TEXT NOT NULL,
    "source" "topic_source" NOT NULL,
    "rejected" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" BIGSERIAL NOT NULL,
    "user_id" INTEGER,
    "type" VARCHAR(32) NOT NULL,
    "book_id" VARCHAR(16),
    "query" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reading_goals" (
    "user_id" INTEGER NOT NULL,
    "year" SMALLINT NOT NULL,
    "target" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reading_goals_pkey" PRIMARY KEY ("user_id","year")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "books_section_ratings_count_idx" ON "books"("section", "ratings_count" DESC);

-- CreateIndex
CREATE INDEX "books_section_weighted_rating_idx" ON "books"("section", "weighted_rating" DESC);

-- CreateIndex
CREATE INDEX "books_subsection_weighted_rating_idx" ON "books"("subsection", "weighted_rating" DESC);

-- CreateIndex
CREATE INDEX "books_ratings_count_idx" ON "books"("ratings_count" DESC);

-- CreateIndex
CREATE INDEX "books_weighted_rating_idx" ON "books"("weighted_rating" DESC);

-- CreateIndex
CREATE INDEX "books_isbn13_idx" ON "books"("isbn13");

-- CreateIndex
CREATE INDEX "books_search_vector_idx" ON "books" USING GIN ("search_vector");

-- CreateIndex
CREATE INDEX "books_title_trgm_idx" ON "books" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "books_author_trgm_idx" ON "books" USING GIN ("author" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ratings_user_id_updated_at_idx" ON "ratings"("user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ratings_book_id_idx" ON "ratings"("book_id");

-- CreateIndex
CREATE INDEX "shelves_user_id_shelf_updated_at_idx" ON "shelves"("user_id", "shelf", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "shelves_book_id_idx" ON "shelves"("book_id");

-- CreateIndex
CREATE INDEX "hidden_books_user_id_created_at_idx" ON "hidden_books"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "hidden_books_book_id_idx" ON "hidden_books"("book_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_topics_user_id_kind_value_key" ON "user_topics"("user_id", "kind", "value");

-- CreateIndex
CREATE INDEX "events_user_id_type_created_at_idx" ON "events"("user_id", "type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "events_type_created_at_idx" ON "events"("type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "events_book_id_idx" ON "events"("book_id");

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelves" ADD CONSTRAINT "shelves_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelves" ADD CONSTRAINT "shelves_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hidden_books" ADD CONSTRAINT "hidden_books_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hidden_books" ADD CONSTRAINT "hidden_books_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_topics" ADD CONSTRAINT "user_topics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reading_goals" ADD CONSTRAINT "reading_goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Проверки, которые Prisma не описывает в схеме
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_value_check" CHECK ("value" BETWEEN 1 AND 5);
ALTER TABLE "reading_goals" ADD CONSTRAINT "reading_goals_target_check" CHECK ("target" > 0);
