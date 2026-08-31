import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

// Renders children into a node appended to <body>.
//
// Floating panels are position:fixed with a high z-index, but that only wins inside the
// nearest ancestor STACKING CONTEXT — any ancestor with a transform, filter or z-index
// of its own traps them and they paint behind the chrome. (The real app hits exactly
// this: App.tsx wraps everything in a zoom `transform: scale`, which makes it the
// containing block for every fixed descendant.) Living directly under <body> puts them
// in the root stacking context, so "on top of everything" actually holds.
export default function Portal({ children }) {
  const [el] = useState(() => (typeof document === 'undefined' ? null : document.createElement('div')))
  useEffect(() => {
    if (!el) return undefined
    el.className = 'sdash-portal'
    document.body.appendChild(el)
    return () => { if (el.parentNode) el.parentNode.removeChild(el) }
  }, [el])
  if (!el) return null
  return createPortal(children, el)
}
