import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  it('reports the npx command and package version', () => {
    const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })
    expect(help.status).toBe(0)
    expect(help.stderr).toBe('')
    expect(help.stdout).toContain('npx --yes @dumbo-ai/dsh-acp')

    const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
    expect(version.status).toBe(0)
    expect(version.stderr).toBe('')
    expect(version.stdout).toBe('0.2.0\n')
  })

  it('boots the bundled configuration outside a project', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-acp-cli-'))
    try {
      const initialized = spawnSync(process.execPath, [bin], {
        cwd,
        encoding: 'utf8',
        input:
          '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n',
        timeout: 10_000,
      })
      expect(initialized.error).toBeUndefined()
      expect(initialized.status).toBe(0)
      expect(initialized.stderr).toBe('')
      const response = JSON.parse(initialized.stdout) as {
        result?: { agentInfo?: { name?: string; version?: string } }
      }
      expect(response.result?.agentInfo).toMatchObject({ name: 'dsh-acp', version: '0.2.0' })
    } finally {
      rmSync(cwd, { recursive: true })
    }
  })

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
    expect(initialized.agentInfo?.name).toBe('dsh-acp')
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
