import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/** A slide-in side panel over a scrim — the design system's first overlay surface
 * (issue #43), hosting settings and the model manager. Scrim-click and Esc close
 * it, focus moves in on open and is trapped, and it renders nothing while closed
 * (so it stays out of the layout). Strings are passed in already localised, so the
 * primitive stays i18n-agnostic. */
export function Drawer({
  open,
  onClose,
  side = 'right',
  title,
  closeLabel,
  children,
}: {
  open: boolean
  onClose: () => void
  side?: 'left' | 'right'
  title: string
  closeLabel: string
  children: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  // Keep the latest onClose in a ref so the focus/keydown effect below does NOT
  // depend on it. onClose is typically an inline closure (a fresh reference every
  // parent render); listing it would re-run the effect on EVERY render, and its
  // `panel.focus()` would steal focus back from an open child — dismissing an open
  // native <select>. While a deck plays App re-renders ~10 Hz, so any open Settings
  // select closed at once. Focus must move in only when `open` flips true.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    panel?.focus()
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !panel) return
      // Trap Tab inside the panel so focus can't wander to the decks behind.
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
          ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  if (!open) return null

  return (
    <div className="ui-drawer" role="presentation">
      <div className="ui-drawer__scrim" onClick={onClose} />
      <div
        ref={panelRef}
        className={`ui-drawer__panel ui-drawer__panel--${side}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="ui-drawer__header">
          <span className="ui-drawer__title">{title}</span>
          <button className="ui-drawer__close" onClick={onClose} aria-label={closeLabel}>
            ×
          </button>
        </header>
        <div className="ui-drawer__body">{children}</div>
      </div>
    </div>
  )
}
