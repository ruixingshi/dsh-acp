import { describe, expect, it } from 'vitest'
import { projectRuntimeEvent } from '../src/projector.js'

describe('Harness event projection', () => {
  it('streams assistant text and reasoning with stable message ids', () => {
    expect(projectRuntimeEvent({ type: 'assistant-text', text: 'hello', messageId: 'm1' })).toEqual(
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'hello' },
      },
    )
    expect(
      projectRuntimeEvent({ type: 'assistant-thought', text: 'checking', messageId: 'r1' }),
    ).toEqual({
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'r1',
      content: { type: 'text', text: 'checking' },
    })
  })

  it('creates a classified tool card and retains malformed raw arguments', () => {
    expect(
      projectRuntimeEvent({
        type: 'tool-call',
        callId: 'call-1',
        name: 'read_file',
        arguments: '{bad json',
      }),
    ).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      name: 'read_file',
      title: 'read_file',
      kind: 'read',
      status: 'in_progress',
      rawInput: '{bad json',
    })
  })

  it('completes failed tools with model-visible content', () => {
    expect(
      projectRuntimeEvent({
        type: 'tool-result',
        callId: 'call-1',
        isError: true,
        content: [{ type: 'text', text: 'permission denied' }],
      }),
    ).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'permission denied' },
        },
      ],
      rawOutput: 'permission denied',
    })
  })

  it('projects whole-list plans and context usage', () => {
    expect(
      projectRuntimeEvent({
        type: 'plan',
        entries: [
          { content: 'Inspect code', status: 'completed' },
          { content: 'Implement adapter', status: 'in_progress' },
        ],
      }),
    ).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Inspect code', status: 'completed', priority: 'medium' },
        { content: 'Implement adapter', status: 'in_progress', priority: 'medium' },
      ],
    })
    expect(projectRuntimeEvent({ type: 'usage', used: 2048, size: 128_000 })).toEqual({
      sessionUpdate: 'usage_update',
      used: 2048,
      size: 128_000,
    })
  })
})
