// @vitest-environment happy-dom

import { throttledClient } from '@alephium/shared/api'
import { ExplorerProvider, NodeProvider } from '@alephium/web3'
import { focusManager, onlineManager, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addressAlphBalancesQuery,
  addressBalancesQuery,
  addressTokensBalancesQuery
} from '../src/api/queries/addressQueries'
import { queryClient } from '../src/api/queryClient'
import { startLockedBalancesRefresh } from '../src/features/dataPolling/lockedBalancesRefresh'
import { useAddressesDataPolling } from '../src/features/dataPolling/useAddressesDataPolling'

const context = vi.hoisted(() => ({ addresses: ['address-a'], networkId: 4, online: true }))
vi.mock('../src/hooks/addresses/useUnsortedAddresses', () => ({
  useUnsortedAddressesHashes: () => context.addresses
}))
vi.mock('../src/network/networkHooks', () => ({
  useNetworkId: () => context.networkId,
  useIsExplorerOnline: () => context.online,
  useIsNodeOnline: () => context.online
}))
vi.mock('../src/api/queries/transactionQueries', () => ({
  addressLatestTransactionQuery: ({ addressHash, networkId }: { addressHash: string; networkId: number }) => ({
    queryKey: ['address', addressHash, 'transaction', 'latest', { networkId }],
    queryFn: async () => ({ addressHash, latestTx: { hash: 'unchanged', timestamp: 1 } }),
    staleTime: Infinity
  })
}))

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)
const options = (networkId = context.networkId) => ({ addressHash: 'address-a', networkId, isNodeOnline: true })
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

