import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.js'

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
let child: ChildProcessWithoutNullStreams | undefined

async function stopChild() {
  if (child?.exitCode !== null || child.signalCode !== null) return
  const running = child
  child = undefined
  const exited = new Promise<void>((resolve) => running.once('exit', () => resolve()))
  running.kill('SIGKILL')
  await exited
}

afterEach(stopChild)

describe('built dsh-acp CLI', () => {
  it('reports the installed command, npx alternative and package version', () => {
    const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })
    expect(help.status).toBe(0)
    expect(help.stderr).toBe('')
    expect(help.stdout).toContain('dsh-acp [options]')
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
    writeFileSync(join(cwd, 'cordis.yml'), 'this is not a Cordis config: [')
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
      await stopChild()
      rmSync(cwd, { recursive: true })
    }
  }, 30_000)

  it('explains how to migrate a removed complete config', () => {
    const result = spawnSync(process.execPath, [bin, '--config', '/unused/cordis.yml'], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('--config has been removed')
    expect(result.stderr).toContain('--patch')
  })
})
