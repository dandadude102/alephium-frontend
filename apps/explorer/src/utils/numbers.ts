import {
  addApostrophes,
  formatFiatAmountForDisplay as formatSharedFiatAmountForDisplay
} from '@alephium/shared/numbers'

// Match the en-US grouping used by ALPH amounts without changing the shared formatters' precision or notation.
export const addCommas = (number: string): string => addApostrophes(number).replace(/'/g, ',')

export const formatFiatAmountForDisplay = (amount: number): string =>
  formatSharedFiatAmountForDisplay(amount).replace(/'/g, ',')
