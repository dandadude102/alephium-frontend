import { fromHumanReadableAmount } from '@alephium/shared/numbers'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider } from 'styled-components'
import { describe, expect, it, vi } from 'vitest'

import { lightTheme } from '@/styles/themes'

import Amount from './Amount'

vi.mock('@/api/assets/assetsHooks', () => ({
  useAssetMetadata: (assetId: string) =>
    assetId === 'alph' ? { type: 'fungible', decimals: 18, symbol: 'ALPH' } : { type: undefined }
}))

vi.mock('./AssetLogo', () => ({ default: () => null }))

const renderAmount = (props: React.ComponentProps<typeof Amount>) => {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(
    <ThemeProvider theme={lightTheme}>
      <Amount {...props} />
    </ThemeProvider>
  )

  return container
}

describe('Amount number grouping', () => {
  it.each([false, true])('renders the reported ALPH balance with faded decimals: %s', (fadeDecimals) => {
    const container = renderAmount({
      assetId: 'alph',
      value: fromHumanReadableAmount('108033.9607'),
      fadeDecimals
    })

    expect(container.textContent).toBe('108,033.9607 ALPH')
    expect(container.querySelector('[data-tooltip-content]')?.getAttribute('data-tooltip-content')).toBe('108033.9607')
  })

  it.each([false, true])('uses the same grouping for fiat and its tooltip with faded decimals: %s', (fadeDecimals) => {
    const container = renderAmount({ value: 4085.12, isFiat: true, suffix: '$', fadeDecimals })

    expect(container.textContent).toBe('4,085.12 $')
    expect(container.querySelector('[data-tooltip-content]')?.getAttribute('data-tooltip-content')).toBe('4,085.12')
  })

  it.each([
    ['0', '0 ALPH'],
    ['999.99996', '1,000.00 ALPH'],
    ['1000000', '1.00M ALPH'],
    ['0.00000123', '0.0₅1 ALPH']
  ])('preserves ALPH rounding and notation for %s', (value, expected) => {
    expect(
      renderAmount({ assetId: 'alph', value: fromHumanReadableAmount(value), fadeDecimals: true }).textContent
    ).toBe(expected)
  })

  it.each([
    [0, '0.00 USD'],
    [999999.999, '1.00M USD'],
    [1000000000000000, '1e+15 USD']
  ])('preserves fiat rounding and notation for %s', (value, expected) => {
    expect(renderAmount({ value, isFiat: true, suffix: 'USD', fadeDecimals: true }).textContent).toBe(expected)
  })

  it('preserves full precision and suppresses the redundant tooltip', () => {
    const container = renderAmount({
      assetId: 'alph',
      value: fromHumanReadableAmount('108033.96071234'),
      fullPrecision: true
    })

    expect(container.textContent).toBe('108033.96071234 ALPH')
    expect(container.querySelector('[data-tooltip-content]')).toBeNull()
  })

  it('preserves small-amount subscript notation in the full-precision tooltip', () => {
    const container = renderAmount({ assetId: 'alph', value: fromHumanReadableAmount('0.00000123') })

    expect(container.textContent).toBe('0.0₅1 ALPH')
    expect(container.querySelector('[data-tooltip-content]')?.getAttribute('data-tooltip-content')).toBe('0.0₅123')
  })

  it.each([
    [1n, true, '+1,000.00 ALPH'],
    [-1n, true, '-1,000.00 ALPH'],
    [-1n, false, '1,000.00 ALPH']
  ])('preserves the sign behavior for %s and displaySign %s', (sign, displaySign, expected) => {
    const container = renderAmount({ assetId: 'alph', value: sign * fromHumanReadableAmount('1000'), displaySign })

    expect(container.textContent).toBe(expected)
    expect(container.querySelector('[data-tooltip-content]')?.getAttribute('data-tooltip-content')).toBe('1000.0000')
  })

  it('preserves the raw unknown-token amount and tooltip', () => {
    const container = renderAmount({ assetId: 'unknown', value: 123456789012345678901n })

    expect(container.textContent).toBe('123456789012345678901?')
    expect(container.querySelector('[data-tooltip-content]')?.getAttribute('data-tooltip-content')).toBe(
      '123456789012345678901'
    )
  })

  it('does not fabricate an amount or tooltip while the balance is missing', () => {
    const container = renderAmount({ assetId: 'alph' })

    expect(container.textContent).toBe(' ALPH')
    expect(container.querySelector('[data-tooltip-content]')).toBeNull()
  })
})
