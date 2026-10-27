/** Official Harness ACP with standard plan, title, and tool-category display updates. */
import type { Context } from '@deepseek-ai/cordis'
import {
  Config,
  apply as applyOfficial,
  inject as officialInject,
  type AcpConfig,
} from '@deepseek-ai/dsh-acp'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { PresentationStream } from './presentation-stream.js'

export { Config }
export type { AcpConfig as DshAcpConfig }
/** Cordis plugin name. */
export const name = 'dsh-acp'
/** Official runtime services plus live projections and persisted title checkpoints. */
export const inject = [...officialInject, 'sessionProjections', 'sessionProjectionCache']

/**
 * Mount the official server; its cleanup completes before display transport disposal.
 * @param ctx - context from the Harness ACP profile.
 * @param config - official ACP settings, including an optional in-process transport.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  ctx.effect(() => {
    const transport =
      config.stream ??
      ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
      )
    const presentation = new PresentationStream(ctx, transport)
    // Also release transport locks if the official plugin throws during activation.
    ctx.effect(() => () => presentation.dispose(), 'dsh-acp.transport')
    const disposeOfficial = ctx.effect(() => {
      applyOfficial(ctx, { ...config, stream: presentation.stream })
      return () => undefined
    }, 'dsh-acp.official')
    return async () => {
      // Display cleanup still runs if official persistence or Agent disposal fails.
      try {
        await disposeOfficial()
      } finally {
        await presentation.dispose()
      }
    }
  }, 'dsh-acp.presentation')
}
