/**
 * The Workspace browser's grouping seam: everything a registered **grouping
 * provider** decides, and every derivation the sidebar consumes from it.
 *
 * A provider answers one question for one Session — which root-to-leaf path of
 * group rows owns it — and the seam turns those answers into the sibling rows
 * the sidebar renders, the membership each row accounts for, and the leaf label
 * a search result shows. Arrival order of answers is never significant: rows,
 * membership and labels are all derived from the current set of providers, so
 * an insertion cannot disturb an existing answer.
 *
 * Row identity is a **provider-namespaced path**: a row's key is
 * `<providerId>:<root element key>[:<element key>]…` down to that row, so a
 * provider row can never collide with a Workspace id, with the ungrouped
 * bucket, or with a row under another branch. A provider id and an element key
 * therefore may not contain `:`.
 *
 * Modal rules: providers are consulted only by the grouped derivation
 * (`deriveGroups`). The `workspace-tree` mode keeps nesting Workspace rows and
 * never nests a provider row further, and the `flat` mode ignores providers
 * entirely. A Session no provider claims keeps the core Workspace grouping.
 */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { orderByRecency, reconcileManualOrder, type SessionOrderBy } from './tree.ts'

/** The key behind the root-level "Ungrouped" bucket (the empty string). */
const UNGROUPED_KEY = ''

/**
 * One level of a provider answer: the group row a Session sits in, plus the
 * label and sibling position that row renders with.
 */
export interface GroupingPathElement {
  /** Provider-local row identity; the seam namespaces it under the provider. */
  readonly key: string
  /** Row label shown verbatim; never localized by this package. */
  readonly label: string
  /** Ascending position among its siblings; omitted sorts as `0`, ties by key. */
  readonly order?: number
}

/** One registered grouping provider. */
export interface GroupingProvider {
  /** Stable provider identity; must be non-empty and free of `:`. */
  readonly id: string
  /**
   * Resolve the group path owning one Session, root first.
   * @param session - current list summary for the Session being resolved.
   * @returns the path of rows, or `undefined` to leave the Session on the core Workspace grouping.
   */
  readonly resolve: (session: SessionSummary) => readonly GroupingPathElement[] | undefined
}

/** One derived group row, in provider path order. */
export interface GroupingNode {
  /** Namespaced path key, unique across every provider. */
  readonly key: string
  /** Parent row key, or `undefined` for a root row of the provider's tree. */
  readonly parentKey: string | undefined
  readonly label: string
  readonly order: number
  /** The provider that contributed this row. */
  readonly providerId: string
  /** The provider-local key of this level. */
  readonly localKey: string
}

/** One Session assignment the listed providers produced. */
export interface GroupingAssignment {
  /** The Session the provider claimed. */
  readonly sessionId: SessionId
  /** The namespaced key of the deepest row owning it. */
  readonly key: string
  /** The provider that claimed it. */
  readonly providerId: string
}

/** The registry state and Workspace baselines one derivation reads. */
export interface GroupingInput {
  /** Registered providers, in registration order. */
  readonly providers: readonly GroupingProvider[]
  /** Current list snapshot; Sessions without a summary are not resolvable yet. */
  readonly list: SessionListState
  /** Current Host Workspaces, for the core fallback's membership and labels. */
  readonly workspaces: readonly WorkspaceView[]
  /** Explicit group expansion from the browser's viewing store. */
  readonly expandedGroups: readonly string[]
}

/** Every derived fact the grouped sidebar and its order accounts read. */
export interface GroupingData {
  /** Provider rows in render order (roots first, each subtree in sibling order). */
  readonly nodes: readonly GroupingNode[]
  /** Assignments of resolvable Sessions, in list order. */
  readonly assignments: readonly GroupingAssignment[]
  /**
   * Membership per provider row: every resolvable claimed Session of that row,
   * including the archived and blank rows the caller renders conditionally.
   * These are the sessions a manual-order record must carry.
   */
  readonly members: ReadonlyMap<string, readonly SessionSummary[]>
  /** Row keys on the path of at least one claimed Session. */
  readonly visibleKeys: ReadonlySet<string>
  /** Complete membership of the ungrouped bucket, in list order. */
  readonly ungrouped: readonly SessionSummary[]
  /** Complete membership of one Workspace account, in list order. */
  readonly workspaceMembers: ReadonlyMap<WorkspaceId, readonly SessionSummary[]>
}

/** One grouping revision projected into what the sidebar consumes. */
export interface GroupingSource {
  /** Grouping state projected into the children the sidebar renders. */
  readonly grouping: {
    readonly rows: readonly GroupingNode[]
    readonly expanded: readonly string[]
    /** Membership per provider row key, for the manual-order accounts. */
    readonly membersByKey: ReadonlyMap<string, readonly SessionSummary[]>
  }
  /** Claimed Session to its row label, so a search result names the group the tree shows. */
  readonly labelsBySession: ReadonlyMap<SessionId, string>
  /** Order account per provider row key and for the ungrouped bucket. */
  readonly orders: Readonly<Record<string, readonly SessionId[]>>
}

