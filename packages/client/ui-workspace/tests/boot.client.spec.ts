// @vitest-environment jsdom
import { describe, expect } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  createClientTest, ClientRoster, webApp, type ClientPluginModule,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { GroupingSource } from '../src/client/grouping.ts'
import type { WorkspaceGrouping } from '../src/client/grouping-service.ts'

const SELF = '@deepseek-ai/dsh-client-ui-workspace'
/** The test's own grouping provider, composed as the bundle composes a plugin row. */
const PROVIDER_ROW = 'boot-grouping-provider'

const providerRow: ClientPluginModule = {
  inject: ['slots', 'sessions', 'workspaces', 'workspaceGrouping'],
  apply(ctx: Context) {
    const grouping = ctx.get('workspaceGrouping') as WorkspaceGrouping
    ctx.effect(() => grouping.register({
      id: 'boot',
      resolve: session => session.id.startsWith('boot')
        ? [{ key: 'k', label: 'K', order: 1 }, { key: 'group', label: 'Group' }]
        : undefined,
    }), 'boot-spec: grouping provider')
  },
}

const test = createClientTest({
  roster: ClientRoster.of([
    ...webApp.closure([SELF]).rows,
    { name: PROVIDER_ROW, inject: ['workspaceGrouping'], immediately: false },
  ]),
  provide: { [PROVIDER_ROW]: providerRow },
})

const sid = (id: string): SessionId => id as SessionId

describe('ui-workspace grouping seam, booted through the Web profile composition', () => {
  test('the Loader activates the service, and a provider row registered from another plugin reaches the published tree', async ({ start }) => {
    const client = await start()
    // The service exists because the Loader activated the ui-workspace row of
    // the Web profile composition, not because this spec built a context.
    const grouping = client.ctx.get('workspaceGrouping') as WorkspaceGrouping
    expect(grouping).toBeDefined()
    expect(grouping.providerIds()).toEqual(['boot'])
    expect(grouping.revision()).toBeGreaterThan(0)

    const summary: SessionSummary = {
      id: sid('boot-a'), displayTitle: 'boot-a', running: false, blank: false, updatedAt: 1, retainedBy: {},
    }
    expect(grouping.resolve(summary)?.map(element => element.key)).toEqual(['k', 'group'])
    expect(grouping.resolve({ ...summary, id: sid('other') })).toBeUndefined()

    // The same observable the sidebar's `useGrouping` hook binds to: one
    // snapshot per revision, and it republishes when the provider leaves.
    const source: HostObservable<GroupingSource> = grouping.snapshot({ orderBy: 'updated', savedOrder: {} })
    const before = source.getSnapshot()
    expect(source.getSnapshot()).toBe(before)

    await client.unload(PROVIDER_ROW)
    expect(grouping.providerIds()).toEqual([])
    expect(source.getSnapshot()).not.toBe(before)
    expect(source.getSnapshot().grouping.rows).toEqual([])
    await client.dispose()
  })
})
