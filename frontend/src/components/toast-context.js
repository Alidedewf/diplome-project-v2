import { createContext, useContext } from 'react'

export const ToastContext = createContext(() => {})

// show(message) — короткое сообщение внизу экрана
export const useToast = () => useContext(ToastContext)
