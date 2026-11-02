// Русские названия разделов каталога (верхний уровень дерева категорий Amazon).
// Ключ — название из данных: по нему идут запросы к API, пользователю показываем перевод.
// Подразделы пока не переводим.
export const SECTION_NAMES = {
  'Literature & Fiction': 'Художественная литература',
  "Children's Books": 'Детские книги',
  'Mystery, Thriller & Suspense': 'Детективы и триллеры',
  'Crafts, Hobbies & Home': 'Хобби, рукоделие и дом',
  'Arts & Photography': 'Искусство и фотография',
  'Christian Books & Bibles': 'Христианская литература',
  'Teen & Young Adult': 'Подростковая литература',
  'Biographies & Memoirs': 'Биографии и мемуары',
  History: 'История',
  'Cookbooks, Food & Wine': 'Кулинария',
  'Science Fiction & Fantasy': 'Фантастика и фэнтези',
  Romance: 'Любовные романы',
  'Comics & Graphic Novels': 'Комиксы и графические романы',
  'Politics & Social Sciences': 'Политика и общество',
  'Business & Money': 'Бизнес и финансы',
  'Humor & Entertainment': 'Юмор и развлечения',
  'Science & Math': 'Наука и математика',
  Reference: 'Справочники',
  'Computers & Technology': 'Компьютеры и технологии',
  Travel: 'Путешествия',
  'Health, Fitness & Dieting': 'Здоровье и фитнес',
  'Engineering & Transportation': 'Техника и транспорт',
  'Religion & Spirituality': 'Религия и духовность',
  'Sports & Outdoors': 'Спорт и активный отдых',
  'Education & Teaching': 'Образование и педагогика',
  'Self-Help': 'Саморазвитие',
  'Medical Books': 'Медицина',
  'LGBTQ+ Books': 'ЛГБТК+ литература',
  'Parenting & Relationships': 'Семья и отношения',
  Law: 'Право',
  'Test Preparation': 'Подготовка к экзаменам',
}

// Раздел, которого нет в словаре, показываем как есть
export const sectionLabel = (name) => SECTION_NAMES[name] ?? name
