import { useEffect, useRef } from 'react'

// Прокручиваемая строка (меню кабинета, вкладки полок): на телефоне активный пункт может оказаться
// за краем — при смене key прокручиваем к нему
export function useScrollToActive(key, selector) {
  const ref = useRef(null)
  useEffect(() => {
    const row = ref.current
    const active = row?.querySelector(selector)
    if (!active || row.scrollWidth <= row.clientWidth) return
    row.scrollLeft += active.getBoundingClientRect().left - row.getBoundingClientRect().left - 16
  }, [key, selector])
  return ref
}
