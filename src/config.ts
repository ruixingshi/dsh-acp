/** Configuration shared by the direct ACP v1/v2 adapters. */
import Schema from '@deepseek-ai/schemastery'
import type { Stream } from '@agentclientprotocol/sdk/experimental/v2'

export interface DshAcpConfig {
  provider?: string
  model?: string
  sessionListPageSize?: number
  /** Runtime-only transport override for embedded hosts and tests. */
  stream?: Stream
}

export const Config: Schema<DshAcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  sessionListPageSize: Schema.natural().min(1).default(100),
})
