import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  ReasoningEffortId,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { CordisHarnessRuntime } from '../src/harness-runtime.js'
import type { RuntimeEvent, RuntimeSession } from '../src/runtime.js'

type Script = StreamChunk[] | 'error' | 'hang' | 'partial-error'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: Script[]) {
    super()
  }

  override providerInfo() {
    return { id: 'mock', name: 'Mock Provider' }
  }

  override listModels() {
    return Promise.resolve([
      { provider: 'mock', id: 'pro', name: 'Mock Pro' },
      { provider: 'mock', id: 'flash', name: 'Mock Flash' },
    ])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model === 'pro' ? 'Mock Pro' : 'Mock Flash',
      context: { contextWindow: 128_000 },
      reasoning: {
        efforts:
          model === 'pro'
            ? [
                { id: ReasoningEffortId('off'), name: 'Off' },
                { id: ReasoningEffortId('max'), name: 'Maximum' },
              ]
            : [{ id: ReasoningEffortId('off'), name: 'Off' }],
        defaultEffort: ReasoningEffortId(model === 'pro' ? 'max' : 'off'),
      },
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const next = this.script.shift()
    if (next === undefined) throw new Error('script exhausted')
    if (next === 'error') throw new Error('provider unavailable')
    if (next === 'partial-error') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'doomed partial' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: 'doomed partial' },
      }
      throw new Error('transient provider failure')
    }
    if (next === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        })
      })
      return
    }
    for (const chunk of next) yield chunk
  }
}

