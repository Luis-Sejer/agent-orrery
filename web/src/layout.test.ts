import { describe, expect, it } from 'vitest'

import { buildFlow, relatedTo, type CardNode, type FlowOptions } from './layout'
import { beamStyle, phaseOf } from './rhythm'
import { statusOf } from './status'
import type { AgentNode, GraphSnapshot } from './types'
import { applyDismissals } from './useDismissed'
import { newWaits } from './useNotifications'
import { NEXT, parsePreference, resolveTheme, type ThemePreference } from './useTheme'
import { announcement, pickVoice } from './useVoice'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const MINUTE = 60_000

function agent(id: string, fields: Partial<AgentNode> = {}): AgentNode {
  return {
    id,
    kind: 'subagent',
    label: id,
    branch: null,
    home: 'api',
    room: 'api',
    repos: [],
    activity: 'working',
    lastTool: 'Bash',
    lastAt: NOW - MINUTE,
    waiting: null,
    pendingTool: null,
    usage: {},
    agentType: 'general-purpose',
    model: null,
    sessionId: 'lead',
    parentId: 'lead',
    plans: [],
    ...fields,
  }
}

const lead = agent('lead', { kind: 'session', parentId: null, sessionId: 'lead' })
const finished = (id: string, room = 'web') => agent(id, { room, waiting: { reason: 'reply', since: NOW - 30 * MINUTE } })

function graphOf(nodes: AgentNode[], messages: GraphSnapshot['messages'] = []): GraphSnapshot {
  return { nodes, messages }
}

function options(fields: Partial<FlowOptions> = {}): FlowOptions {
  return { now: NOW, selectedId: null, expandedRooms: new Set(), filter: 'all', onExpand: () => {}, onCollapse: () => {}, ...fields }
}

const cards = (nodes: ReturnType<typeof buildFlow>['nodes']) => nodes.filter((node): node is CardNode => node.type === 'session' || node.type === 'agent')

describe('statusOf', () => {
  it('reads a session that ended its turn as waiting, and a subagent that did as finished', () => {
    expect(statusOf(agent('s', { kind: 'session', waiting: { reason: 'reply', since: NOW } }), NOW)).toBe('waiting')
    expect(statusOf(agent('a', { waiting: { reason: 'reply', since: NOW } }), NOW)).toBe('finished')
  })

  it('keeps an agent running through a long quiet tool call, then calls it finished', () => {
    expect(statusOf(agent('a', { lastAt: NOW - 10 * MINUTE }), NOW)).toBe('running')
    expect(statusOf(agent('a', { lastAt: NOW - 20 * MINUTE }), NOW)).toBe('finished')
  })
})

describe('relatedTo', () => {
  it('includes the parent, the children and anyone it messaged', () => {
    const graph = graphOf([lead, agent('child'), agent('other', { parentId: null, sessionId: 'x' }), agent('peer', { kind: 'peer', parentId: null, sessionId: null })], [
      { from: 'child', to: 'peer', count: 1, lastAt: NOW },
    ])
    expect([...relatedTo(graph, 'child')].sort()).toEqual(['child', 'lead', 'peer'])
    expect(relatedTo(graph, null).size).toBe(0)
  })
})

describe('buildFlow', () => {
  it('puts each agent in its own room and folds a pile of finished ones', () => {
    const graph = graphOf([lead, agent('live', { room: 'web' }), finished('done-1'), finished('done-2'), finished('done-3')])
    const { nodes } = buildFlow(graph, options())
    const rooms = nodes.filter((node) => node.type === 'room').map((node) => node.id)
    expect(rooms).toEqual(['room:api', 'room:web'])
    expect(cards(nodes).map((node) => node.id).sort()).toEqual(['lead', 'live'])
    expect(nodes.find((node) => node.type === 'fold')?.data).toMatchObject({ count: 3 })
  })

  it('unfolds a room on request, and offers to fold it again', () => {
    const graph = graphOf([lead, finished('done-1'), finished('done-2'), finished('done-3')])
    const open = buildFlow(graph, options({ expandedRooms: new Set(['web']) })).nodes
    expect(cards(open)).toHaveLength(4)
    expect(open.find((node) => node.id === 'room:web')?.data).toMatchObject({ foldable: true })
    const closed = buildFlow(graph, options()).nodes
    expect(closed.find((node) => node.id === 'room:web')?.data).toMatchObject({ foldable: false })
  })

  it('never moves a card when you select something', () => {
    const graph = graphOf([lead, agent('live', { room: 'web' }), finished('done-1'), finished('done-2'), finished('done-3')])
    const positions = (selectedId: string | null) =>
      Object.fromEntries(buildFlow(graph, options({ selectedId })).nodes.map((node) => [node.id, node.position]))
    const unselected = positions(null)
    const leadSelected = positions('lead')
    expect(leadSelected).toEqual(unselected)
    const fold = buildFlow(graph, options({ selectedId: 'lead' })).nodes.find((node) => node.type === 'fold')
    expect(fold?.data).toMatchObject({ related: true, dimmed: false })
  })

  it('dims what is unrelated to the selection and lifts the selected edges', () => {
    const graph = graphOf([lead, agent('child'), agent('stranger', { parentId: null, sessionId: 'x' })])
    const { nodes, edges } = buildFlow(graph, options({ selectedId: 'child' }))
    const byId = new Map(cards(nodes).map((node) => [node.id, node]))
    expect(byId.get('stranger')?.data.dimmed).toBe(true)
    expect(byId.get('lead')?.data.dimmed).toBe(false)
    const litEdge = edges.find((edge) => edge.target === 'child')
    expect(litEdge?.className).toContain('lit')
    expect(byId.get('child')!.zIndex!).toBeGreaterThan(litEdge!.zIndex!)
    expect(litEdge!.zIndex!).toBeGreaterThan(byId.get('lead')!.zIndex!)
  })

  it('gives every node a size, so the minimap can draw it', () => {
    const { nodes } = buildFlow(graphOf([lead, agent('child')]), options())
    for (const node of nodes) expect(node.width && node.height).toBeTruthy()
  })
})

