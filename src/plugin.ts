/** Cordis plugin that mounts the rich ACP server on stdio. */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { CordisHarnessRuntime } from './harness-runtime.js'
import { DshAcpServer } from './server.js'

/** Cordis plugin name used in loader diagnostics. */
export const name = 'rich-acp'

/** The adapter captures the agent factory and model registry during startup. */
export const inject = ['agents', 'llm']

/** Initial route and optional transport for one adapter process. */
export interface DshAcpConfig {
  /** Registered Harness provider id. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Optional reasoning effort used for newly created sessions. */
  reasoningEffort?: string
  /** Runtime-only transport override for embedded use and tests. */
  stream?: Stream
}

/** Validated loader configuration. */
export const Config: Schema<DshAcpConfig> = Schema.object({
  provider: Schema.string().required(),
  model: Schema.string().required(),
  reasoningEffort: Schema.string(),
})

/**
 * Mount one ACP v1 connection over stdio or an injected transport.
 * @param ctx - Cordis context carrying the Harness agent and LLM services.
 * @param config - Initial model route for fresh ACP sessions.
 */
export function apply(ctx: Context, config: DshAcpConfig): void {
  const runtime = new CordisHarnessRuntime(ctx)
  const server = new DshAcpServer(
    runtime,
    {
      initialSelection: {
        provider: config.provider,
        model: config.model,
        ...(config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: config.reasoningEffort }),
      },
    },
    { warn: (message) => ctx.logger.warn(message) },
  )
  const stream =
    config.stream ??
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    )
  server.connect(stream)
  ctx.effect(() => () => server.dispose(), 'rich-acp.connection')
}
