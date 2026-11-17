import { formatFiatAmountForDisplay as formatSharedFiatAmountForDisplay } from '@alephium/shared/numbers'
import { describe, expect, it } from 'vitest'

import { addCommas, formatFiatAmountForDisplay } from './numbers'

describe('explorer number grouping', () => {
  it.each([
    ['0', '0'],
    ['999', '999'],
    ['1000', '1,000'],
    ['7219800', '7,219,800'],
    ['-1000', '-1,000'],
    ['+1000', '+1,000'],
    ['4085.1200', '4,085.1200'],
    ['0.00000123', '0.00000123'],
    ['123456789012345678901234567890', '123,456,789,012,345,678,901,234,567,890'],
    ['1.23e+21', '1.23e+21']
  ])('groups %s without changing its digits', (input, expected) => {
    expect(addCommas(input)).toBe(expected)
  })

  it.each(['', 'not a number'])('preserves validation for %j', (input) => {
    expect(() => addCommas(input)).toThrow('Invalid number')
  })

  it.each([
    [0, '0.00'],
    [999, '999.00'],
    [1000, '1,000.00'],
    [4085.12, '4,085.12'],
    [999999.99, '999,999.99'],
    [999999.999, '1.00M'],
    [1000000, '1.00M'],
    [1234567890, '1.23B'],
    [1000000000000, '1.00T'],
    [1000000000000000, '1e+15']
  ])('formats fiat %s with the existing precision and notation', (input, expected) => {
    expect(formatFiatAmountForDisplay(input)).toBe(expected)
    expect(formatFiatAmountForDisplay(input)).toBe(formatSharedFiatAmountForDisplay(input).replace(/'/g, ','))
  })

  it('leaves the shared fiat formatter unchanged', () => {
    expect(formatSharedFiatAmountForDisplay(4085.12)).toBe("4'085.12")
  })

  it('preserves rejection of negative fiat amounts', () => {
    expect(() => formatFiatAmountForDisplay(-1)).toThrow()
  })
})