let lockedUntil: number
let unsubscribers: Array<() => void>
let balances: ReturnType<typeof vi.fn>
let tokens: ReturnType<typeof vi.fn>
let utxos: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100000)
  context.addresses = ['address-a']
  context.networkId = 4
  context.online = true
  focusManager.setFocused(true)
  onlineManager.setOnline(true)
  queryClient.clear()
  unsubscribers = []
  lockedUntil = Date.now() + 10000
  balances = vi.fn(async () => ({ balance: '100', lockedBalance: Date.now() <= lockedUntil ? '100' : '0' }))
  tokens = vi.fn(async () => [
    { tokenId: 'token-a', balance: '5', lockedBalance: Date.now() <= lockedUntil ? '5' : '0' }
  ])
  utxos = vi.fn(async () => ({ utxos: [{ lockTime: lockedUntil }] }))
  vi.spyOn(throttledClient, 'node', 'get').mockReturnValue({
    addresses: { getAddressesAddressUtxos: utxos }
  } as unknown as NodeProvider)
  vi.spyOn(throttledClient, 'explorer', 'get').mockReturnValue({
    addresses: { getAddressesAddressBalance: balances, getAddressesAddressTokensBalance: tokens }
  } as unknown as ExplorerProvider)
})
afterEach(() => {
  cleanup()
  unsubscribers.forEach((unsubscribe) => unsubscribe())
  queryClient.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const observeBalances = async () => {
  const alph = new QueryObserver(queryClient, addressAlphBalancesQuery(options()))
  const token = new QueryObserver(queryClient, addressTokensBalancesQuery(options()))
  unsubscribers.push(
    alph.subscribe(() => {}),
    token.subscribe(() => {})
  )
  await flush()
  return { alph, token }
}

describe('time-locked balance freshness', () => {
  it('refreshes ALPH and tokens after expiry even though the latest transaction hash never changes', async () => {
    const { alph, token } = await observeBalances()
    renderHook(useAddressesDataPolling, { wrapper })
    await flush()
    await flush(10001)
    expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('0')
    expect(token.getCurrentResult().data?.balances[0].lockedBalance).toBe('0')
  })

  it('also refreshes token-only locks', async () => {
    balances.mockResolvedValue({ balance: '100', lockedBalance: '0' })
    const { token } = await observeBalances()
    renderHook(useAddressesDataPolling, { wrapper })
    await flush()
    await flush(10001)
    expect(token.getCurrentResult().data?.balances[0].lockedBalance).toBe('0')
  })
})

it('does not request UTXOs for unlocked balances or poll before a known future deadline', async () => {
  const { alph } = await observeBalances()
  const hook = renderHook(useAddressesDataPolling, { wrapper })
  await flush()
  expect(utxos).toHaveBeenCalledTimes(1)
  expect(utxos.mock.calls[0][1]).toEqual({ 'error-if-exceed-max-utxos': true })
  await flush(9999)
  expect(utxos).toHaveBeenCalledTimes(1)
  expect(balances).toHaveBeenCalledTimes(1)
  await flush(2)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('0')
  const calls = utxos.mock.calls.length
  await flush(120000)
  expect(utxos).toHaveBeenCalledTimes(calls)
  hook.unmount()
  utxos.mockClear()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush(120000)
  expect(utxos).not.toHaveBeenCalled()
})

it('waits past the strict boundary and retries a lagging backend without changing amounts locally', async () => {
  balances.mockImplementation(async () => ({
    balance: '100',
    lockedBalance: Date.now() < lockedUntil + 4000 ? '100' : '0'
  }))
  const { alph } = await observeBalances()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush(10000)
  expect(balances).toHaveBeenCalledTimes(1)
  await flush(1)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('100')
  expect(balances).toHaveBeenCalledTimes(2)
  await flush(60000)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('0')
  expect(balances).toHaveBeenCalledTimes(3)
})

it('schedules each of multiple lock boundaries, not only the first', async () => {
  const secondLock = lockedUntil + 20000
  balances.mockImplementation(async () => ({
    balance: '100',
    lockedBalance: Date.now() <= lockedUntil ? '100' : Date.now() <= secondLock ? '50' : '0'
  }))
  utxos.mockResolvedValue({ utxos: [{ lockTime: secondLock }, { lockTime: lockedUntil }] })
  const { alph } = await observeBalances()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush(10001)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('50')
  const calls = balances.mock.calls.length
  await flush(19999)
  expect(balances).toHaveBeenCalledTimes(calls)
  await flush(1)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('0')
})

it('recovers cached expired locks and UTXO errors with bounded backoff', async () => {
  await observeBalances()
  lockedUntil = Date.now() - 1
  utxos.mockRejectedValueOnce(new Error('UTXO limit exceeded'))
  const { result } = renderHook(() => useAddressesDataPolling(), { wrapper })
  await flush()
  expect(result.current).toBeUndefined()
  expect(balances).toHaveBeenCalledTimes(1)
  await flush(5000)
  expect(queryClient.getQueryData(addressAlphBalancesQuery(options()).queryKey)?.balances.lockedBalance).toBe('0')
})

it('refreshes a stale expired cached balance without requiring an active observer', async () => {
  await queryClient.fetchQuery(addressAlphBalancesQuery(options()))
  lockedUntil = Date.now() - 1
  renderHook(useAddressesDataPolling, { wrapper })
  await flush(60000)
  expect(queryClient.getQueryData(addressAlphBalancesQuery(options()).queryKey)?.balances.lockedBalance).toBe('0')
})

it('caps long locks at the safety-refresh interval without overflowing the timer', async () => {
  lockedUntil = Date.now() + 2 ** 31 + 10000
  await observeBalances()
  unsubscribers.push(
    startLockedBalancesRefresh({
      addressHashes: context.addresses,
      networkId: context.networkId,
      getUtxos: (address, signal) =>
        throttledClient.node.addresses.getAddressesAddressUtxos(
          address,
          { 'error-if-exceed-max-utxos': true },
          { signal }
        ),
      isCurrentNetwork: () => true
    })
  )
  await flush(59999)
  expect(balances).toHaveBeenCalledTimes(1)
  expect(utxos).toHaveBeenCalledTimes(1)
  await flush(1)
  expect(balances).toHaveBeenCalledTimes(2)
  expect(utxos).toHaveBeenCalledTimes(2)
  expect(queryClient.getQueryData(addressAlphBalancesQuery(options()).queryKey)?.balances.lockedBalance).toBe('100')
})

it.each(['background', 'offline'])('pauses in %s and refreshes immediately on resume', async (mode) => {
  const { alph } = await observeBalances()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush()
  act(() => (mode === 'background' ? focusManager.setFocused(false) : onlineManager.setOnline(false)))
  await flush(20000)
  expect(balances).toHaveBeenCalledTimes(1)
  act(() => (mode === 'background' ? focusManager.setFocused(true) : onlineManager.setOnline(true)))
  await flush()
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('0')
})

it.each(['unmount', 'remove', 'network'])('ignores a late UTXO result after %s', async (mode) => {
  let resolve!: (value: { utxos: Array<{ lockTime: number }> }) => void
  utxos.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await observeBalances()
  const hook = renderHook(useAddressesDataPolling, { wrapper })
  await flush()
  const signal = utxos.mock.calls[0][2].signal as AbortSignal
  if (mode === 'unmount') hook.unmount()
  else {
    if (mode === 'remove') context.addresses = []
    else context.networkId = 0
    hook.rerender()
  }
  expect(signal.aborted).toBe(true)
  resolve({ utxos: [{ lockTime: lockedUntil }] })
  await flush(20000)
  expect(balances).toHaveBeenCalledTimes(1)
})

it('invalidates only the current network and leaves transaction-list pages untouched', async () => {
  await queryClient.fetchQuery(addressAlphBalancesQuery(options(0)))
  const otherNetwork = new QueryObserver(queryClient, addressAlphBalancesQuery(options(0)))
  unsubscribers.push(otherNetwork.subscribe(() => {}))
  await observeBalances()
  const pageKey = ['address', 'address-a', 'transactions', 'page', { networkId: 4, page: 1 }]
  queryClient.setQueryData(pageKey, ['saved-page'])
  renderHook(useAddressesDataPolling, { wrapper })
  await flush(10001)
  expect(queryClient.getQueryData(addressAlphBalancesQuery(options(4)).queryKey)?.balances.lockedBalance).toBe('0')
  expect(otherNetwork.getCurrentResult().data?.balances.lockedBalance).toBe('100')
  expect(queryClient.getQueryState(pageKey)?.isInvalidated).toBe(false)
})

it('refreshes composed consumers once and discards an in-flight pre-expiry response', async () => {
  const composed = new QueryObserver(queryClient, addressBalancesQuery(options()))
  unsubscribers.push(composed.subscribe(() => {}))
  await flush()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush()
  let resolve!: (value: { balance: string; lockedBalance: string }) => void
  balances.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  void queryClient.refetchQueries({ queryKey: addressAlphBalancesQuery(options()).queryKey })
  await flush(10001)
  expect(composed.getCurrentResult().data?.balances.every(({ lockedBalance }) => lockedBalance === '0')).toBe(true)
  expect(balances).toHaveBeenCalledTimes(3)
  expect(tokens).toHaveBeenCalledTimes(2)
  resolve({ balance: '100', lockedBalance: '100' })
  await flush()
  expect(composed.getCurrentResult().data?.balances.every(({ lockedBalance }) => lockedBalance === '0')).toBe(true)
  expect(queryClient.getQueryData(addressAlphBalancesQuery(options()).queryKey)?.balances.lockedBalance).toBe('0')
})

it('cancels an in-flight expiry refresh on removal and does not accept its late balance result', async () => {
  await observeBalances()
  const hook = renderHook(useAddressesDataPolling, { wrapper })
  await flush()
  let resolve!: (value: { balance: string; lockedBalance: string }) => void
  balances.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await flush(10001)
  context.addresses = []
  hook.rerender()
  resolve({ balance: '999', lockedBalance: '0' })
  await flush()
  expect(queryClient.getQueryData(addressAlphBalancesQuery(options()).queryKey)?.balances.totalBalance).toBe('100')
  expect(utxos).toHaveBeenCalledTimes(1)
})

it('detects a new earlier lock after external balance invalidation', async () => {
  await observeBalances()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush()
  lockedUntil = Date.now() + 1000
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: addressAlphBalancesQuery(options()).queryKey })
  })
  await flush(1001)
  expect(queryClient.getQueryData(addressAlphBalancesQuery(options()).queryKey)?.balances.lockedBalance).toBe('0')
})