/**
 * The namespaced key of one provider-local element at one path position.
 * @param providerId - the contributing provider.
 * @param parentKey - the namespaced key of the element's parent, or undefined at the root.
 * @param localKey - the element's provider-local key.
 * @returns the namespaced key.
 */
export function providerKey(providerId: string, parentKey: string | undefined, localKey: string): string {
  return `${parentKey ?? providerId}:${localKey}`
}

/**
 * Whether a group key belongs to this provider's namespace.
 * @param providerId - provider id to test.
 * @param key - group key.
 * @returns true when the key is namespaced under the provider.
 */
export function isProviderKeyOf(providerId: string, key: string): boolean {
  return key.startsWith(`${providerId}:`)
}

/**
 * Whether a group key names a provider row rather than a Workspace, the
 * ungrouped bucket, or the flat list's order account.
 * @param key - group key to classify.
 * @param providers - currently registered providers.
 * @returns true when the key is namespaced by one of them.
 */
export function isProviderGroupKey(key: string, providers: readonly GroupingProvider[]): boolean {
  return providers.some(provider => isProviderKeyOf(provider.id, key))
}

/**
 * Every key on the path to and including a group row, root first.
 * @param nodes - derived provider rows.
 * @param key - the row to walk up from.
 * @returns the ancestor chain (empty when the key is not a provider row).
 */
export function providerKeyAncestors(nodes: readonly GroupingNode[], key: string): string[] {
  const byKey = new Map(nodes.map(node => [node.key, node]))
  const chain: string[] = []
  for (let node = byKey.get(key); node !== undefined; node = node.parentKey === undefined ? undefined : byKey.get(node.parentKey)) {
    chain.push(node.key)
  }
  return chain.reverse()
}

/**
 * The group key currently owning a Session.
 * @param data - one grouping derivation.
 * @param sessionId - Session to locate.
 * @returns its claimed row key, or the ungrouped bucket key.
 */
export function groupKeyOf(data: GroupingData, sessionId: SessionId): string {
  return data.assignments.find(assignment => assignment.sessionId === sessionId)?.key ?? UNGROUPED_KEY
}

/**
 * Resolve one Session through the providers, in registration order.
 * @param providers - registered providers in precedence order.
 * @param session - current list summary for the Session.
 * @returns the path of valid elements the first claiming provider answered, or undefined.
 */
export function resolveSessionPath(
  providers: readonly GroupingProvider[],
  session: SessionSummary,
): readonly GroupingPathElement[] | undefined {
  return claimSession(providers, session)?.path
}

/**
 * The first provider that claims one Session, with its validated path. A
 * provider is called exactly once per resolution.
 */
function claimSession(
  providers: readonly GroupingProvider[],
  session: SessionSummary,
): { readonly providerId: string; readonly path: readonly GroupingPathElement[] } | undefined {
  for (const provider of providers) {
    const answer = provider.resolve(session)
    if (answer === undefined) continue
    const valid = answer.filter(element => element.key !== '' && !element.key.includes(':'))
    return valid.length === 0 ? undefined : { providerId: provider.id, path: valid }
  }
  return undefined
}

/** Mutable per-key accumulation while a derivation walks the list. */
interface PendingRow {
  readonly key: string
  readonly parentKey: string | undefined
  readonly providerId: string
  readonly localKey: string
  label: string
  /** Declared sibling position, or undefined when the element omitted it. */
  readonly order: number | undefined
  readonly chain: readonly string[]
}

/**
 * Derive the provider rows, the assignments, and every account's membership
 * from the current providers and Workspace baselines.
 * @param input - registered providers plus the current list and Workspace state.
 * @returns the grouping data one sidebar derivation reads.
 */
export function deriveGroupingData(input: GroupingInput): GroupingData {
  const summaries = new Map<SessionId, SessionSummary>(
    /* v8 ignore next -- every listed id has a matching row in the same snapshot. */
    input.list.ids.flatMap(id => (id in input.list.byId ? [[id, input.list.byId[id] as SessionSummary] as const] : [])),
  )
  const pending = new Map<string, PendingRow>()
  const assignments: GroupingAssignment[] = []
  for (const [sessionId, summary] of summaries) {
    const claimed = claimSession(input.providers, summary)
    if (claimed === undefined) continue
    const { providerId, path } = claimed
    const chain: string[] = []
    let parentKey: string | undefined
    for (const element of path) {
      const key = providerKey(providerId, parentKey, element.key)
      const existing = pending.get(key)
      if (existing === undefined) {
        pending.set(key, {
          key, parentKey, providerId, localKey: element.key,
          label: element.label, order: element.order, chain: [...chain, key],
        })
      } else if (existing.label === '') existing.label = element.label
      chain.push(key)
      parentKey = key
    }
    // `path` is non-empty, so the walk above always pushed a leaf key.
    /* v8 ignore next 2 -- a non-empty path always pushes a leaf key. */
    const leaf = chain[chain.length - 1] as string
    assignments.push({ sessionId, key: leaf, providerId })
  }
  const members = new Map<string, SessionSummary[]>()
  const visibleKeys = new Set<string>()
  const accounted = new Set<SessionId>()
  for (const assignment of assignments) {
    // Assignments are built from this same summary map above.
    /* v8 ignore next 3 -- the assignment's id and leaf key both come from the walk above. */
    const summary = summaries.get(assignment.sessionId) as SessionSummary
    const claimed = pending.get(assignment.key) as PendingRow
    accounted.add(summary.id)
    for (const key of claimed.chain) visibleKeys.add(key)
    const bucket = members.get(assignment.key)
    if (bucket === undefined) members.set(assignment.key, [summary])
    else bucket.push(summary)
  }
  const workspaceMembers = new Map<WorkspaceId, readonly SessionSummary[]>()
  for (const workspace of input.workspaces) {
    workspaceMembers.set(workspace.workspaceId, workspace.sessionIds.flatMap((id) => {
      const summary = summaries.get(id)
      return summary === undefined || accounted.has(id) ? [] : [summary]
    }))
  }
  const ungrouped = [...summaries.values()].filter(summary => !accounted.has(summary.id))
  const nodes = orderRows([...pending.values()]).map(row => ({
    key: row.key,
    parentKey: row.parentKey,
    label: row.label,
    order: row.order ?? 0,
    providerId: row.providerId,
    localKey: row.localKey,
  }))
  return { nodes, assignments, members, visibleKeys, ungrouped, workspaceMembers }
}