function answer(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'check' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'check' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function maxTokens(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

interface RuntimeHarness {
  ctx: Context
  adapter: ScriptedAdapter
  runtime: CordisHarnessRuntime
}

async function makeHarness(script: Script[]): Promise<RuntimeHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { personaPrefix: 'Selected {{model}} in {{cwd}}.' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter, runtime: new CordisHarnessRuntime(ctx) }
}

async function createSession(
  runtime: CordisHarnessRuntime,
  events: RuntimeEvent[],
): Promise<RuntimeSession> {
  return runtime.createSession({
    sessionId: crypto.randomUUID(),
    cwd: process.cwd(),
    selection: { provider: 'mock', model: 'pro', reasoningEffort: 'max' },
    onEvent: (event) => events.push(event),
    requestPermission: () => Promise.resolve('rejected'),
  })
}

describe('CordisHarnessRuntime', () => {
  let harness: RuntimeHarness | undefined

  afterEach(async () => {
    await harness?.runtime.dispose()
    await harness?.ctx.fiber.dispose()
    harness = undefined
  })

  it('discovers provider models and exact reasoning metadata', async () => {
    harness = await makeHarness([])
    await expect(harness.runtime.listModels()).resolves.toEqual([
      { provider: 'mock', providerName: 'Mock Provider', id: 'pro', name: 'Mock Pro' },
      { provider: 'mock', providerName: 'Mock Provider', id: 'flash', name: 'Mock Flash' },
    ])
    await expect(
      harness.runtime.resolveModel({ provider: 'mock', model: 'pro' }),
    ).resolves.toMatchObject({
      contextWindow: 128_000,
      reasoning: { defaultEffort: 'max' },
    })
  })

  it('drives a real Harness agent and projects committed text, thought, and usage', async () => {
    harness = await makeHarness([answer('done')])
    const events: RuntimeEvent[] = []
    const session = await createSession(harness.runtime, events)

    await expect(session.prompt('work')).resolves.toEqual({ kind: 'completed' })
    const contentEvents = events.filter(
      (event) => event.type === 'assistant-thought' || event.type === 'assistant-text',
    )
    expect(contentEvents.map(({ type, text }) => ({ type, text }))).toEqual([
      { type: 'assistant-thought', text: 'check' },
      { type: 'assistant-text', text: 'done' },
    ])
    expect(contentEvents.every((event) => typeof event.messageId === 'string')).toBe(true)
    expect(new Set(contentEvents.map((event) => event.messageId)).size).toBe(1)
    expect(events).toContainEqual({ type: 'usage', used: 15, size: 128_000 })
    expect(harness.adapter.requests[0]?.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'work' },
    ])
  })

  it('applies a model and effort switch together at the next step boundary', async () => {
    harness = await makeHarness([answer('first'), answer('second')])
    const session = await createSession(harness.runtime, [])
    await session.prompt('one')
    session.setSelection({ provider: 'mock', model: 'flash', reasoningEffort: 'off' })
    await session.prompt('two')

    expect(
      harness.adapter.requests.map(({ model, reasoningEffort }) => ({
        model,
        reasoningEffort,
      })),
    ).toEqual([
      { model: 'pro', reasoningEffort: 'max' },
      { model: 'flash', reasoningEffort: 'off' },
    ])
    expect(
      harness.adapter.requests[1]?.messages
        .find(({ role }) => role === 'system')
        ?.content.some((block) => block.type === 'text' && block.text.includes('Selected flash')),
    ).toBe(true)
  })

  it('settles an explicit cancellation and drains the Harness driver', async () => {
    harness = await makeHarness(['hang'])
    const events: RuntimeEvent[] = []
    const session = await createSession(harness.runtime, events)
    const prompt = session.prompt('wait')
    await vi.waitFor(() => expect(harness?.adapter.requests).toHaveLength(1))

    session.cancel()
    await expect(prompt).resolves.toEqual({ kind: 'cancelled' })
    await session.dispose()
  })

  it('does not admit the next prompt until a failed Harness activity is quiescent', async () => {
    harness = await makeHarness(['error', answer('recovered')])
    const session = await createSession(harness.runtime, [])

    const retry = session.prompt('fail').then(
      () => Promise.reject(new Error('failed prompt unexpectedly resolved')),
      (error: unknown) => {
        expect(error).toEqual(new Error('Harness turn failed: provider unavailable'))
        return session.prompt('retry')
      },
    )
    await expect(retry).resolves.toEqual({ kind: 'completed' })

    expect(harness.adapter.requests).toHaveLength(2)
  })

  it('publishes only the committed assistant message after a provider retry', async () => {
    harness = await makeHarness(['partial-error', answer('recovered')])
    harness.ctx.on('agent/request-error', () => Promise.resolve({ kind: 'retry' }))
    const events: RuntimeEvent[] = []
    const session = await createSession(harness.runtime, events)

    await expect(session.prompt('retry')).resolves.toEqual({ kind: 'completed' })

    const contentEvents = events.filter(
      (event) => event.type === 'assistant-thought' || event.type === 'assistant-text',
    )
    expect(contentEvents.map((event) => event.text)).toEqual(['check', 'recovered'])
    expect(new Set(contentEvents.map((event) => event.messageId)).size).toBe(1)
    expect(harness.adapter.requests).toHaveLength(2)
  })

  it('does not admit the next prompt until a cancelled Harness activity is quiescent', async () => {
    harness = await makeHarness(['hang', answer('continued')])
    const session = await createSession(harness.runtime, [])
    const cancelled = session.prompt('wait')
    await vi.waitFor(() => expect(harness?.adapter.requests).toHaveLength(1))

    session.cancel()
    await expect(cancelled).resolves.toEqual({ kind: 'cancelled' })
    await expect(session.prompt('continue')).resolves.toEqual({ kind: 'completed' })

    expect(harness.adapter.requests).toHaveLength(2)
  })

  it('settles a prompt cancelled while queued behind Harness maintenance', async () => {
    harness = await makeHarness([])
    const session = await createSession(harness.runtime, [])
    const agent = harness.runtime.requireOwned(session.id).agent
    const maintenance = agent.runMaintenance(
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        }),
    )

    const prompt = session.prompt('queued during maintenance')
    session.cancel()

    await expect(
      Promise.race([
        prompt,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ]),
    ).resolves.toEqual({ kind: 'cancelled' })
    await maintenance
  })

  it('preserves a Harness failure raised before the prompt is claimed', async () => {
    harness = await makeHarness([answer('recovered')])
    const session = await createSession(harness.runtime, [])
    const agent = harness.runtime.requireOwned(session.id).agent
    const append = agent.session.append.bind(agent.session)
    const callAppend = append as (...args: unknown[]) => unknown
    agent.session.append = ((type: string, ...args: unknown[]) => {
      if (type === 'turn/start') throw new Error('session append failed')
      return callAppend(type, ...args)
    }) as typeof append

    await expect(session.prompt('fail before claim')).rejects.toThrow(
      'Harness turn failed: session append failed',
    )
    agent.session.append = append

    await expect(session.prompt('retry')).resolves.toEqual({ kind: 'completed' })
    expect(harness.adapter.requests).toHaveLength(1)
    expect(harness.adapter.requests[0]?.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'retry' },
    ])
  })

  it('rejects when replacement work fails before the owned activity becomes idle', async () => {
    harness = await makeHarness([answer('first'), 'error'])
    const session = await createSession(harness.runtime, [])
    const agent = harness.runtime.requireOwned(session.id).agent
    let replacementQueued = false
    harness.ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle' || replacementQueued) return
      replacementQueued = true
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'replacement' }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      )
    })

    await expect(session.prompt('work')).rejects.toThrow(
      'Harness turn failed: provider unavailable',
    )
    expect(harness.adapter.requests).toHaveLength(2)
  })

  it('reports a hook-aborted turn as ordinary completion', async () => {
    harness = await makeHarness(['hang'])
    const session = await createSession(harness.runtime, [])
    const prompt = session.prompt('wait')
    await vi.waitFor(() => expect(harness?.adapter.requests).toHaveLength(1))

    harness.runtime
      .requireOwned(session.id)
      .agent.cancel({ kind: 'hook', reason: 'owner intervention' })

    await expect(prompt).resolves.toEqual({ kind: 'completed' })
  })

  it('reports a continued max-token Harness turn as ordinary prompt completion', async () => {
    harness = await makeHarness([maxTokens('partial'), answer('continued')])
    const session = await createSession(harness.runtime, [])
    const agent = harness.runtime.requireOwned(session.id).agent
    const turnEndReasons: TurnEndReason[] = []
    let continuationQueued = false
    harness.ctx.on('session/event', (subject, event) => {
      if (subject === agent.session && event.type === 'turn/end') {
        turnEndReasons.push(event.data.reason)
      }
    })
    harness.ctx.on('agent/turn-stopping', ({ agent: subject }) => {
      if (subject !== agent || continuationQueued) return
      continuationQueued = true
      agent.inject(
        createUserMessage({
          content: [{ type: 'text', text: 'continue' }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      )
    })

    await expect(session.prompt('work')).resolves.toEqual({ kind: 'completed' })
    expect(harness.adapter.requests).toHaveLength(2)
    expect(turnEndReasons.at(-1)).toEqual({ kind: 'max-tokens' })
  })

  it('removes runtime listeners after an AgentHandle disposer fails', async () => {
    harness = await makeHarness([])
    const current = harness
    const session = await createSession(current.runtime, [])
    const owned = current.runtime.requireOwned(session.id)
    const dispose = vi
      .spyOn(owned.handle, 'dispose')
      .mockRejectedValue(new Error('handle cleanup failed'))
    const state = current.runtime as unknown as { disposers: (() => unknown)[] }

    try {
      await expect(current.runtime.dispose()).rejects.toThrow('handle cleanup failed')
      expect(state.disposers).toHaveLength(0)
    } finally {
      dispose.mockRestore()
      harness = undefined
      await current.ctx.fiber.dispose()
    }
  })
})