describe('applyDismissals', () => {
  const waiting = agent('s', { kind: 'session', waiting: { reason: 'reply', since: NOW }, lastAt: NOW })

  it('stops a dismissed session waiting on you', () => {
    const [node] = applyDismissals(graphOf([waiting]), { s: NOW }).nodes
    expect(statusOf(node, NOW)).toBe('finished')
  })

  it('brings it back once it does something new', () => {
    const [node] = applyDismissals(graphOf([{ ...waiting, lastAt: NOW + MINUTE }]), { s: NOW }).nodes
    expect(statusOf(node, NOW)).toBe('waiting')
  })
})

describe('newWaits', () => {
  const session = (id: string, since: number) => agent(id, { kind: 'session', waiting: { reason: 'reply', since }, lastAt: since })

  it('stays quiet about sessions already waiting when the page opens', () => {
    expect(newWaits(null, [session('old', NOW)], NOW).fresh).toEqual([])
  })

  it('reports a session that starts waiting, once', () => {
    const first = newWaits(null, [], NOW)
    const second = newWaits(first.keys, [session('s', NOW)], NOW)
    expect(second.fresh.map((node) => node.id)).toEqual(['s'])
    expect(newWaits(second.keys, [session('s', NOW)], NOW).fresh).toEqual([])
  })

  it('reports it again when it waits again after you reply', () => {
    const { keys } = newWaits(null, [session('s', NOW - MINUTE)], NOW)
    expect(newWaits(keys, [session('s', NOW)], NOW).fresh.map((node) => node.id)).toEqual(['s'])
  })
})

describe('rhythm', () => {
  it('gives each card its own steady beam timing', () => {
    expect(phaseOf('a')).toBe(phaseOf('a'))
    expect(phaseOf('a')).not.toBe(phaseOf('b'))
    expect(beamStyle('session-1')).toEqual(beamStyle('session-1'))
    expect(beamStyle('session-1')).not.toEqual(beamStyle('session-2'))
    // Ids that differ only at the end still spread across the cycle.
    const phases = ['1', '2', '3', '4', '5'].map((n) => phaseOf(`5e55a000-0000-4000-8000-00000000000${n}`))
    expect(Math.max(...phases) - Math.min(...phases)).toBeGreaterThan(0.3)
  })
})

describe('theme', () => {
  it('cycles system, light, dark, T.Y.C.H.O. and back', () => {
    const seen: ThemePreference[] = ['system']
    for (let step = 0; step < 4; step++) seen.push(NEXT[seen.at(-1)!])
    expect(seen).toEqual(['system', 'light', 'dark', 'tycho', 'system'])
  })

  it('lays T.Y.C.H.O. over the dark theme, and falls back to system for anything unknown', () => {
    expect(resolveTheme('tycho', false)).toBe('dark')
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
    expect(parsePreference('tycho')).toBe('tycho')
    expect(parsePreference('neon')).toBe('system')
    expect(parsePreference(null)).toBe('system')
  })
})

describe('announcement', () => {
  it('says who is waiting and where, in words a speech engine reads well', () => {
    const waiting = agent('s', { kind: 'session', label: 'Rate limiter', room: 'storefront-api', waiting: { reason: 'reply', since: NOW } })
    expect(announcement(waiting)).toBe('Rate limiter is waiting on you in storefront api.')
    expect(announcement({ ...waiting, waiting: { reason: 'question', since: NOW } })).toBe('Rate limiter asked you a question in storefront api.')
  })
})

describe('pickVoice', () => {
  const voice = (name: string, lang = 'en-GB', fields: Partial<SpeechSynthesisVoice> = {}) =>
    ({ name, lang, localService: true, default: false, voiceURI: name, ...fields }) as SpeechSynthesisVoice
  const pick = (voices: SpeechSynthesisVoice[]) => pickVoice(voices)?.name ?? null

  it('prefers Premium, then Enhanced, then Daniel, then any British voice', () => {
    const voices = [voice('Samantha', 'en-US'), voice('Kate'), voice('Daniel'), voice('Serena (Enhanced)'), voice('Jamie (Premium)')]
    expect(pick(voices)).toBe('Jamie (Premium)')
    expect(pick(voices.slice(0, 4))).toBe('Serena (Enhanced)')
    expect(pick(voices.slice(0, 3))).toBe('Daniel')
    expect(pick(voices.slice(0, 2))).toBe('Kate')
  })

  it('falls back to any English voice, then the default, and skips novelty and network voices', () => {
    expect(pick([voice('Eddy (English (UK))'), voice('Google UK English Male', 'en-GB', { localService: false }), voice('Samantha', 'en-US')])).toBe('Samantha')
    expect(pick([voice('Zarvox', 'en-US'), voice('Anna', 'de-DE', { default: true })])).toBe('Anna')
    expect(pick([])).toBeNull()
  })
})
