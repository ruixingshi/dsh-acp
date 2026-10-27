/** Exercise the published launcher and official ACP profile through its wire API. */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  client,
  methods,
  ndJsonStream,
  type McpServer,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

const bin =
  process.env.DSH_ACP_TEST_BIN ?? fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const patch = fileURLToPath(new URL('./fixtures/official/acp.patch.yml', import.meta.url))
const mcp = fileURLToPath(new URL('./fixtures/official/mcp.mjs', import.meta.url))
const mcpServers: McpServer[] = [
  { name: 'fixture', command: process.execPath, args: [mcp], env: [] },
]

function launch(cwd: string) {
  const child = spawn(process.execPath, [bin, '--patch', patch], {
    cwd,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
      DSH_HOME: join(cwd, '.dsh'),
      DSH_ACP_TEST_SESSIONS: join(cwd, '.sessions'),
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'read-only',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  const diagnostics: string[] = []
  const raw: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => diagnostics.push(chunk))
  child.stdout.on('data', (chunk: Buffer) => raw.push(chunk.toString('utf8')))
  const updates: SessionUpdate[] = []
  const permissions: RequestPermissionRequest[] = []
  const listeners = new Set<(update: SessionUpdate) => void>()
  const connection = client({ name: 'profile-compatibility-test' })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update)
      for (const listener of listeners) listener(params.update)
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissions.push(params)
      const option = params.options.find(({ kind }) => kind === 'allow_once')
      if (option === undefined) throw new Error('no allow_once permission option')
      return { outcome: { outcome: 'selected', optionId: option.optionId } }
    })
    .connect(
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    )

  return {
    agent: connection.agent,
    updates,
    permissions,
    waitForUpdate(predicate: (update: SessionUpdate) => boolean) {
      return new Promise<void>((resolve) => {
        const listener = (update: SessionUpdate) => {
          if (!predicate(update)) return
          listeners.delete(listener)
          resolve()
        }
        listeners.add(listener)
      })
    },
    async finish() {
      connection.close()
      child.stdin.end()
      expect(await exited, diagnostics.join('')).toBe(0)
      expect(diagnostics.join('')).toBe('')
      for (const line of raw.join('').trim().split('\n')) {
        expect(JSON.parse(line)).toHaveProperty('jsonrpc', '2.0')
      }
    },
    async stop() {
      connection.close()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    },
  }
}

function selectValue(
  options: SessionConfigOption[] | null | undefined,
  id: string,
  name: string,
): string {
  const option = options?.find((candidate) => candidate.id === id)
  if (option?.type !== 'select') throw new Error(`missing select option: ${id}`)
  const values = option.options.flatMap((candidate) =>
    'group' in candidate ? candidate.options : [candidate],
  )
  const selected = values.find((candidate) => candidate.name === name)
  if (selected === undefined) throw new Error(`missing ${id} value: ${name}`)
  return selected.value
}

function reply(updates: SessionUpdate[]): string {
  return updates
    .flatMap((update) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
        ? [update.content.text]
        : [],
    )
    .join('')
}

describe('official Harness ACP compatibility', () => {
  it('selects models, requests permission, uses MCP, resumes history and continues after cancellation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-profile-'))
    let process = launch(cwd)
    try {
      const initialized = await process.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      expect(initialized.agentCapabilities).toMatchObject({
        mcpCapabilities: { http: true },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {}, list: {}, resume: {} },
      })
      const session = await process.agent.request(methods.agent.session.new, { cwd, mcpServers })
      const sessionId = session.sessionId
      const selected = await process.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'model',
        value: selectValue(session.configOptions, 'model', 'beta'),
      })
      await process.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'reasoning_effort',
        value: selectValue(selected.configOptions, 'reasoning_effort', 'low'),
      })
      await expect(
        process.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'first' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' })
      expect(reply(process.updates)).toBe('model=beta; effort=low; tool=5; turns=1')
      expect(process.permissions.length).toBeGreaterThan(0)
      expect(process.updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'fixture-first',
          status: 'completed',
        }),
      )
      expect(process.updates).toContainEqual(
        expect.objectContaining({ sessionUpdate: 'usage_update' }),
      )
      await expect(
        process.agent.request(methods.agent.session.load, {
          sessionId,
          cwd,
          mcpServers,
        }),
      ).rejects.toMatchObject({ code: -32601 })
      await process.agent.request(methods.agent.session.close, { sessionId })
      await process.finish()

      process = launch(cwd)
      await process.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      const listed = await process.agent.request(methods.agent.session.list, { cwd })
      expect(listed.sessions).toContainEqual(expect.objectContaining({ sessionId, cwd }))
      const resumed = await process.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers,
      })
      const model = resumed.configOptions?.find(({ id }) => id === 'model')
      expect(model?.currentValue).toBe(selectValue(resumed.configOptions, 'model', 'beta'))
      const toolFinished = process.waitForUpdate(
        (update) =>
          update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'fixture-cancel',
      )
      const prompt = process.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'cancel' }],
      })
      await Promise.race([
        toolFinished,
        prompt.then(() => {
          throw new Error('prompt ended before cancellation')
        }),
      ])
      await process.agent.notify(methods.agent.session.cancel, { sessionId })
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
      await expect(
        process.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'continue' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' })
      expect(reply(process.updates)).toBe('model=beta; effort=low; tool=5; turns=3')
      await process.agent.request(methods.agent.session.close, { sessionId })
      await process.finish()
    } finally {
      await process.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it('accepts the next prompt immediately after a provider failure', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-failure-'))
    const process = launch(cwd)
    try {
      await process.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      const { sessionId } = await process.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers,
      })
      await expect(
        process.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'fail' }],
        }),
      ).rejects.toThrow('fixture provider failure')
      await expect(
        process.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'recover' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' })
      expect(reply(process.updates)).toContain('tool=5; turns=2')
      await process.agent.request(methods.agent.session.close, { sessionId })
      await process.finish()
    } finally {
      await process.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)
})
