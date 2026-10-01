/**
 * The grouping seam: the pure derivation, the registry service, and the
 * sidebar consumption through the derived tree.
 */
// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  deriveGroupingData, deriveGroupingView, groupKeyOf, groupingParents, isProviderGroupKey,
  isProviderKeyOf, providerKey, providerKeyAncestors, resolveSessionPath,
  type GroupingInput, type GroupingProvider, type GroupingSource,
} from '../src/client/grouping.ts'
import { GroupingService } from '../src/client/grouping-service.ts'
import {
  deriveGroups, ownsGroup, type SessionRowState, type TreeView,
} from '../src/client/tree.ts'
import { pinOrderAccounts, pinOrderSource } from '../src/client/pin-order.ts'
import { FLAT_SESSION_ORDER_KEY as FLAT_ORDER } from '../src/client/stores.ts'

const sid = (id: string): SessionId => id as SessionId
const wid = (id: string): WorkspaceId => id as WorkspaceId
const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt: 0, ...overrides,
  retainedBy: overrides.retainedBy ?? {},
})
const list = (...items: readonly SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  phase: 'ready',
  projectionsBySession: {},
})
const workspace = (id: string, sessionIds: readonly string[]): WorkspaceView => ({
  workspaceId: wid(id), path: `/w/${id}`, title: id,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const noRows: SessionRowState = { pinnedSessionIds: [], archivedSessionIds: [], archivedFilter: 'default' }
const noStatuses = new Map()

/**
 * A provider under the id `p`, claiming the Sessions whose id starts with
 * `prefix` as the single row `p:<prefix>`. Every other Session stays on the
 * core Workspace grouping.
 */
function prefixProvider(prefix: string, order?: number): GroupingProvider {
  return {
    id: 'p',
    resolve: session => session.id.startsWith(prefix)
      ? [{ key: prefix, label: `row-${prefix}`, ...(order === undefined ? {} : { order }) }]
      : undefined,
  }
}

/** A second single-level provider, so two providers can be compared. */
function otherProvider(prefix: string): GroupingProvider {
  return {
    id: 'q',
    resolve: session => session.id.startsWith(prefix)
      ? [{ key: prefix, label: `other-${prefix}` }]
      : undefined,
  }
}

/** A provider under the id `p` claiming the `a…` Sessions with a two-level path. */
function nestedProvider(): GroupingProvider {
  return {
    id: 'p',
    resolve: session => session.id.startsWith('a')
      ? [{ key: 'top', label: 'Top', order: 5 }, { key: 'leaf', label: 'Leaf', order: 1 }]
      : undefined,
  }
}

function sourceOf(providers: readonly GroupingProvider[], sessions: readonly SessionSummary[]): GroupingSource {
  const input: GroupingInput = { providers, list: list(...sessions), workspaces: [], expandedGroups: [] }
  return deriveGroupingView(deriveGroupingData(input), { ...input, orderBy: 'updated', savedOrder: {} })
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

describe('group keys', () => {
  it('namespaces every level by the provider id so a Workspace id can never be reused', () => {
    const providers = [{ id: 'ws', resolve: () => undefined }]
    expect(providerKey('ws', undefined, 'k')).toBe('ws:k')
    expect(providerKey('ws', 'ws:k', 'sub')).toBe('ws:k:sub')
    expect(isProviderGroupKey('ws:k', providers)).toBe(true)
    expect(isProviderGroupKey('ws:k:sub', providers)).toBe(true)
    expect(isProviderKeyOf('ws', 'ws:k:sub')).toBe(true)
    // A Workspace id that happens to equal a provider id is still a Workspace key.
    expect(isProviderGroupKey('ws', providers)).toBe(false)
    expect(isProviderGroupKey('', providers)).toBe(false)
    expect(isProviderKeyOf('ws', 'wsx:k')).toBe(false)
  })

  it('walks a nested row key up to its provider root', () => {
    const source = sourceOf([nestedProvider()], [summary('a1')])
    expect(providerKeyAncestors(source.grouping.rows, 'p:top:leaf')).toEqual(['p:top', 'p:top:leaf'])
    expect(providerKeyAncestors(source.grouping.rows, 'p:top')).toEqual(['p:top'])
    expect(providerKeyAncestors(source.grouping.rows, 'missing')).toEqual([])
  })

  it('reports the parent of each nested row', () => {
    const source = sourceOf([nestedProvider()], [summary('a1')])
    expect([...groupingParents(source.grouping.rows)]).toEqual([['p:top:leaf', 'p:top']])
  })
})

describe('resolveSessionPath', () => {
  it('returns undefined when no provider claims the Session', () => {
    expect(resolveSessionPath([prefixProvider('a')], summary('z9'))).toBeUndefined()
    expect(resolveSessionPath([], summary('a1'))).toBeUndefined()
  })

  it('takes the first claiming provider and ignores the rest', () => {
    expect(resolveSessionPath([nestedProvider(), prefixProvider('a')], summary('a1')))
      .toEqual([{ key: 'top', label: 'Top', order: 5 }, { key: 'leaf', label: 'Leaf', order: 1 }])
  })

  it('drops an empty path and the elements whose key cannot be namespaced', () => {
    const provider: GroupingProvider = {
      id: 'p',
      resolve: session => session.id === 'a1'
        ? []
        : session.id === 'a2'
          ? [{ key: 'x:y', label: 'colon' }, { key: '', label: 'empty' }, { key: 'ok', label: 'kept' }]
          : [{ key: 'all:dropped', label: 'colon' }],
    }
    expect(resolveSessionPath([provider], summary('a1'))).toBeUndefined()
    expect(resolveSessionPath([provider], summary('a2'))).toEqual([{ key: 'ok', label: 'kept' }])
    expect(resolveSessionPath([provider], summary('a3'))).toBeUndefined()
  })

  it('propagates a provider throw, which the seam never silently swallows', () => {
    const faulty: GroupingProvider = { id: 'faulty', resolve: () => { throw new Error('provider exploded') } }
    expect(() => resolveSessionPath([faulty], summary('a1'))).toThrow('provider exploded')
    expect(() => sourceOf([faulty, prefixProvider('a')], [summary('a1')])).toThrow('provider exploded')
  })
})

describe('deriveGroupingData', () => {
  it('derives nothing from an empty registry and leaves every account to the core grouping', () => {
    const data = deriveGroupingData({
      providers: [], list: list(summary('a1'), summary('b1')), workspaces: [workspace('a', ['a1'])],
      expandedGroups: [],
    })
    expect(data.nodes).toEqual([])
    expect(data.assignments).toEqual([])
    expect(data.ungrouped.map(item => item.id)).toEqual([sid('a1'), sid('b1')])
    expect(data.workspaceMembers.get(wid('a'))?.map(item => item.id)).toEqual([sid('a1')])
  })

  it('assigns each claimed Session to one row and keeps every row on a claimed path', () => {
    const hidden = summary('a2', { blank: true })
    const data = deriveGroupingData({
      providers: [prefixProvider('a')], list: list(summary('a1'), hidden, summary('z9')), workspaces: [], expandedGroups: [],
    })
    expect(data.assignments.map(assignment => [assignment.sessionId, assignment.key]))
      .toEqual([[sid('a1'), 'p:a'], [sid('a2'), 'p:a']])
    expect([...data.visibleKeys]).toEqual(['p:a'])
    expect(data.members.get('p:a')?.map(item => item.id)).toEqual([sid('a1'), sid('a2')])
    expect(data.ungrouped.map(item => item.id)).toEqual([sid('z9')])
  })

  it('removes a claimed Session from its Workspace account and parks the unclaimed one', () => {
    const data = deriveGroupingData({
      providers: [prefixProvider('a')], list: list(summary('a1'), summary('b1')),
      workspaces: [workspace('w', ['a1', 'b1'])], expandedGroups: [],
    })
    expect(data.workspaceMembers.get(wid('w'))?.map(item => item.id)).toEqual([sid('b1')])
    expect(data.ungrouped.map(item => item.id)).toEqual([sid('b1')])
  })

  it('keeps an unclaimed Session in the Workspace account with no provider row', () => {
    const data = deriveGroupingData({
      providers: [nestedProvider()], list: list(summary('a1'), summary('b1')),
      workspaces: [workspace('w', ['a1', 'b1'])], expandedGroups: [],
    })
    expect(data.workspaceMembers.get(wid('w'))?.map(item => item.id)).toEqual([sid('b1')])
    expect(data.nodes.map(node => node.key)).toEqual(['p:top', 'p:top:leaf'])
    expect(data.nodes.map(node => node.parentKey)).toEqual([undefined, 'p:top'])
    expect(data.nodes.map(node => [node.label, node.order, node.providerId, node.localKey]))
      .toEqual([['Top', 5, 'p', 'top'], ['Leaf', 1, 'p', 'leaf']])
  })

  it('orders sibling rows by the declared order, then by key', () => {
    const ordered: GroupingProvider = {
      id: 'p',
      resolve: session => [{ key: session.id, label: session.id, order: session.id === 'late' ? 9 : 1 }],
    }
    expect(sourceOf([ordered], [summary('late'), summary('early')]).grouping.rows.map(row => row.key))
      .toEqual(['p:early', 'p:late'])
    // Two elements with no order tie on key, so the page does not follow list order.
    const unordered: GroupingProvider = { id: 'p', resolve: session => [{ key: session.id, label: session.id }] }
    expect(sourceOf([unordered], [summary('b'), summary('a')]).grouping.rows.map(row => row.key))
      .toEqual(['p:a', 'p:b'])
  })

  it('keeps the first label an element was seen with and fills an empty one', () => {
    const provider: GroupingProvider = {
      id: 'p',
      resolve: session => [{ key: 'k', label: session.id === 'a1' ? 'First' : 'other' }],
    }
    const data = deriveGroupingData({
      providers: [provider], list: list(summary('a1'), summary('b1')), workspaces: [], expandedGroups: [],
    })
    expect(data.nodes).toHaveLength(1)
    expect(data.nodes[0]).toMatchObject({ key: 'p:k', label: 'First' })
    const blank: GroupingProvider = { id: 'p', resolve: () => [{ key: 'k', label: '' }] }
    expect(deriveGroupingData({
      providers: [blank], list: list(summary('a1')), workspaces: [], expandedGroups: [],
    }).nodes[0]?.label).toBe('')
  })
})

describe('deriveGroupingView', () => {
  it('publishes each row account plus the ungrouped bucket, ordered by the selected mode', () => {
    const sessions = [summary('a1', { updatedAt: 1 }), summary('a2', { updatedAt: 5 }), summary('z1', { updatedAt: 3 })]
    const source = sourceOf([prefixProvider('a')], sessions)
    expect(source.orders['p:a']).toEqual([sid('a2'), sid('a1')])
    expect(source.orders['']).toEqual([sid('z1')])
    expect(source.labelsBySession.get(sid('a1'))).toBe('row-a')
    // An unclaimed Session carries no provider label, so a result keeps its Workspace title.
    expect(source.labelsBySession.has(sid('z1'))).toBe(false)
  })

  it('reads a saved manual order for a provider row and for the ungrouped bucket', () => {
    const sessions = [summary('a1', { updatedAt: 9 }), summary('a2', { updatedAt: 1 }), summary('z1', { updatedAt: 4 })]
    const input: GroupingInput = { providers: [prefixProvider('a')], list: list(...sessions), workspaces: [], expandedGroups: [] }
    const source = deriveGroupingView(deriveGroupingData(input), {
      ...input, orderBy: 'manual', savedOrder: { 'p:a': ['a2'], '': ['z1'] },
    })
    expect(source.orders['p:a']).toEqual([sid('a2'), sid('a1')])
    expect(source.orders['']).toEqual([sid('z1')])
  })

  it('takes the expanded rows and the membership from the viewing state', () => {
    const sessions = [summary('a1'), summary('b1')]
    const input: GroupingInput = {
      providers: [prefixProvider('a')], list: list(...sessions), workspaces: [], expandedGroups: ['p:a'],
    }
    const source = deriveGroupingView(deriveGroupingData(input), { ...input, orderBy: 'updated', savedOrder: {} })
    expect(source.grouping.expanded).toEqual(['p:a'])
    // b1 is unclaimed, so it has no provider row and no membership.
    expect(source.grouping.membersByKey.has('p:b')).toBe(false)
    expect(source.grouping.membersByKey.get('p:a')?.map(item => item.id)).toEqual([sid('a1')])
  })
})

describe('GroupingService', () => {
  function bench(sessions: readonly SessionSummary[] = [], items: readonly WorkspaceView[] = []) {
    const ctx = new Context()
    contexts.push(ctx)
    const sessionStore = createSnapshotStore<SessionListState>(list(...sessions))
    const workspaceStore = createSnapshotStore<WorkspaceSnapshot>({
      items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    })
    ctx.provide('sessions', { list: sessionStore } as unknown as ISessions)
    ctx.provide('workspaces', { list: workspaceStore } as unknown as IWorkspaces)
    const service = new GroupingService(ctx)
    const source = service.snapshot({ orderBy: 'updated', savedOrder: {} })
    return { ctx, service, source, sessionStore, workspaceStore }
  }

  it('bounds the provider id to what a namespaced key can address', () => {
    const { service } = bench()
    expect(() => service.register({ id: '', resolve: () => undefined })).toThrow('unusable in a group key')
    expect(() => service.register({ id: 'a:b', resolve: () => undefined })).toThrow('unusable in a group key')
  })

  it('enumerates active provider keys and rejects a duplicate id', () => {
    const { service } = bench()
    service.register(prefixProvider('a'))
    service.register(otherProvider('z'))
    expect(service.providerIds()).toEqual(['p', 'q'])
    expect(() => service.register(prefixProvider('a'))).toThrow('already registered')
  })

  it('moves the revision on register and on dispose, and republishes the rows', () => {
    const { service, source } = bench([summary('a1')])
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    const before = source.getSnapshot()
    expect(service.revision()).toBe(0)

    const dispose = service.register(prefixProvider('a'))
    expect(service.revision()).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
    const withProvider = source.getSnapshot()
    expect(withProvider).not.toBe(before)
    expect(withProvider.grouping.rows.map(row => row.key)).toEqual(['p:a'])
    // One derivation per revision: a second read reuses the published source.
    expect(source.getSnapshot()).toBe(withProvider)

    dispose()
    expect(service.revision()).toBe(2)
    expect(source.getSnapshot().grouping.rows).toEqual([])
    // Disposal is idempotent and a second call must not move the revision again.
    dispose()
    expect(service.revision()).toBe(2)
    unsubscribe()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('republishes when the Session list or the Workspace baseline moves', () => {
    const { service, source, sessionStore, workspaceStore } = bench([summary('a1', { updatedAt: 1 })])
    service.register(prefixProvider('a'))
    const first = source.getSnapshot()
    expect(first.grouping.rows.map(row => row.key)).toEqual(['p:a'])
    expect(source.getSnapshot()).toBe(first)
    sessionStore.set(list(summary('a1', { updatedAt: 1 }), summary('a2', { updatedAt: 2 })))
    const second = source.getSnapshot()
    expect(second).not.toBe(first)
    expect(second.orders['p:a']).toEqual([sid('a2'), sid('a1')])
    // A Workspace baseline move is part of the derivation's inputs, so the
    // published source is replaced and its Workspace accounts follow it.
    workspaceStore.set({
      items: [workspace('w', ['a1'])], archivedSessionIds: [], pinnedSessionIds: [],
      state: 'idle', phase: 'ready', error: null,
    })
    const third = source.getSnapshot()
    expect(third).not.toBe(second)
    expect(third.grouping.rows.map(row => row.key)).toEqual(['p:a'])
    expect(source.getSnapshot()).toBe(third)
  })

  it('resolves a Session through the registered providers', () => {
    const { service } = bench()
    service.register(nestedProvider())
    expect(service.resolve(summary('a1'))?.map(element => element.key)).toEqual(['top', 'leaf'])
    expect(service.resolve(summary('b1'))).toBeUndefined()
  })

  it('keeps each subscription independent of the others', () => {
    const { service, source } = bench()
    const first = vi.fn()
    const second = vi.fn()
    const off = source.subscribe(first)
    source.subscribe(second)
    service.register(prefixProvider('a'))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    off()
    service.register(otherProvider('z'))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })
})

describe('deriveGroups with a grouping provider', () => {
  const view = (expandedGroups: readonly string[]): TreeView => ({ expandedGroups })

  it('leads the tree with provider rows carrying their label and no Workspace identity', () => {
    const sessions = [summary('a1'), summary('b1')]
    const groups = deriveGroups(
      list(...sessions), [workspace('w', ['a1', 'b1'])], noRows, noStatuses,
      view(['p:a', 'w']), sourceOf([prefixProvider('a')], sessions),
    )
    expect(groups.map(group => group.key)).toEqual(['p:a', 'w'])
    expect(groups[0]).toMatchObject({
      label: 'row-a', workspaceId: undefined, cwd: undefined, createdAt: undefined,
      sessionCount: 1, expanded: true, containsCurrent: false,
    })
    expect(groups[0]?.sessions.map(row => row.id)).toEqual([sid('a1')])
    expect(groups[1]?.sessions.map(row => row.id)).toEqual([sid('b1')])
  })

  it('nests a two-level path root first and keeps the Workspace for the unclaimed Session', () => {
    const sessions = [summary('a1'), summary('b1')]
    const groups = deriveGroups(
      list(...sessions), [workspace('w', ['a1', 'b1'])], noRows, noStatuses,
      view(['p:top', 'p:top:leaf', 'w']), sourceOf([nestedProvider()], sessions),
    )
    expect(groups.map(group => group.key)).toEqual(['p:top', 'p:top:leaf', 'w'])
    expect(groups[0]).toMatchObject({ key: 'p:top', label: 'Top', sessionCount: 0 })
    expect(groups[1]).toMatchObject({ key: 'p:top:leaf', label: 'Leaf', sessionCount: 1 })
    expect(groups[1]?.sessions.map(row => row.id)).toEqual([sid('a1')])
    expect(groups[2]?.sessions.map(row => row.id)).toEqual([sid('b1')])
  })

  it('drops a Workspace group whose visible members were all claimed', () => {
    const groups = deriveGroups(
      list(summary('a1')), [workspace('w', ['a1'])], noRows, noStatuses, view([]),
      sourceOf([prefixProvider('a')], [summary('a1')]),
    )
    expect(groups.map(group => group.key)).toEqual(['p:a'])
  })

  it('keeps an unclaimed Session on the core grouping', () => {
    const sessions = [summary('a1'), summary('z9')]
    const groups = deriveGroups(
      list(...sessions), [workspace('w', ['a1'])], noRows, noStatuses, view(['w', '']),
      sourceOf([prefixProvider('a')], sessions),
    )
    // z9 is loose in the core tree because no Workspace accounts for it.
    expect(groups.map(group => group.key)).toEqual(['p:a', ''])
    expect(groups[1]?.sessions.map(row => row.id)).toEqual([sid('z9')])
    expect(groups[1]).toMatchObject({ workspaceId: undefined, label: '' })
  })

  it('marks the provider row holding the selected Session, and not its ancestor', () => {
    const sessions = [summary('a1', { retainedBy: { mainView: 1 } })]
    const groups = deriveGroups(
      list(...sessions), [], noRows, noStatuses, view(['p:top', 'p:top:leaf']),
      sourceOf([nestedProvider()], sessions),
    )
    expect(groups.find(group => group.key === 'p:top:leaf')?.containsCurrent).toBe(true)
    expect(groups.find(group => group.key === 'p:top')?.containsCurrent).toBe(false)
  })

  it('keeps the selected Session on its Workspace group when no provider claims it', () => {
    const sessions = [summary('b1', { retainedBy: { mainView: 1 } })]
    const groups = deriveGroups(
      list(...sessions), [workspace('w', ['b1'])], noRows, noStatuses, view(['w']),
      sourceOf([nestedProvider()], sessions),
    )
    expect(groups.find(group => group.key === 'w')?.containsCurrent).toBe(true)
  })

  it('counts a provider group visible rows even while it is unexpanded', () => {
    const groups = deriveGroups(
      list(summary('a1')), [], noRows, noStatuses, view([]), sourceOf([prefixProvider('a')], [summary('a1')]),
    )
    expect(groups[0]).toMatchObject({ expanded: false, sessionCount: 1 })
    expect(groups[0]?.sessions.map(row => row.id)).toEqual([sid('a1')])
  })

  it('keeps a provider row out of the Workspace id space when the two would collide', () => {
    // The provider id equals the Workspace id, so only the namespace keeps the
    // provider row addressable as its own account.
    const collisions: GroupingProvider = {
      id: 'w',
      resolve: session => [{ key: session.id.slice(0, 1), label: `w-${session.id.slice(0, 1)}` }],
    }
    const sessions = [summary('a1'), summary('b1')]
    const groups = deriveGroups(
      list(...sessions), [workspace('w', ['a1', 'b1'])], noRows, noStatuses,
      view(['w:a', 'w:b']), sourceOf([collisions], sessions),
    )
    expect(groups.map(group => group.key)).toEqual(['w:a', 'w:b'])
    expect(groups[0]?.workspaceId).toBeUndefined()
    expect(groups.some(group => group.workspaceId === wid('w'))).toBe(false)
  })

  it('does not consult providers when no source is supplied', () => {
    const groups = deriveGroups(
      list(summary('a1')), [workspace('w', ['a1'])], noRows, noStatuses, view(['w']),
    )
    expect(groups.map(group => group.key)).toEqual(['w'])
    expect(groups[0]?.sessions.map(row => row.id)).toEqual([sid('a1')])
  })

  it('hides an archived Session from a provider row while the archived filter excludes it', () => {
    const sessions = [summary('a1'), summary('a2')]
    const groups = deriveGroups(
      list(...sessions), [], { ...noRows, archivedSessionIds: [sid('a2')] }, noStatuses, view(['p:a']),
      sourceOf([prefixProvider('a')], sessions),
    )
    expect(groups[0]?.sessions.map(row => row.id)).toEqual([sid('a1')])
    expect(groups[0]?.sessionCount).toBe(1)
  })

  it('lists a provider row whose members are all archived under the archived-only filter', () => {
    const sessions = [summary('a1', { blank: true })]
    const groups = deriveGroups(
      list(...sessions), [], { ...noRows, archivedSessionIds: [sid('a1')], archivedFilter: 'only' },
      noStatuses, view(['p:a']), sourceOf([prefixProvider('a')], sessions),
    )
    // The provider row is not a Workspace, so the archived-only empty-group rule
    // does not apply to it; its blank member stays hidden by the visibility rule.
    expect(groups.map(group => group.key)).toEqual(['p:a'])
    expect(groups[0]?.sessions).toEqual([])
  })
})

describe('groupKeyOf', () => {
  it('answers the claimed row key and the ungrouped bucket otherwise', () => {
    const input: GroupingInput = {
      providers: [prefixProvider('a')], list: list(summary('a1'), summary('z9')), workspaces: [], expandedGroups: [],
    }
    const data = deriveGroupingData(input)
    expect(groupKeyOf(data, sid('a1'))).toBe('p:a')
    expect(groupKeyOf(data, sid('z9'))).toBe('')
  })
})

describe('ownsGroup', () => {
  it('claims a Session for a provider row, including one the rows render conditionally', () => {
    const source = sourceOf([prefixProvider('a')], [summary('a1'), summary('a2', { blank: true })])
    expect(ownsGroup(source, sid('a1'))).toBe(true)
    // A blank Session is still claimed, so the Workspace account must not take it back.
    expect(ownsGroup(source, sid('a2'))).toBe(true)
    expect(ownsGroup(undefined, sid('a1'))).toBe(false)
  })
})

describe('pin order through the seam', () => {
  it('fronts a claimed Session in its provider row and leaves the Workspace account alone', () => {
    const sessions = [summary('a1'), summary('b1')]
    const workspaces = [workspace('w', ['a1', 'b1'])]
    const source = sourceOf([prefixProvider('a')], sessions)
    const listState = list(...sessions)
    expect(pinOrderAccounts(workspaces, sid('a1'), source)).toEqual(['p:a', FLAT_ORDER])
    expect(pinOrderAccounts(workspaces, sid('b1'), source)).toEqual(['w', FLAT_ORDER])
    const order = pinOrderSource(
      workspaces, listState, { pinnedSessionIds: [], archivedSessionIds: [] }, source,
    )
    // The claimed Session is a member of its provider row only.
    expect(Object.keys(order.members).sort()).toEqual(['', FLAT_ORDER, 'p:a', 'w'])
    expect(order.members['p:a']).toEqual([sid('a1')])
    expect(order.members.w).toEqual([sid('b1')])
    expect(order.members['']).toEqual([])
  })

  it('accounts a hidden claimed Session in its provider row, not in Ungrouped', () => {
    const sessions = [summary('a1', { blank: true })]
    const workspaces = [workspace('w', ['a1'])]
    const source = sourceOf([prefixProvider('a')], sessions)
    const order = pinOrderSource(
      workspaces, list(...sessions), { pinnedSessionIds: [], archivedSessionIds: [] }, source,
    )
    expect(order.members['p:a']).toEqual([sid('a1')])
    expect(order.members.w).toEqual([])
    expect(order.members['']).toEqual([])
  })

  it('leaves every account on the core grouping when no provider is registered', () => {
    const sessions = [summary('a1'), summary('z9')]
    const workspaces = [workspace('w', ['a1'])]
    const order = pinOrderSource(
      workspaces, list(...sessions), { pinnedSessionIds: [], archivedSessionIds: [] },
    )
    expect(Object.keys(order.members).sort()).toEqual(['', FLAT_ORDER, 'w'])
    expect(order.members.w).toEqual([sid('a1')])
    expect(order.members['']).toEqual([sid('z9')])
    expect(pinOrderAccounts(workspaces, sid('z9'))).toEqual(['', FLAT_ORDER])
  })
})
