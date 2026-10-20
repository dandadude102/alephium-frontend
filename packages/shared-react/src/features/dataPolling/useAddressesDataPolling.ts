import { ADDRESSES_TRANSACTIONS_REFRESH_INTERVAL } from '@alephium/shared'
import { throttledClient } from '@alephium/shared/api'
import { useQueries } from '@tanstack/react-query'
import { useEffect } from 'react'

import { addressLatestTransactionQuery } from '../../api/queries/transactionQueries'
import { useUnsortedAddressesHashes } from '../../hooks/addresses/useUnsortedAddresses'
import { useIsExplorerOnline, useIsNodeOnline, useNetworkId } from '../../network/networkHooks'
import { startLockedBalancesRefresh } from './lockedBalancesRefresh'

export const useAddressesDataPolling = () => {
  const addressHashes = useUnsortedAddressesHashes()
  const networkId = useNetworkId()
  const isExplorerOnline = useIsExplorerOnline()

  const isNodeOnline = useIsNodeOnline()

  useEffect(() => {
    if (!isNodeOnline || !isExplorerOnline) return
    const node = throttledClient.node
    const explorer = throttledClient.explorer

    return startLockedBalancesRefresh({
      addressHashes,
      networkId,
      getUtxos: (address, signal) =>
        node.addresses.getAddressesAddressUtxos(address, { 'error-if-exceed-max-utxos': true }, { signal }),
      isCurrentNetwork: () => throttledClient.node === node && throttledClient.explorer === explorer
    })
  }, [addressHashes, networkId, isNodeOnline, isExplorerOnline])

  useQueries({
    queries: addressHashes.map((addressHash) => ({
      ...addressLatestTransactionQuery({ addressHash, networkId, isExplorerOnline }),
      refetchInterval: ADDRESSES_TRANSACTIONS_REFRESH_INTERVAL,
      notifyOnChangeProps: []
    }))
  })
}
