// Русские названия разделов каталога — общий словарь shared/sections_ru.json (им пользуется и бэкенд).
// Ключ — название из данных: по нему идут запросы к API, пользователю показываем перевод.
// Подразделы пока не переводим.
import SECTION_NAMES from '@shared/sections_ru.json'

export { SECTION_NAMES }

// Раздел, которого нет в словаре, показываем как есть
export const sectionLabel = (name) => SECTION_NAMES[name] ?? name
