import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('prefersStill', () => {
  it('holds still for reduced motion or Pause motion, and moves otherwise', async () => {
    let reduced = false
    const attributes = new Set<string>()
    vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced }, addEventListener() {}, removeEventListener() {} }))
    vi.stubGlobal('document', { documentElement: { hasAttribute: (name: string) => attributes.has(name) } })
    const { prefersStill } = await import('./motion')
    expect(prefersStill()).toBe(false)
    attributes.add('data-still')
    expect(prefersStill()).toBe(true)
    attributes.clear()
    reduced = true
    expect(prefersStill()).toBe(true)
  })
})
