// Маленький каталог для тестов: 2 раздела × 2 подраздела × 5 книг, разные авторы
const SECTIONS = {
  'Science Fiction & Fantasy': ['Science Fiction', 'Fantasy'],
  'Mystery, Thriller & Suspense': ['Thrillers & Suspense', 'Mystery'],
}

export const BOOKS = Object.entries(SECTIONS).flatMap(([section, subsections], si) =>
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
