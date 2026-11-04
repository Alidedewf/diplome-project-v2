// Русские названия разделов и подразделов каталога — словари shared/sections_ru.json (им пользуется и бэкенд)
// и shared/subsections_ru.json (лежит в shared, чтобы бэкенд мог взять его так же). Ключ — название из данных:
// по нему идут запросы к API, пользователю показываем перевод.
import SECTION_NAMES from '@shared/sections_ru.json'
import SUBSECTION_NAMES from '@shared/subsections_ru.json'

export { SECTION_NAMES, SUBSECTION_NAMES }

// Раздел, которого нет в словаре, показываем как есть
export const sectionLabel = (name) => SECTION_NAMES[name] ?? name

// Подраздел: сначала уточнение для пары «раздел › подраздел» (Romance › Fantasy — «Любовное фэнтези»),
// потом общий перевод, иначе как есть. section — раздел книги из API (section, у служебных — раздел Amazon)
export const subsectionLabel = (name, section) =>
  (section && SUBSECTION_NAMES[`${section} › ${name}`]) || SUBSECTION_NAMES[name] || name
