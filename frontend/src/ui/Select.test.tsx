import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Select } from './Select'

// Stable references shared across the harness's re-renders — the call-site
// discipline the memo relies on (see the load-bearing-memo note in Select.tsx).
const OPTIONS = ['mrt2_small', 'mrt2_base']
const noop = () => {}

describe('Select', () => {
  it('is memoised — the load-bearing guard for the WKWebView <select> dismiss', () => {
    // A controlled native <select> re-asserts its selected <option> on any parent
    // re-render, and WKWebView dismisses an OPEN popup on that re-sync. memo lets a
    // value-stable parent re-render (App's ~10 Hz stats churn, a store event) skip
    // the commit entirely. If this regresses, the Settings selects close on open.
    expect((Select as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    )
  })

  it('does NOT re-sync the native value on a same-props parent re-render', () => {
    // The dismiss mechanism is the value re-assert. Stand in for an open menu by
    // nudging the DOM value, then force a parent re-render with the SAME props: the
    // memo must skip the commit so React's updateOptions never re-asserts value.
    function Parent() {
      const [, force] = useState(0)
      return (
        <>
          <button onClick={() => force((n) => n + 1)}>force</button>
          <Select label="Model" value="mrt2_small" options={OPTIONS} onChange={noop} />
        </>
      )
    }
    render(<Parent />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    select.value = 'mrt2_base'

    act(() => {
      fireEvent.click(screen.getByText('force'))
    })
    // Not re-synced back to the value prop → the memo skipped the commit, so an
    // open native menu would stay open.
    expect(select.value).toBe('mrt2_base')
  })

  it('still re-renders when its own value prop changes', () => {
    // The memo must not block legitimate updates — a value change still commits.
    function Parent() {
      const [value, setValue] = useState('mrt2_small')
      return (
        <>
          <button onClick={() => setValue('mrt2_base')}>change</button>
          <Select label="Model" value={value} options={OPTIONS} onChange={noop} />
        </>
      )
    }
    render(<Parent />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('mrt2_small')

    act(() => {
      fireEvent.click(screen.getByText('change'))
    })
    expect(select.value).toBe('mrt2_base')
  })
})
