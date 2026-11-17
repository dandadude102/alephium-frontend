import { animate } from 'framer-motion'
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Counter from './Counter'

const { stop, onUpdates } = vi.hoisted(() => ({
  stop: vi.fn(),
  onUpdates: [] as Array<(value: number) => void>
}))

vi.mock('framer-motion', () => ({
  animate: vi.fn((from: number, to: number, { onUpdate }: { onUpdate: (value: number) => void }) => {
    onUpdates.push(onUpdate)

    return { stop }
  })
}))

describe('Counter', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.clearAllMocks()
    onUpdates.length = 0
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  })

  it('groups animation frames with commas while preserving integer rounding', () => {
    act(() => root.render(<Counter to={7219800} />))

    for (const [value, expected] of [
      [0, '0'],
      [999.4, '999'],
      [999.6, '1,000'],
      [7219800, '7,219,800']
    ] as const) {
      act(() => onUpdates[0](value))
      expect(container.textContent).toBe(expected)
    }
  })

  it('stops the previous animation and starts from the last target when the target changes', () => {
    act(() => root.render(<Counter from={500} to={1000} />))
    expect(animate).toHaveBeenLastCalledWith(500, 1000, expect.objectContaining({ duration: 1 }))
    act(() => onUpdates[0](1000))

    act(() => root.render(<Counter to={2000} />))

    expect(stop).toHaveBeenCalledTimes(1)
    expect(animate).toHaveBeenLastCalledWith(1000, 2000, expect.objectContaining({ duration: 1 }))
    act(() => onUpdates[1](2000))
    expect(container.textContent).toBe('2,000')
  })

  it('stops the animation on unmount', () => {
    act(() => root.render(<Counter to={1000} />))
    act(() => root.render(null))

    expect(stop).toHaveBeenCalledTimes(1)
  })
})
