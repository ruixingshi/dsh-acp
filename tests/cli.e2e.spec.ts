import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { client, methods, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.js'

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
    expect(help.stdout).toContain('DEEPSEEK_BASE_URL')
    expect(help.stdout).toContain('DSH_PERMISSION_MODE')
    expect(help.stdout).toContain('--patch <path>')
    expect(help.stdout).toContain('official ACP profile')

    const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
    expect(version.status).toBe(0)
    expect(version.stderr).toBe('')
    expect(version.stdout).toBe(`${VERSION}\n`)
  })

  it('boots the official ACP profile and publishes model options', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-acp-cli-'))
    const diagnostics: string[] = []
    try {
      child = spawn(process.execPath, [bin], {
        cwd,
        env: {
          ...process.env,
          DSH_HOME: join(cwd, '.dsh'),
          DSH_TELEMETRY_DISABLED: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => diagnostics.push(chunk))
      const app = client({ name: 'official-cli-test' })
      const connection = app.connect(
        ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
      )

      const initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      expect(initialized.agentInfo).toMatchObject({ name: 'deepseek-harness-acp' })
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
      })
      expect(session.configOptions?.some(({ id }) => id === 'model')).toBe(true)
      await connection.agent.request(methods.agent.session.close, {
        sessionId: session.sessionId,
      })

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
    } finally {
      rmSync(cwd, { recursive: true })
    }
  }, 30_000)

  it('rejects profile patches in legacy complete-config mode', () => {
    const result = spawnSync(process.execPath, [bin, '--patch', './extra.yml'], {
      cwd: fixture,
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--patch cannot be combined with --config or ./cordis.yml')
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
