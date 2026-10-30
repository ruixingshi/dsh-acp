// Adapted from DeepSeek Harness (MIT); see THIRD_PARTY_NOTICES.md.
/** Standard ACP MCP-server declarations translated into Agent-scoped DSH MCP clients. */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { isAbsolute } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

const VALID_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Caller-correctable MCP declaration failure. */
export class AcpMcpConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpMcpConfigError'
  }
}

/**
 * Validate and mount one session's complete standard MCP server list before Agent publication.
 * @param agentCtx - unpublished Agent scope that owns the MCP clients and tools.
 * @param servers - stable ACP stdio or HTTP server declarations.
 * @param sessionCwd - canonical primary workspace used by stdio servers.
 */
export async function mountAcpMcpServers(
  agentCtx: Context,
  servers: readonly McpServer[],
  sessionCwd: string,
): Promise<McpMount> {
  const mount = new McpMount(agentCtx, sessionCwd)
  await mount.replace(servers)
  return mount
}

/** Own the session's MCP mounts; replacement happens between foreground turns. */
export class McpMount {
  private fibers: Fiber[] = []
  private configs: McpClient.Config[] = []
  private failure: Error | undefined
  constructor(
    private readonly ctx: Context,
    private readonly cwd: string,
  ) {}

  assertReady(): void {
    if (this.failure !== undefined) throw this.failure
  }

  async replace(servers: readonly McpServer[]): Promise<void> {
    this.assertReady()
    const next = resolveMcpConfigs(servers, this.cwd)
    const previous = this.configs
    try {
      await this.dispose()
    } catch (error) {
      this.failure = new Error('MCP teardown failed; close this session', { cause: error })
      throw this.failure
    }
    try {
      await this.load(next)
      this.configs = next
    } catch (error) {
      try {
        await this.dispose()
        await this.load(previous)
      } catch (rollbackError) {
        this.failure = new AggregateError(
          [error, rollbackError],
          'MCP replacement and rollback failed; close this session',
        )
        throw this.failure
      }
      throw error
    }
  }

  private async load(configs: McpClient.Config[]): Promise<void> {
    for (const config of configs) {
      const fiber = this.ctx.plugin(McpClient, config)
      this.fibers.push(fiber)
      await fiber
    }
  }

  private async dispose(): Promise<void> {
    const results = await Promise.allSettled(this.fibers.map((fiber) => fiber.dispose()))
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result): unknown => result.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'MCP cleanup failed')
    this.fibers = []
  }
}

/** Convert the stable stdio/HTTP ACP transports and reject every other transport. */
function resolveMcpConfigs(servers: readonly McpServer[], sessionCwd: string): McpClient.Config[] {
  const names = new Set<string>()
  return servers.map((server, index) => {
    const serverName = normalizeServerName(server.name)
    if (names.has(serverName)) {
      throw new AcpMcpConfigError(`mcpServers contains duplicate normalized name: ${serverName}`)
    }
    names.add(serverName)
    if (!('type' in server)) {
      if (!isAbsolute(server.command)) {
        throw new AcpMcpConfigError(`mcpServers[${index}].command must be an absolute path`)
      }
      const env = entriesToRecord(server.env, `mcpServers[${index}].env`, 'environment')
      const config = validateClientConfig(index, () =>
        McpClient.Config({
          transport: 'stdio',
          serverName,
          command: server.command,
          args: server.args,
          env,
          cwd: sessionCwd,
          failOnStartupError: true,
        }),
      )
      return { ...config, env }
    }
    if (server.type === 'http') {
      assertHttpUrl(server.url, `mcpServers[${index}].url`)
      const headers = entriesToRecord(server.headers, `mcpServers[${index}].headers`, 'header')
      const config = validateClientConfig(index, () =>
        McpClient.Config({
          transport: 'streamable-http',
          serverName,
          url: server.url,
          headers,
          failOnStartupError: true,
        }),
      )
      return { ...config, headers }
    }
    throw new AcpMcpConfigError(`mcpServers[${index}] transport ${server.type} is not supported`)
  })
}

/** Convert ordered ACP name/value entries without silently accepting duplicate keys. */
function entriesToRecord(
  entries: readonly { name: string; value: string }[],
  field: string,
  kind: 'environment' | 'header',
): Record<string, string> {
  // Valid environment and header names include "__proto__"; a null prototype
  // keeps that entry as data instead of invoking Object.prototype's setter.
  const result = Object.create(null) as Record<string, string>
  const names = new Set<string>()
  for (const entry of entries) {
    if (kind === 'header') {
      try {
        validateHeaderName(entry.name)
        validateHeaderValue(entry.name, entry.value)
      } catch (_invalidHeader) {
        throw new AcpMcpConfigError(`${field} contains an invalid header entry`)
      }
    } else if (
      entry.name.length === 0 ||
      entry.name.includes('=') ||
      entry.name.includes('\0') ||
      entry.value.includes('\0')
    ) {
      throw new AcpMcpConfigError(`${field} contains an invalid environment entry`)
    }
    const identity = kind === 'header' ? entry.name.toLowerCase() : entry.name
    if (names.has(identity))
      throw new AcpMcpConfigError(`${field} contains duplicate name: ${entry.name}`)
    names.add(identity)
    result[entry.name] = entry.value
  }
  return result
}

/** Produce a stable DSH tool namespace from ACP's human-readable server name. */
function normalizeServerName(name: string): string {
  if (
    name.trim().length === 0 ||
    Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new AcpMcpConfigError('mcpServers contains an invalid server name')
  }
  if (VALID_SERVER_NAME.test(name)) return name
  const slug =
    name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) || 'server'
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${slug}_${digest}`.slice(0, 32)
}

/** Require the stable Streamable HTTP transport URL schemes. */
function assertHttpUrl(value: string, field: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('unsupported protocol')
  } catch (_invalidUrl) {
    throw new AcpMcpConfigError(`${field} must be an absolute HTTP(S) URL`)
  }
}

/** Map the existing MCP provider's schema error into ACP invalid params. */
function validateClientConfig(index: number, parse: () => McpClient.Config): McpClient.Config {
  try {
    return parse()
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AcpMcpConfigError(`mcpServers[${index}] is invalid: ${detail}`)
  }
}
