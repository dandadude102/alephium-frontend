import { AddressHash } from '@alephium/shared/types'
import { node } from '@alephium/web3'
import { focusManager, onlineManager } from '@tanstack/react-query'

import {
  ADDRESS_DATA,
  AddressAlphBalancesQueryFnData,
  addressAlphBalancesQueryKey,
  AddressTokensBalancesQueryFnData
} from '../../api/queries/addressQueries'
import { queryClient } from '../../api/queryClient'

const INITIAL_RETRY_DELAY = 5000
const MAX_REFRESH_DELAY = 60000

interface LockRefresh {
  timer?: ReturnType<typeof setTimeout>
  deadline?: number
  abort: AbortController
  busy: boolean
  refreshing: boolean
  dirty: boolean
  retryDelay: number
}

interface LockedBalancesRefreshOptions {
  addressHashes: AddressHash[]
  networkId: number
  getUtxos: (address: AddressHash, signal: AbortSignal) => Promise<node.UTXOs>
  isCurrentNetwork: () => boolean
}

// Timers are only freshness hints: all displayed/spendable amounts still come from the balance APIs.
// While an authoritative balance remains locked, a one-minute safety refresh bounds stale data even if
// UTXOs or a balance response straddle an expiry, the backend clock lags, or discovery fails. Known sooner
// deadlines take precedence. Unlocked addresses never start this work, and background/offline pauses it.
export const startLockedBalancesRefresh = ({
  addressHashes,
  networkId,
  getUtxos,
  isCurrentNetwork
}: LockedBalancesRefreshOptions) => {
  const addresses = new Set(addressHashes)
  const entries = new Map<AddressHash, LockRefresh>()
  let disposed = false

  const enabled = () => !disposed && isCurrentNetwork() && focusManager.isFocused() && onlineManager.isOnline()
  const current = (address: AddressHash, entry: LockRefresh) => enabled() && entries.get(address) === entry
  const matchesNetwork = (key: readonly unknown[]) =>
    key.some((part) => typeof part === 'object' && part !== null && 'networkId' in part && part.networkId === networkId)
  const matchesAddressData = (address: AddressHash, query: { queryKey: readonly unknown[] }) =>
    query.queryKey[0] === 'address' &&
    query.queryKey[1] === address &&
    query.queryKey[2] === ADDRESS_DATA &&
    matchesNetwork(query.queryKey)
  const isSourceBalance = (key: readonly unknown[]) =>
    key[3] === 'balance' && ['ALPH', 'tokens'].includes(key[4] as string)

  const hasLockedBalance = (address: AddressHash) => {
    const alph = queryClient.getQueryData<AddressAlphBalancesQueryFnData>(
      addressAlphBalancesQueryKey({ addressHash: address, networkId })
    )
    const tokens = queryClient.getQueryData<AddressTokensBalancesQueryFnData>([
      'address',
      address,
      ADDRESS_DATA,
      'balance',
      'tokens',
      { networkId }
    ])
    return (
      BigInt(alph?.balances.lockedBalance ?? '0') > 0n ||
      (tokens?.balances.some(({ lockedBalance }) => BigInt(lockedBalance) > 0n) ?? false)
    )
  }

  const remove = (address: AddressHash) => {
    const entry = entries.get(address)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.abort.abort()
    entries.delete(address)
    if (entry.refreshing) {
      void queryClient.cancelQueries({ predicate: (query) => matchesAddressData(address, query) })
    }
  }

  const schedule = (address: AddressHash, entry: LockRefresh, delay: number) => {
    if (!current(address, entry)) return
    clearTimeout(entry.timer)
    // Keep an earlier pending refresh when another source succeeds. Repeated cache notifications must
    // not postpone recovery. The one-minute cap also avoids the ~24.8-day JavaScript timer overflow.
    entry.deadline = Math.min(entry.deadline ?? Infinity, Date.now() + delay)
    entry.timer = setTimeout(
      () => {
        entry.deadline = undefined
        void refresh(address, entry)
      },
      Math.max(1, Math.min(MAX_REFRESH_DELAY, entry.deadline - Date.now()))
    )
  }

  const retry = (address: AddressHash, entry: LockRefresh) => {
    schedule(address, entry, entry.retryDelay)
    entry.retryDelay = Math.min(MAX_REFRESH_DELAY, entry.retryDelay * 2)
  }

  const inspect = async (address: AddressHash, entry: LockRefresh) => {
    if (!current(address, entry)) return
    entry.busy = true
    entry.dirty = false
    const signal = entry.abort.signal
    const isActive = () => current(address, entry) && !signal.aborted
    // Discovery itself may be slow or never return; it must not hold up the safety refresh.
    schedule(address, entry, MAX_REFRESH_DELAY)
    try {
      // Never accept truncated UTXOs: they could omit the nearest lock. Errors use bounded recovery.
      const { utxos } = await getUtxos(address, signal)
      if (!isActive()) return
      if (!hasLockedBalance(address)) return remove(address)
      const nextLock = utxos.reduce(
        (next, { lockTime }) =>
          lockTime !== undefined && Number.isSafeInteger(lockTime) && lockTime > Date.now()
            ? Math.min(next, lockTime)
            : next,
        Infinity
      )
      entry.retryDelay = INITIAL_RETRY_DELAY
      // Explorer's comparison is strict (< now), so the exact timestamp can still be locked.
      schedule(address, entry, Math.min(MAX_REFRESH_DELAY, nextLock - Date.now() + 1))
    } catch {
      if (isActive()) retry(address, entry)
    } finally {
      if (isActive()) {
        entry.busy = false
        if (entry.dirty) reconcile(address)
      }
    }
  }

  const refresh = async (address: AddressHash, entry: LockRefresh) => {
    if (!current(address, entry)) return
    entry.busy = true
    entry.refreshing = true
    entry.dirty = false
    entry.abort.abort()
    entry.abort = new AbortController()
    const predicate = (query: { queryKey: readonly unknown[] }) => matchesAddressData(address, query)
    let inspectAfterRefresh = false
    try {
      // Cancel first so composed queries cannot retain a pre-expiry in-flight result. Do not cancel
      // their dependency fetches a second time while invalidating the graph.
      await queryClient.cancelQueries({ predicate })
      if (!current(address, entry)) return
      await queryClient.invalidateQueries({ predicate }, { cancelRefetch: false })
      if (!current(address, entry)) return
      // Active composed consumers already fetched their sources. Refresh any remaining inactive
      // cached sources too, or an address without a mounted consumer would retain its old lock forever.
      await queryClient.refetchQueries(
        {
          type: 'inactive',
          predicate: (query) =>
            predicate(query) &&
            isSourceBalance(query.queryKey) &&
            query.state.data !== undefined &&
            query.state.isInvalidated
        },
        { cancelRefetch: false }
      )
      if (!current(address, entry)) return
      if (!hasLockedBalance(address)) return remove(address)
      const sourceRefreshFailed = queryClient
        .getQueryCache()
        .findAll({ predicate })
        .some(
          (query) => isSourceBalance(query.queryKey) && (query.state.isInvalidated || query.state.status === 'error')
        )
      if (sourceRefreshFailed) return retry(address, entry)
      inspectAfterRefresh = true
    } catch {
      if (current(address, entry)) retry(address, entry)
    } finally {
      entry.refreshing = false
      entry.busy = false
    }
    if (inspectAfterRefresh && current(address, entry)) void inspect(address, entry)
  }

  const newEntry = (): LockRefresh => ({
    abort: new AbortController(),
    busy: false,
    refreshing: false,
    dirty: false,
    retryDelay: INITIAL_RETRY_DELAY
  })

  const reconcile = (address: AddressHash) => {
    if (!enabled() || !hasLockedBalance(address)) return remove(address)
    let entry = entries.get(address)
    if (entry?.busy) {
      entry.dirty = true
      return
    }
    if (!entry) {
      entry = newEntry()
      entries.set(address, entry)
    }
    void inspect(address, entry)
  }

  const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey
    if (key[0] !== 'address' || !addresses.has(key[1] as AddressHash) || !matchesNetwork(key)) return
    if (key[2] !== ADDRESS_DATA || !isSourceBalance(key)) return
    if (event.type === 'removed' || (event.type === 'updated' && event.action.type === 'success')) {
      const address = key[1] as AddressHash
      // Own refreshes emit multiple dependent notifications; inspect once after their cascade finishes.
      if (!entries.get(address)?.refreshing) reconcile(address)
    }
  })
  const resume = () => {
    addresses.forEach((address) => {
      if (!enabled() || !hasLockedBalance(address)) return remove(address)
      const existing = entries.get(address)
      if (existing?.busy) return
      const entry = existing ?? newEntry()
      entries.set(address, entry)
      clearTimeout(entry.timer)
      entry.deadline = undefined
      // Sleep/background can cross several boundaries, including one no longer present in UTXOs.
      void refresh(address, entry)
    })
  }
  const unsubscribeFocus = focusManager.subscribe(resume)
  const unsubscribeOnline = onlineManager.subscribe(resume)
  addresses.forEach(reconcile)

  return () => {
    disposed = true
    unsubscribeCache()
    unsubscribeFocus()
    unsubscribeOnline()
    addresses.forEach(remove)
  }
}
