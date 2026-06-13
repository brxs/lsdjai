import { useTranslation } from 'react-i18next'

/** SlipMate brand lockup: a slipmat-disc mark (concentric rings + a centre
 * spindle node) beside the SLIP·MATE wordmark with MATE in the accent.
 * The mark inks from currentColor so it follows the master-accent token,
 * and it's hand-built SVG so it stays crisp at any size and doubles as the
 * favicon. The h1 carries the accessible name; the visual text is hidden
 * from the a11y tree so it isn't read twice. */
export function Logo() {
  const { t } = useTranslation()
  return (
    <h1 className="logo" aria-label={t('app.title')}>
      <svg
        className="logo__mark"
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        <circle className="logo__ring" cx="12" cy="12" r="10.5" />
        <circle className="logo__ring" cx="12" cy="12" r="6" />
        <circle className="logo__node" cx="12" cy="12" r="2.5" />
      </svg>
      <span className="logo__text" aria-hidden="true">
        <span className="logo__word">
          <span className="logo__slip">{t('app.brand.slip')}</span>
          <span className="logo__mate">{t('app.brand.mate')}</span>
        </span>
        <span className="logo__tag">{t('app.tagline')}</span>
      </span>
    </h1>
  )
}
