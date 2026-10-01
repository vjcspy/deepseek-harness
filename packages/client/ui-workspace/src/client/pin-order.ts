/**
 * The complete account memberships a Pin order write reconciles against,
 * derived from the same Host snapshots the browser orders by, so the
 * UiWorkspace service can complete the write without the browser in the loop.
 *
 * A Session a registered grouping provider claims belongs to that provider's
 * row instead of its Workspace account, so a pin fronts it in the provider row
 * and not in a Workspace group the browser does not render it in.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { FLAT_SESSION_ORDER_KEY } from './stores.ts'
import { sessionMemberIds, type SessionRowState, UNGROUPED_KEY } from './tree.ts'
import type { GroupingSource } from './grouping.ts'

/** What `pinSessionOrder` reconciles a pinned Session's accounts against. */
export interface PinOrderSource {
  members: Readonly<Record<string, readonly SessionId[]>>
  summaries: SessionListState['byId']
  rowState: Pick<SessionRowState, 'pinnedSessionIds' | 'archivedSessionIds'>
}

/**
 * Every account's complete membership: each provider row, each Workspace,
 * Ungrouped, and the flat list.
 * @param workspaces - current Host Workspaces.
 * @param list - current Session list snapshot.
 * @param rowState - registry-global pin and archive sets.
 * @param grouping - current provider derivation; an absent source claims nothing.
 * @returns the order source for one pin write.
 */
export function pinOrderSource(
  workspaces: readonly WorkspaceView[],
  list: SessionListState,
  rowState: PinOrderSource['rowState'],
  grouping?: GroupingSource,
): PinOrderSource {
  const claimed = groupingClaim(grouping)
  const accounted = new Set(workspaces.flatMap(workspace => workspace.sessionIds))
  const providerKeys = new Set(claimed.values())
  return {
    members: Object.fromEntries([
      ...[...providerKeys].map(key => [key, grouping?.orders[key] ?? []] as const),
      ...workspaces.map(workspace => [workspace.workspaceId, workspace.sessionIds.filter((id) => {
        const claim = claimed.get(id)
        return claim === undefined || claim === UNGROUPED_KEY
      })] as const),
      [UNGROUPED_KEY, list.ids.filter(id => list.byId[id] !== undefined && !accounted.has(id)
        && !isClaimed(claimed, id))],
      [FLAT_SESSION_ORDER_KEY, sessionMemberIds(list)],
    ]),
    summaries: list.byId,
    rowState,
  }
}

/**
 * The accounts a pinned Session leads: its provider row (or its Workspace, or
 * Ungrouped) and the flat list.
 * @param workspaces - current Host Workspaces.
 * @param sessionId - the Session being pinned.
 * @param grouping - current provider derivation; an absent source claims nothing.
 * @returns the account keys `pinSessionOrder` fronts.
 */
export function pinOrderAccounts(
  workspaces: readonly WorkspaceView[],
  sessionId: SessionId,
  grouping?: GroupingSource,
): readonly string[] {
  const claim = groupingClaim(grouping).get(sessionId)
  const own = claim !== undefined && claim !== UNGROUPED_KEY
    ? claim
    : workspaces.find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId ?? UNGROUPED_KEY
  return [own, FLAT_SESSION_ORDER_KEY]
}

/** Whether a Session is claimed by any provider row. */
function isClaimed(claimed: ReadonlyMap<SessionId, string>, sessionId: SessionId): boolean {
  const claim = claimed.get(sessionId)
  return claim !== undefined && claim !== UNGROUPED_KEY
}

/** Claimed Session to provider row key, over each row's complete membership. */
function groupingClaim(grouping: GroupingSource | undefined): Map<SessionId, string> {
  const claimed = new Map<SessionId, string>()
  for (const row of grouping?.grouping.rows ?? []) {
    for (const member of grouping?.grouping.membersByKey.get(row.key) ?? []) {
      if (!claimed.has(member.id)) claimed.set(member.id, row.key)
    }
  }
  return claimed
}
