import { useFetchAddressTransactionsCount } from '@alephium/shared-react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import AddressTransactionsCount from './AddressTransactionsCount'

vi.mock('@alephium/shared-react', () => ({ useFetchAddressTransactionsCount: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('@/pages/AddressInfoPage/InfoGrid', () => ({
  default: {
    Cell: ({ value }: { value?: React.ReactNode }) => <span>{value === undefined ? 'loading' : value}</span>
  }
}))

describe('AddressTransactionsCount', () => {
  it.each([
    { data: 7219800, isLoading: false, isError: false, expected: '7,219,800' },
    { data: 1000, isLoading: false, isError: false, expected: '1,000' },
    { data: 0, isLoading: false, isError: false, expected: '0' },
    { data: undefined, isLoading: false, isError: false, expected: '0' },
    { data: undefined, isLoading: true, isError: false, expected: 'loading' },
    { data: undefined, isLoading: false, isError: true, expected: '-' }
  ])('renders $expected for the query state', ({ data, isLoading, isError, expected }) => {
    vi.mocked(useFetchAddressTransactionsCount).mockReturnValue({
      data,
      isLoading,
      isError
    } as ReturnType<typeof useFetchAddressTransactionsCount>)

    expect(renderToStaticMarkup(<AddressTransactionsCount addressStr="address" />)).toBe(`<span>${expected}</span>`)
    expect(useFetchAddressTransactionsCount).toHaveBeenLastCalledWith('address')
  })
})
