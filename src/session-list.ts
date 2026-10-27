/** Read persisted title hints without activating sessions or loading their logs. */
import type { ListSessionsResponse } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-title'

/**
 * Add cached titles to the page selected by official ACP, retaining all other fields.
 * Missing checkpoints and individual read failures leave the original row intact.
 * @param ctx - persistence, projection cache, and diagnostic services from the ACP profile.
 * @param page - the successful official list response; upstream titles take precedence.
 * @param signal - cancels metadata reads when the transport closes.
 * @returns the same page selection, order, and cursor with available title hints.
 */
export async function withSessionTitles(
  ctx: Pick<Context, 'sessionPersistence' | 'sessionProjectionCache' | 'logger'>,
  page: ListSessionsResponse,
  signal: AbortSignal,
): Promise<ListSessionsResponse> {
  const sessions = await Promise.all(
    page.sessions.map(async (entry) => {
      if (entry.title != null) return entry
      try {
        signal.throwIfAborted()
        const stored = await ctx.sessionPersistence.stat(brandString<SessionId>(entry.sessionId), {
          signal,
        })
        signal.throwIfAborted()
        if (stored === undefined) return entry
        const cache = ctx.sessionProjectionCache
        const snapshot =
          cache.cachedSnapshot(stored.header, ['title']) ??
          cache.cachedPredecessorTitle(stored.header)
        const title = snapshot?.values.title
        return title == null ? entry : { ...entry, title }
      } catch (error) {
        if (!signal.aborted) {
          ctx.logger.warn(`Cannot read ACP list title for ${entry.sessionId}: ${String(error)}`)
        }
        return entry
      }
    }),
  )
  return { ...page, sessions }
}
