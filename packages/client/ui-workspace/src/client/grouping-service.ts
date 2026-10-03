/**
 * WorkspaceGroupingService (`ctx.workspaceGrouping`): the **Service
 * Definition** half of the Workspace browser's grouping seam. A client plugin
 * registers a {@link GroupingProvider} to decide which group rows own a
 * Session; the sidebar (the Consumer) reads the derived rows, membership and
 * labels, and never learns a provider's identity.
 *
 * Registration is an effect: the returned disposer removes the provider and
 * its rows. Every registration change moves one revision counter that the
 * published {@link WorkspaceGrouping.snapshot} observable carries, so a
 * provider arriving after the first render recomputes the tree once per
 * revision with no manual refresh.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  deriveGroupingData, deriveGroupingView, resolveSessionPath,
  type GroupingPathElement, type GroupingProvider, type GroupingRowDrop, type GroupingSource,
} from './grouping.ts'
import type { SessionOrderBy } from './tree.ts'

/** The viewing state one resolution of the published grouping snapshot reads. */
export interface GroupingSnapshotInput {
  /** Ordering mode the sidebar is showing. */
  readonly orderBy: SessionOrderBy
  /** Saved manual order per account key, including every provider row key. */
  readonly savedOrder: Readonly<Record<string, readonly string[]>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client grouping seam: registered providers decide which group rows own a Session. */
    workspaceGrouping: WorkspaceGrouping
  }
}

/** The grouping seam as its providers and its sidebar consumer see it. */
export interface WorkspaceGrouping {
  /**
   * Register one grouping provider.
   * @param provider - provider identity and its Session-to-path rule.
   * @returns the disposer that removes the provider and its rows.
   * @throws when the id is empty, contains `:`, or is already registered.
   */
  register(provider: GroupingProvider): () => void
  /**
   * The ids of the currently registered providers, in registration order.
   * @returns active provider keys.
   */
  providerIds(): readonly string[]
  /**
   * Resolve one Session through the providers.
   * @param session - current list summary for the Session.
   * @returns its claimed group path, or undefined to leave it on the core Workspace grouping.
   */
  resolve(session: SessionSummary): readonly GroupingPathElement[] | undefined
  /**
   * Whether one Session drop between two rows would reach a provider. The
   * sidebar calls this while the pointer is over a row, so a refused drop
   * shows the refusal instead of a marker that promises a move nobody owns.
   * @param event - the dragged Session with both row identities.
   * @returns true when exactly one provider owns the move.
   */
  canDrop(event: GroupingRowDrop): boolean
  /**
   * Hand one Session drop to the provider that owns the move. A drop no
   * provider owns does nothing: the refusal was already reported by
   * {@link WorkspaceGrouping.canDrop} before the Session was released.
   * @param event - the dropped Session with both row identities.
   */
  drop(event: GroupingRowDrop): void
  /**
   * The revision the published grouping snapshot is stamped with; it moves on
   * every provider registration change.
   * @returns the current revision.
   */
  revision(): number
  /**
   * The observable the sidebar's `useGrouping` hook binds to.
   * @param input - the viewing state one snapshot is derived with.
   * @returns a source republished whenever the revision, the Session list, or the Workspace baseline moves.
   */
  snapshot(input: GroupingSnapshotInput): HostObservable<GroupingSource>
  /**
   * Subscribe to registration changes, for a consumer that derives its own
   * source: the callback runs once per revision the seam moves.
   * @param listener - invalidation callback.
   * @returns unsubscribe.
   */
  onChange(listener: () => void): () => void
}

/** A registered provider that declares the drop handler a Session drop routes to. */
type DropOwner = GroupingProvider & { readonly drop: (event: GroupingRowDrop) => void }

/** One cached derivation: the two baselines and the revision it was built for. */
interface CachedSource {
  readonly revision: number
  readonly sessions: SessionListState
  readonly items: readonly WorkspaceView[]
  readonly source: GroupingSource
}

/** Implements the grouping seam over the client services the sidebar already reads. */
export class GroupingService extends Service implements WorkspaceGrouping {
  static inject = ['sessions', 'workspaces']

  private readonly providers: GroupingProvider[] = []
  private readonly listeners = new Set<() => void>()
  private revisionCounter = 0
  private cached: CachedSource | undefined

  /**
   * @param ctx - Client root Context.
   */
  constructor(ctx: Context) {
    super(ctx, 'workspaceGrouping')
  }

  register(provider: GroupingProvider): () => void {
    if (provider.id === '' || provider.id.includes(':')) {
      throw new Error(`workspaceGrouping.register: provider id "${provider.id}" is unusable in a group key`)
    }
    if (this.providers.some(registered => registered.id === provider.id)) {
      throw new Error(`workspaceGrouping.register: provider "${provider.id}" is already registered`)
    }
    this.providers.push(provider)
    this.invalidate()
    return () => {
      const at = this.providers.indexOf(provider)
      if (at < 0) return
      this.providers.splice(at, 1)
      this.invalidate()
    }
  }

  providerIds(): readonly string[] {
    return this.providers.map(provider => provider.id)
  }

  resolve(session: SessionSummary): readonly GroupingPathElement[] | undefined {
    return resolveSessionPath(this.providers, session)
  }

  canDrop(event: GroupingRowDrop): boolean {
    return this.dropTarget(event) !== undefined
  }

  drop(event: GroupingRowDrop): void {
    this.dropTarget(event)?.drop(event)
  }

  /**
   * The provider that owns one Session drop, already narrowed to the ones that
   * declare a handler: no caller ever holds a target it cannot dispatch to. A
   * provider row routes to its own provider; a core row routes to the provider
   * the Session came from, which is what releases a claimed Session back to the
   * core grouping. A drop is refused when no provider is named, when the two
   * rows belong to different providers, and when the named provider is not
   * registered or declares no drop handler.
   */
  private dropTarget(event: GroupingRowDrop): DropOwner | undefined {
    const { source, target } = event
    if (target.providerId !== undefined && source.providerId !== undefined
      && source.providerId !== target.providerId) return undefined
    const owner = target.providerId ?? source.providerId
    return this.providers.find(
      (candidate): candidate is DropOwner => candidate.id === owner && candidate.drop !== undefined,
    )
  }

  revision(): number {
    return this.revisionCounter
  }

  snapshot(input: GroupingSnapshotInput): HostObservable<GroupingSource> {
    return {
      getSnapshot: () => this.source(input),
      subscribe: (listener) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * The derived source for one viewing state, rebuilt only when the revision,
   * the Session list, or the Workspace baseline moved.
   */
  private source(input: GroupingSnapshotInput): GroupingSource {
    const list = this.sessions().list.getSnapshot()
    const workspaces = this.workspaces().list.getSnapshot()
    const cached = this.cached
    if (cached !== undefined && cached.revision === this.revisionCounter
      && cached.sessions === list && cached.items === workspaces.items) return cached.source
    const base = {
      providers: this.providers,
      list,
      workspaces: workspaces.items,
      expandedGroups: [] as readonly string[],
    }
    const source = deriveGroupingView(deriveGroupingData(base), { ...base, ...input })
    this.cached = { revision: this.revisionCounter, sessions: list, items: workspaces.items, source }
    return source
  }

  private sessions(): ISessions {
    return this.ctx.get('sessions') as ISessions
  }

  private workspaces(): IWorkspaces {
    return this.ctx.get('workspaces') as IWorkspaces
  }

  private invalidate(): void {
    this.revisionCounter += 1
    this.cached = undefined
    for (const listener of [...this.listeners]) listener()
  }
}
