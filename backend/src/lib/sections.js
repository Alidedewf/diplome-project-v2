// Русские названия разделов каталога — общий словарь с фронтендом (shared/sections_ru.json, решения.md 5.3).
// Ключ — название из данных.
import SECTION_NAMES from '../../../shared/sections_ru.json' with { type: 'json' }

export { SECTION_NAMES }

// Раздел, которого нет в словаре, показываем как есть
export const sectionLabel = (name) => SECTION_NAMES[name] ?? name