it('refreshes a restored balance whose first lock expired even if another lock is far in the future', async () => {
  const secondLock = lockedUntil + 1000000
  balances.mockImplementation(async () => ({ balance: '100', lockedBalance: Date.now() <= lockedUntil ? '100' : '50' }))
  utxos.mockResolvedValue({ utxos: [{ lockTime: lockedUntil }, { lockTime: secondLock }] })
  const { alph } = await observeBalances()
  await flush(20000)
  renderHook(useAddressesDataPolling, { wrapper })
  await flush(60000)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('50')
  const count = balances.mock.calls.length
  await flush(120000)
  expect(balances).toHaveBeenCalledTimes(count + 2)
})

it('does not miss a deadline crossed during a slow UTXO response', async () => {
  const secondLock = lockedUntil + 1000000
  balances.mockImplementation(async () => ({ balance: '100', lockedBalance: Date.now() <= lockedUntil ? '100' : '50' }))
  let resolve!: (value: { utxos: Array<{ lockTime: number }> }) => void
  utxos.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  utxos.mockResolvedValue({ utxos: [{ lockTime: lockedUntil }, { lockTime: secondLock }] })
  const { alph } = await observeBalances()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush(20000)
  resolve({ utxos: [{ lockTime: lockedUntil }, { lockTime: secondLock }] })
  await flush(60000)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('50')
})

it('stops when provider status goes offline and recovers on reinitialization', async () => {
  const { alph } = await observeBalances()
  const hook = renderHook(useAddressesDataPolling, { wrapper })
  await flush()
  context.online = false
  hook.rerender()
  await flush(20000)
  expect(balances).toHaveBeenCalledTimes(1)
  context.online = true
  hook.rerender()
  await flush(60000)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('0')
})

