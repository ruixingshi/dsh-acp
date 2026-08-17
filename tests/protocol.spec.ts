import { describe, expect, it } from 'vitest'
import {
  client,
  methods,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { DshAcpServer } from '../src/server.js'
import type {
  CreateRuntimeSessionOptions,
  HarnessRuntime,
  ModelInfo,
  ModelSelection,
  ResolvedModelInfo,
  RuntimeSession,
} from '../src/runtime.js'

class WireSession implements RuntimeSession {
  readonly id: string
  selection: ModelSelection

  constructor(private readonly options: CreateRuntimeSessionOptions) {
    this.id = options.sessionId
    this.selection = { ...options.selection }
  }

  setSelection(selection: ModelSelection): void {
    this.selection = { ...selection }
  }

  prompt(): Promise<{ kind: 'completed' }> {
    this.options.onEvent({ type: 'assistant-thought', text: 'thinking' })
    this.options.onEvent({ type: 'assistant-text', text: 'answer' })
    return Promise.resolve({ kind: 'completed' })
  }

  cancel(): void {
    // This synchronous fixture never retains in-flight work.
  }
  dispose(): Promise<void> {
    return Promise.resolve()
  }
}

class WireRuntime implements HarnessRuntime {
  readonly models: ModelInfo[] = [
    {
      provider: 'deepseek',
      providerName: 'DeepSeek',
      id: 'pro',
      name: 'DeepSeek Pro',
    },
  ]

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.models)
  }

  resolveModel(selection: ModelSelection): Promise<ResolvedModelInfo> {
    return Promise.resolve({
      ...this.models[0]!,
      id: selection.model,
      reasoning: {
        efforts: [{ id: 'max', name: 'Maximum' }],
        defaultEffort: 'max',
      },
    })
  }

  createSession(options: CreateRuntimeSessionOptions): Promise<RuntimeSession> {
    return Promise.resolve(new WireSession(options))
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }
}

describe('ACP SDK integration', () => {
  it('serves model configuration and rich updates through real ACP handlers', async () => {
    const updates: SessionNotification[] = []
    const permission: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
    const clientApp = client({ name: 'test-client' })
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params)
      })
      .onRequest(methods.client.session.requestPermission, () => permission)
    const server = new DshAcpServer(new WireRuntime(), {
      initialSelection: { provider: 'deepseek', model: 'pro', reasoningEffort: 'max' },
    })
    const connection = clientApp.connect(server.app)

    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    })
    expect(initialized.agentInfo?.name).toBe('deepseek-harness-acp')
    const created = await connection.agent.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    })
    expect(created.configOptions?.map((option) => option.id)).toEqual(['model', 'reasoning_effort'])

    await expect(
      connection.agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      }),
    ).resolves.toEqual({ stopReason: 'end_turn' })
    expect(updates.map(({ update }) => update.sessionUpdate)).toEqual([
      'agent_thought_chunk',
      'agent_message_chunk',
    ])

    await connection.agent.request(methods.agent.session.close, {
      sessionId: created.sessionId,
    })
    connection.close()
    await server.dispose()
  })
})
