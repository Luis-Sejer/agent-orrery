import { describe, expect, it } from 'vitest'

import { buildFlow, buildEdges, buildTree, groupIntoRooms, relatedTo, AGENT_SIZE, SESSION_SIZE, type CardNode, type FlowOptions } from './layout'
import { foldWorktree } from './rooms'
import { beamStyle, phaseOf } from './rhythm'
import { statusOf } from './status'
import type { AgentNode, GraphSnapshot } from './types'
import { parseState } from './settings'
import { applyDismissals } from './useDismissed'
import { newWaits } from './useNotifications'
import { THEMES, parsePreference, resolveTheme } from './useTheme'
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

describe('rooms', () => {
  it('put rooms waiting on you first, then rooms with sessions, then the rest by name', () => {
    const graph = graphOf([
      agent('a', { room: 'alpha', kind: 'session', parentId: null }),
      agent('z', { room: 'zulu', kind: 'session', parentId: null, waiting: { reason: 'question', since: NOW - MINUTE } }),
      agent('h', { room: 'helpers' }),
      agent('b', { room: 'bravo', kind: 'session', parentId: null }),
    ])
    expect(groupIntoRooms(graph, options()).map((room) => room.name)).toEqual(['zulu', 'alpha', 'bravo', 'helpers'])
  })
})

describe('keyboard', () => {
  it('makes agents buttons named for what they do, and rooms and piles no stop of their own', () => {
    const { nodes } = buildFlow(graphOf([lead, agent('w'), finished('f1'), finished('f2'), finished('f3')]), options())
    const card = nodes.find((node) => node.id === 'w')!
    expect(card.ariaRole).toBe('button')
    expect(card.ariaLabel).toBe('w, Running a command 1 min ago')
    expect(nodes.filter((node) => node.type === 'room' || node.type === 'fold').every((node) => node.focusable === false)).toBe(true)
  })
})

describe('fixed frames', () => {
  it('gives every grid node with edges its size and both handles, so React Flow never re-measures it', () => {
    const { nodes } = buildFlow(graphOf([lead, agent('w'), finished('f1'), finished('f2'), finished('f3')]), options())
    const withEdges = nodes.filter((node) => node.type !== 'room')
    expect(withEdges.map((node) => node.type).sort()).toEqual(['agent', 'fold', 'session'])
    for (const node of withEdges) {
      expect(node.measured).toEqual({ width: node.width, height: node.height })
      const [source, target] = node.handles!
      expect([source.type, source.position, source.x, source.y]).toEqual(['source', 'right', node.width! - 3, node.height! / 2 - 3])
      expect([target.type, target.position, target.x, target.y]).toEqual(['target', 'left', -3, node.height! / 2 - 3])
    }
    expect(nodes.filter((node) => node.type === 'room').every((node) => node.measured?.width === node.width)).toBe(true)
  })
})

describe('message edges', () => {
  it('flow while a message is under two minutes old, then rest', () => {
    const graph = graphOf([lead, agent('w')], [
      { from: 'lead', to: 'w', count: 1, lastAt: NOW - MINUTE },
      { from: 'w', to: 'lead', count: 1, lastAt: NOW - 5 * MINUTE },
    ])
    const fresh = buildEdges(graph, new Map(), null, NOW).filter((edge) => edge.type === 'message').map((edge) => edge.data?.fresh)
    expect(fresh).toEqual([true, false])
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
  it('offers system, light, dark and T.Y.C.H.O., each of which survives a reload', () => {
    expect(THEMES.map((theme) => theme.value)).toEqual(['system', 'light', 'dark', 'tycho'])
    for (const { value } of THEMES) expect(parsePreference(value)).toBe(value)
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

describe('worktrees', () => {
  it('folds a worktree into its repository, keeping the area', () => {
    expect(foldWorktree('shop ⎇ feat/search')).toBe('shop')
    expect(foldWorktree('shop ⎇ feat/search › apps/web')).toBe('shop › apps/web')
    expect(foldWorktree('shop › apps/web')).toBe('shop › apps/web')
  })
})

describe("the server's state", () => {
  it('keeps only strings for settings and numbers for dismissals, and starts empty without any', () => {
    const empty = { defaults: {}, settings: {}, dismissals: {} }
    expect(parseState(undefined)).toEqual(empty)
    expect(parseState('not json')).toEqual(empty)
    expect(parseState('[1, 2]')).toEqual(empty)
    expect(parseState('{"settings": {"theme": "dark", "x": 1}, "dismissals": {"a": 1, "b": "x", "c": null}, "defaults": []}')).toEqual({
      defaults: {},
      settings: { theme: 'dark' },
      dismissals: { a: 1 },
    })
  })
})

describe('the tree', () => {
  it('puts each subagent a column right of its parent, level with its first sibling, in name order', () => {
    const graph = graphOf([lead, agent('b'), agent('a'), agent('deep', { parentId: 'a' }), agent('other', { kind: 'session', parentId: null, sessionId: 'other', room: 'web' })])
    const at = Object.fromEntries(buildTree(graph, options()).nodes.map((node) => [node.id, node.position]))
    expect(at.lead).toEqual({ x: 0, y: 0 })
    expect(at.a.y).toBe(0)
    expect(at.a.x).toBeGreaterThan(SESSION_SIZE.width)
    expect(at.deep).toEqual({ x: at.a.x + AGENT_SIZE.width + 56, y: 0 })
    // b comes after a's whole branch, and the next session after lead's.
    expect(at.b).toEqual({ x: at.a.x, y: AGENT_SIZE.height + 14 })
    expect(at.other.y).toBeGreaterThan(at.b.y + AGENT_SIZE.height)
  })

  it('still places agents whose parents loop back on themselves', () => {
    const { nodes } = buildTree(graphOf([agent('x', { parentId: 'y' }), agent('y', { parentId: 'x' })]), options())
    expect(nodes.map(({ id }) => id).sort()).toEqual(['x', 'y'])
  })
})

describe('collisions', () => {
  it('draw a line between two agents in the same files, unless one has gone into a pile', () => {
    const graph = { ...graphOf([lead, agent('a'), agent('b')]), collisions: [{ a: 'a', b: 'b', files: ['cart.ts'], repo: 'api', at: NOW }] }
    expect(buildEdges(graph, new Map(), null, NOW).filter(({ id }) => id.startsWith('collision:'))).toHaveLength(1)
    expect(buildEdges(graph, new Map([['b', 'fold:api']]), null, NOW).filter(({ id }) => id.startsWith('collision:'))).toHaveLength(0)
  })
})

describe('artifact links', () => {
  it('opens only claude.ai artifact addresses', async () => {
    const { isArtifactUrl } = await import('./artifacts')
    expect(isArtifactUrl('https://claude.ai/artifact/MadeUpPage1234')).toBe(true)
    expect(isArtifactUrl('https://claude.ai/code/artifact/0123-abcd-ef')).toBe(true)
    expect(isArtifactUrl('javascript:alert(1)')).toBe(false)
    expect(isArtifactUrl('https://claude.ai.evil.example/artifact/abcdef')).toBe(false)
    expect(isArtifactUrl('https://claude.ai/artifact/abcdef/../../settings')).toBe(false)
  })
})
