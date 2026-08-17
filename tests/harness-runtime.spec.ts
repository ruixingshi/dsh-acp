import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CordisHarnessRuntime } from '../src/harness-runtime.js'
import type { RuntimeEvent, RuntimeSession } from '../src/runtime.js'

type Script = StreamChunk[] | 'hang'

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

interface RuntimeHarness {
  ctx: Context
  adapter: ScriptedAdapter
  runtime: CordisHarnessRuntime
}

async function makeHarness(script: Script[]): Promise<RuntimeHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { persona: 'Selected {{model}} in {{cwd}}.' },
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

  it('drives a real Harness agent and projects live text, thought, and usage', async () => {
    harness = await makeHarness([answer('done')])
    const events: RuntimeEvent[] = []
    const session = await createSession(harness.runtime, events)

    await expect(session.prompt('work')).resolves.toEqual({ kind: 'completed' })
    expect(events).toContainEqual({
      type: 'assistant-thought',
      text: 'check',
      messageId: 'reasoning:1:1:0',
    })
    expect(events).toContainEqual({
      type: 'assistant-text',
      text: 'done',
      messageId: 'assistant:1:1:1',
    })
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
    expect(harness.adapter.requests[1]?.system).toContain('Selected flash')
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
})
