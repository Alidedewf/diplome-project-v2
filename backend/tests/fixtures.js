// Маленький каталог для тестов: 2 раздела × 2 подраздела × 5 книг, разные авторы
const SECTIONS = {
  'Science Fiction & Fantasy': ['Science Fiction', 'Fantasy'],
  'Mystery, Thriller & Suspense': ['Thrillers & Suspense', 'Mystery'],
}

// Поиск по автору (SRCH-02): романы автора и книги с его именем в названии; мало оценок — не мешают лентам
const AUTHOR = { section: 'Literature & Fiction', subsection: 'Literary Fiction', year: 2015, rating: 4.2, weightedRating: 4.1 }
export const AUTHOR_BOOKS = [
  { id: 'Q000000001', title: 'Silent River', author: 'Mara Quill', ratingsCount: 300 },
  { id: 'Q000000002', title: 'Glass Orchard', author: 'Mara Quill', ratingsCount: 200 },
  { id: 'Q000000003', title: 'The Mara Quill Collection', author: 'Mara Quill', ratingsCount: 20 },
  { id: 'Q000000004', title: "Mara Quill: A Reader's Companion", author: 'Other Critic', ratingsCount: 150 },
].map((b) => ({ ...AUTHOR, ...b }))

const CATALOG = Object.entries(SECTIONS).flatMap(([section, subsections], si) =>
  subsections.flatMap((subsection, ui) =>
    Array.from({ length: 5 }, (_, i) => {
      const n = si * 10 + ui * 5 + i
      return {
        id: `T${String(n).padStart(9, '0')}`,
        title: `${subsection} Book ${i + 1}`,
        author: `Author ${n}`,
        year: 2010 + i,
        section,
        subsection,
        rating: 4 + i / 10,
        ratingsCount: 1000 - n * 10,
        weightedRating: 4 + (n % 7) / 10,
      }
    }),
  ),
)

export const BOOKS = [...CATALOG, ...AUTHOR_BOOKS]
