const nf = new Intl.NumberFormat('ru-RU')
const pr = new Intl.PluralRules('ru-RU')

// forms: { one: 'оценка', few: 'оценки', many: 'оценок' }
export function plural(n, forms) {
  return forms[pr.select(n)] ?? forms.few
}

export function formatCount(n, forms) {
  return `${nf.format(n)} ${plural(n, forms)}`
}

export const RATINGS = { one: 'оценка', few: 'оценки', many: 'оценок' }

// Название без серии и подзаголовка «A Novel» — для подписей вида «Похожа на «…»».
// На карточках и странице книги название показывается как есть.
export function shortTitle(title) {
  return title
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/:\s*a novel$/i, '')
    .trim()
}

export const cn = (...classes) => classes.filter(Boolean).join(' ')