/** Sibling order: declared order first, then key, so equal orders stay stable. */
function compareRows(a: PendingRow, b: PendingRow): number {
  const left = a.order ?? 0
  const right = b.order ?? 0
  if (left !== right) return left - right
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/**
 * Row order by depth-first walk: a parent precedes its own subtree, and
 * siblings follow the declared order, so a nested path renders root first even
 * when a child declares a smaller order than its parent.
 */
function orderRows(rows: readonly PendingRow[]): PendingRow[] {
  const byKey = new Map(rows.map(row => [row.key, row]))
  const children = new Map<string | undefined, PendingRow[]>()
  for (const row of rows) {
    const parent = row.parentKey !== undefined && byKey.has(row.parentKey) ? row.parentKey : undefined
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [row])
    else siblings.push(row)
  }
  const ordered: PendingRow[] = []
  const walk = (parent: string | undefined): void => {
    for (const row of (children.get(parent) ?? []).sort(compareRows)) {
      ordered.push(row)
      walk(row.key)
    }
  }
  walk(undefined)
  return ordered
}

/**
 * Project one derivation into the shape the sidebar's business components
 * consume: the rows in render order, each row's membership, the label a search
 * result shows, and the order accounts a manual order is written against.
 * @param data - one grouping derivation.
 * @param input - the derivation's inputs (expansion, order mode, saved order).
 * @returns the projected grouping source.
 */
export function deriveGroupingView(
  data: GroupingData,
  input: GroupingInput & {
    /** Ordering mode; `manual` reads the saved order account. */
    readonly orderBy: SessionOrderBy
    /** Saved manual order per account key (provider rows and the ungrouped bucket). */
    readonly savedOrder: Readonly<Record<string, readonly string[]>>
  },
): GroupingSource {
  const orders: Record<string, readonly SessionId[]> = {}
  const labelsBySession = new Map<SessionId, string>()
  for (const node of data.nodes) {
    const members = data.members.get(node.key) ?? []
    for (const member of members) labelsBySession.set(member.id, node.label)
    orders[node.key] = orderedMembers(
      members, input.orderBy, input.savedOrder[node.key], input.list.byId,
    ).map(summary => summary.id)
  }
  orders[UNGROUPED_KEY] = input.orderBy === 'updated'
    ? orderByRecency(data.ungrouped.map(summary => summary.id), input.list.byId)
    : reconcileManualOrder(
      data.ungrouped.map(summary => summary.id),
      input.savedOrder[UNGROUPED_KEY],
      input.list.byId,
    )
  return {
    grouping: {
      rows: data.nodes,
      expanded: input.expandedGroups,
      membersByKey: data.members,
    },
    labelsBySession,
    orders,
  }
}

/** One account's members in the selected mode, saved positions first. */
function orderedMembers(
  members: readonly SessionSummary[],
  orderBy: SessionOrderBy,
  saved: readonly string[] | undefined,
  summaries: SessionListState['byId'],
): readonly SessionSummary[] {
  const byId = new Map(members.map(summary => [summary.id as string, summary]))
  const ids = orderBy === 'updated'
    ? orderByRecency(members.map(summary => summary.id), summaries)
    : reconcileManualOrder(members.map(summary => summary.id), saved, summaries)
  return ids.flatMap((id) => {
    const summary = byId.get(id)
    return summary === undefined ? [] : [summary]
  })
}

/**
 * Parent row key per provider row key, for the slots that nest rendered rows.
 * @param rows - derived provider rows.
 * @returns the parent of each nested row.
 */
export function groupingParents(rows: readonly GroupingNode[]): ReadonlyMap<string, string> {
  return new Map(rows.flatMap(row => row.parentKey === undefined ? [] : [[row.key, row.parentKey] as const]))
}
