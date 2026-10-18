import { animate } from 'framer-motion'
import { useEffect, useRef } from 'react'

import { addCommas } from '@/utils/numbers'

interface CounterProps {
  from?: number
  to: number
}

const Counter = ({ from, to }: CounterProps) => {
  const nodeRef = useRef<HTMLSpanElement>(null)
  const previousTargetValue = useRef(0)

  useEffect(() => {
    const node = nodeRef.current

    const handle = animate(from || previousTargetValue.current, to, {
      duration: 1,
      onUpdate(value) {
        if (node) {
          node.textContent = addCommas(value.toFixed(0))
          previousTargetValue.current = to
        }
      }
    })

    return () => handle.stop()
  }, [from, to])

  return <span ref={nodeRef} />
}

export default Counter
