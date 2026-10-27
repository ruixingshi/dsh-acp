/** Deterministic provider; all ACP, Agent, tool and persistence code remains real. */
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'

class FixtureAdapter extends LlmAdapter {
  providerInfo() {
    return { id: 'fixture', name: 'Fixture' }
  }

  async listModels(provider) {
    return ['alpha', 'beta'].map((id) => ({
      provider,
      id,
      name: id,
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: 128_000 },
      reasoning: {
        efforts: ['low', 'high'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId('high'),
      },
    }
  }

  async *stream(options) {
    const userIndex = options.messages.findLastIndex(
      (message) => message.role === 'user' && message.source.kind === 'user',
    )
    const turn = options.messages.slice(userIndex)
    const prompt = turn[0].content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    if (prompt === 'fail') throw new Error('fixture provider failure')
    const tool = turn.find((message) => message.role === 'tool')
    if (!tool) {
      const id = ToolCallId(`fixture-${prompt}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id,
        name: 'mcp__fixture__add',
        argumentsDelta: '{"a":2,"b":3}',
      }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id,
          name: 'mcp__fixture__add',
          arguments: '{"a":2,"b":3}',
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (prompt === 'cancel') {
      await new Promise((_resolve, reject) => {
        if (options.signal.aborted) return reject(new Error('cancelled'))
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        })
      })
      return
    }
    const result = tool.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    const userTurns = options.messages.filter(
      (message) => message.role === 'user' && message.source.kind === 'user',
    ).length
    const text = `model=${options.model}; effort=${options.reasoningEffort}; tool=${result}; turns=${userTurns}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'fixture-llm'
export const inject = ['llm']
export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], new FixtureAdapter()))
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'mcp__fixture__add') return next()
    return { kind: 'ask', reason: 'fixture approval' }
  })
}
