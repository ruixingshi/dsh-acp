import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PassThrough, Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { client, methods, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/cli/', import.meta.url))
const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
let child: ChildProcessWithoutNullStreams | undefined

afterEach(async () => {
  if (child?.exitCode !== null) return
  const running = child
  child = undefined
  const exited = new Promise<void>((resolve) => running.once('exit', () => resolve()))
  running.kill('SIGKILL')
  await exited
})

describe.skipIf(!existsSync(bin))('built dsh-acp CLI', () => {
  it('keeps stdout protocol-pure and closes cleanly on EOF', async () => {
    const diagnostics: string[] = []
    child = spawn(process.execPath, [bin, '--config', './cordis.yml'], {
      cwd: fixture,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => diagnostics.push(chunk))
    const raw: string[] = []
    const passthrough = new PassThrough()
    child.stdout.on('data', (chunk: Buffer) => {
      raw.push(chunk.toString('utf8'))
      passthrough.push(chunk)
    })
    child.stdout.on('end', () => passthrough.push(null))
    const updates: SessionNotification[] = []
    const app = client({ name: 'cli-test' })
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params)
      })
      .onRequest(methods.client.session.requestPermission, () => ({
        outcome: { outcome: 'cancelled' },
      }))
    const connection = app.connect(
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(passthrough) as ReadableStream<Uint8Array>,
      ),
    )

    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    })
    expect(initialized.agentInfo?.name).toBe('deepseek-harness-acp')
    const session = await connection.agent.request(methods.agent.session.new, {
      cwd: fixture,
      mcpServers: [],
    })
    await expect(
      connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      }),
    ).resolves.toEqual({ stopReason: 'end_turn' })
    expect(updates.map(({ update }) => update.sessionUpdate)).toEqual([
      'agent_thought_chunk',
      'agent_message_chunk',
    ])

    const running = child
    const exited = new Promise<number | null>((resolve) => {
      running.once('exit', (code) => resolve(code))
    })
    connection.close()
    child.stdin.end()
    await connection.closed
    await expect(exited).resolves.toBe(0)
    expect(diagnostics.join('')).toBe('')
    child = undefined
    for (const line of raw
      .join('')
      .split('\n')
      .filter((value) => value.length > 0)) {
      expect(() => JSON.parse(line) as unknown).not.toThrow()
    }
  }, 10_000)
})