it('backs off repeated UTXO errors up to one minute and never spins', async () => {
  utxos.mockRejectedValue(new Error('node temporarily unavailable'))
  lockedUntil = Date.now() + 1000000
  await observeBalances()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush(4999)
  expect(utxos).toHaveBeenCalledTimes(1)
  await flush(1)
  expect(utxos).toHaveBeenCalledTimes(2)
  await flush(10000 + 20000 + 40000)
  expect(utxos).toHaveBeenCalledTimes(5)
  await flush(60000)
  expect(utxos).toHaveBeenCalledTimes(6)
  await flush(60000)
  expect(utxos).toHaveBeenCalledTimes(7)
  lockedUntil = Date.now() - 1
  await flush(60000)
  const count = utxos.mock.calls.length
  await flush(120000)
  expect(utxos).toHaveBeenCalledTimes(count)
  expect(queryClient.getQueryData(addressAlphBalancesQuery(options()).queryKey)?.balances.lockedBalance).toBe('0')
})

it('ignores a result from a replaced provider even before the lifecycle effect cleans up', async () => {
  let resolve!: (value: { utxos: Array<{ lockTime: number }> }) => void
  utxos.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await observeBalances()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush()
  vi.spyOn(throttledClient, 'node', 'get').mockReturnValue({} as NodeProvider)
  resolve({ utxos: [{ lockTime: lockedUntil }] })
  await flush(20000)
  expect(balances).toHaveBeenCalledTimes(1)
})

it('verifies a balance response sampled before expiry but completed afterwards, even with a later lock', async () => {
  const secondLock = lockedUntil + 1000000
  let resolve!: (value: { balance: string; lockedBalance: string }) => void
  balances.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  balances.mockImplementation(async () => ({ balance: '100', lockedBalance: '50' }))
  utxos.mockResolvedValue({ utxos: [{ lockTime: lockedUntil }, { lockTime: secondLock }, { lockTime: 0 }] })
  const alph = new QueryObserver(queryClient, addressAlphBalancesQuery(options()))
  unsubscribers.push(alph.subscribe(() => {}))
  await flush(10001)
  resolve({ balance: '100', lockedBalance: '100' })
  await flush()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush(60000)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('50')
  const count = balances.mock.calls.length
  await flush(120000)
  expect(balances).toHaveBeenCalledTimes(count + 2)
})

it('does not abandon recovery after a balance request fails', async () => {
  const { alph } = await observeBalances()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush()
  balances.mockRejectedValueOnce(new Error('temporary balance failure'))
  await flush(10001)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('100')
  await flush(5000)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('0')
})

it('does not postpone safety refresh when another source succeeds before its timer', async () => {
  const secondLock = lockedUntil + 1000000
  let resolve!: (value: { balance: string; lockedBalance: string }) => void
  balances.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  balances.mockImplementation(async () => ({ balance: '100', lockedBalance: '50' }))
  utxos.mockResolvedValue({ utxos: [{ lockTime: lockedUntil }, { lockTime: secondLock }] })
  const alph = new QueryObserver(queryClient, addressAlphBalancesQuery(options()))
  unsubscribers.push(alph.subscribe(() => {}))
  await flush(10001)
  resolve({ balance: '100', lockedBalance: '100' })
  await flush()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush(1000)
  await act(async () => {
    await queryClient.fetchQuery(addressTokensBalancesQuery(options()))
  })
  await flush(58999)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('100')
  await flush(1)
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('50')
})

it('does not let hung discovery block safety refresh or a late discovery overwrite its in-flight state', async () => {
  let resolveUtxos!: (value: { utxos: Array<{ lockTime: number }> }) => void
  utxos.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolveUtxos = done
      })
  )
  const { alph } = await observeBalances()
  renderHook(useAddressesDataPolling, { wrapper })
  await flush()
  const signal = utxos.mock.calls[0][2].signal as AbortSignal
  let resolveBalance!: (value: { balance: string; lockedBalance: string }) => void
  balances.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolveBalance = done
      })
  )
  await flush(60000)
  expect(balances).toHaveBeenCalledTimes(2)
  expect(signal.aborted).toBe(true)
  resolveUtxos({ utxos: [{ lockTime: Date.now() + 1 }] })
  await flush(10000)
  expect(balances).toHaveBeenCalledTimes(2)
  expect(utxos).toHaveBeenCalledTimes(1)
  resolveBalance({ balance: '100', lockedBalance: '0' })
  await flush()
  expect(alph.getCurrentResult().data?.balances.lockedBalance).toBe('0')
  await flush(120000)
  expect(balances).toHaveBeenCalledTimes(2)
})
