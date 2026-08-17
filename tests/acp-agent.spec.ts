import { describe, expect, it, vi } from 'vitest'
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import { DshAcpAgent, type AcpClient } from '../src/acp-agent.js'
import { encodeModelSelection } from '../src/model-options.js'
import type {
  CreateRuntimeSessionOptions,
  HarnessRuntime,
  ModelInfo,
  ModelSelection,
  ResolvedModelInfo,
  RuntimeSession,
  RuntimeStopReason,
} from '../src/runtime.js'

const catalog: ModelInfo[] = [
  {
    provider: 'deepseek-official',
    providerName: 'DeepSeek',
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
  },
  {
    provider: 'deepseek-official',
    providerName: 'DeepSeek',
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
  },
]

class FakeSession implements RuntimeSession {
  selection: ModelSelection
  nextReason: RuntimeStopReason = { kind: 'completed' }
  readonly prompts: string[] = []
  cancelled = false
  disposed = false

  constructor(
    readonly id: string,
    selection: ModelSelection,
  ) {
    this.selection = { ...selection }
  }

  setSelection(selection: ModelSelection): void {
    this.selection = { ...selection }
  }

  prompt(text: string): Promise<RuntimeStopReason> {
    this.prompts.push(text)
    return Promise.resolve(this.nextReason)
  }

  cancel(): void {
    this.cancelled = true
  }

  dispose(): Promise<void> {
    this.disposed = true
    return Promise.resolve()
  }
}

class FakeRuntime implements HarnessRuntime {
  readonly sessions: FakeSession[] = []
  lastCreate: CreateRuntimeSessionOptions | undefined
  disposed = false

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(catalog)
  }

  resolveModel(selection: ModelSelection): Promise<ResolvedModelInfo> {
    const model = catalog.find(
      (entry) => entry.provider === selection.provider && entry.id === selection.model,
    )
    return Promise.resolve({
      ...(model ?? {
        provider: selection.provider,
        providerName: selection.provider,
        id: selection.model,
        name: selection.model,
      }),
      reasoning: {
        efforts: selection.model.endsWith('flash')
          ? [{ id: 'off', name: 'Off' }]
          : [
              { id: 'off', name: 'Off' },
              { id: 'max', name: 'Maximum' },
            ],
        defaultEffort: selection.model.endsWith('flash') ? 'off' : 'max',
      },
    })
  }

  createSession(options: CreateRuntimeSessionOptions): Promise<RuntimeSession> {
    this.lastCreate = options
    const session = new FakeSession(options.sessionId, options.selection)
    this.sessions.push(session)
    return Promise.resolve(session)
  }

  dispose(): Promise<void> {
    this.disposed = true
    return Promise.resolve()
  }
}

function makeHarness(
  permission: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } },
) {
  const runtime = new FakeRuntime()
  const updates: SessionNotification[] = []
  const permissions: RequestPermissionRequest[] = []
  const client: AcpClient = {
    sessionUpdate(notification) {
      updates.push(notification)
      return Promise.resolve()
    },
    requestPermission(request) {
      permissions.push(request)
      return Promise.resolve(permission)
    },
  }
  const agent = new DshAcpAgent(runtime, client, {
    initialSelection: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    },
  })
  return { runtime, updates, permissions, agent }
}

async function newSession(agent: DshAcpAgent): Promise<string> {
  return (await agent.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
}

describe('DshAcpAgent', () => {
  it('advertises the rich baseline and session close without persistence claims', async () => {
    const { agent } = makeHarness()
    await expect(
      agent.initialize({ protocolVersion: 1, clientCapabilities: {} }),
    ).resolves.toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: 'deepseek-harness-acp', version: '0.1.0' },
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {} },
      },
      authMethods: [],
    })
  })

  it('creates a Harness session and returns model and reasoning selectors', async () => {
    const { agent, runtime } = makeHarness()
    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] })

    expect(runtime.sessions).toHaveLength(1)
    expect(runtime.sessions[0]?.id).toBe(result.sessionId)
    expect(result.configOptions?.map((option) => option.id)).toEqual(['model', 'reasoning_effort'])
  })

  it('switches model and replaces reasoning state in one response', async () => {
    const { agent, runtime } = makeHarness()
    const sessionId = await newSession(agent)
    const response = await agent.setSessionConfigOption({
      sessionId,
      configId: 'model',
      value: encodeModelSelection({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      }),
    })

    expect(runtime.sessions[0]?.selection).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'off',
    })
    expect(response.configOptions.find((option) => option.id === 'reasoning_effort')).toMatchObject(
      { currentValue: 'off' },
    )
  })

  it('rejects model values the session did not advertise', async () => {
    const { agent } = makeHarness()
    const sessionId = await newSession(agent)

    await expect(
      agent.setSessionConfigOption({
        sessionId,
        configId: 'model',
        value: encodeModelSelection({ provider: 'other', model: 'unknown' }),
      }),
    ).rejects.toThrow(/not available/)
  })

  it('forwards presentation events and prompt completion', async () => {
    const { agent, runtime, updates } = makeHarness()
    const sessionId = await newSession(agent)
    runtime.lastCreate?.onEvent({ type: 'assistant-text', text: 'hello', messageId: 'a1' })

    await expect(
      agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }),
    ).resolves.toEqual({ stopReason: 'end_turn' })
    await vi.waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toEqual({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'a1',
        content: { type: 'text', text: 'hello' },
      },
    })
    expect(runtime.sessions[0]?.prompts).toEqual(['go'])
  })

  it('maps one-shot ACP permission choices', async () => {
    const { agent, runtime, permissions } = makeHarness({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })
    const sessionId = await newSession(agent)
    const decision = await runtime.lastCreate?.requestPermission({
      callId: 'call-7',
      name: 'bash',
      title: 'Run tests',
    })

    expect(decision).toBe('allowed-once')
    expect(permissions).toEqual([
      {
        sessionId,
        toolCall: { toolCallId: 'call-7', name: 'bash', title: 'Run tests' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    ])
  })

  it('cancels and closes only the addressed session', async () => {
    const { agent, runtime } = makeHarness()
    const first = await newSession(agent)
    await newSession(agent)

    await agent.cancel({ sessionId: first })
    expect(runtime.sessions[0]?.cancelled).toBe(true)
    expect(runtime.sessions[1]?.cancelled).toBe(false)

    await agent.closeSession({ sessionId: first })
    expect(runtime.sessions[0]?.disposed).toBe(true)
    await expect(
      agent.prompt({ sessionId: first, prompt: [{ type: 'text', text: 'late' }] }),
    ).rejects.toThrow(/unknown session/)
  })

  it('rejects unsupported workspace expansion and MCP servers', async () => {
    const { agent } = makeHarness()
    await expect(
      agent.newSession({
        cwd: process.cwd(),
        additionalDirectories: ['/tmp'],
        mcpServers: [],
      }),
    ).rejects.toThrow(/additionalDirectories/)
    await expect(
      agent.newSession({
        cwd: process.cwd(),
        mcpServers: [{ name: 'test', command: 'node', args: [], env: [] }],
      }),
    ).rejects.toThrow(/mcpServers/)
  })
})
