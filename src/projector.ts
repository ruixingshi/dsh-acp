/** Pure projection from Harness runtime presentation events to ACP updates. */

import type { SessionUpdate, ToolKind } from '@agentclientprotocol/sdk'
import type { RuntimeContent, RuntimeEvent } from './runtime.js'

/** Infer ACP's generic tool category from one Harness tool name. */
export function toolKind(name: string): ToolKind {
  const normalized = name.toLowerCase()
  if (/^(read|view)|read_file|list_file/.test(normalized)) return 'read'
  if (/^(write|edit|apply_patch)|write_file/.test(normalized)) return 'edit'
  if (/delete|remove|unlink/.test(normalized)) return 'delete'
  if (/move|rename/.test(normalized)) return 'move'
  if (/search|find|grep|(^|_)rg($|_)/.test(normalized)) return 'search'
  if (/bash|shell|terminal|exec|command/.test(normalized)) return 'execute'
  if (/fetch|http|get_url/.test(normalized)) return 'fetch'
  if (/think|plan|todo/.test(normalized)) return 'think'
  return 'other'
}

function parsedArguments(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText)
  } catch {
    return argumentsText
  }
}

function contentText(content: readonly RuntimeContent[]): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : `[${block.description}]`))
    .join('\n')
}

/** Project one runtime event into the corresponding ACP session update. */
export function projectRuntimeEvent(event: RuntimeEvent): SessionUpdate {
  switch (event.type) {
    case 'assistant-text':
      return {
        sessionUpdate: 'agent_message_chunk',
        ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
        content: { type: 'text', text: event.text },
      }
    case 'assistant-thought':
      return {
        sessionUpdate: 'agent_thought_chunk',
        ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
        content: { type: 'text', text: event.text },
      }
    case 'tool-call':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: event.callId,
        name: event.name,
        title: event.name,
        kind: toolKind(event.name),
        status: 'in_progress',
        rawInput: parsedArguments(event.arguments),
      }
    case 'tool-result': {
      const text = contentText(event.content)
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.callId,
        status: event.isError ? 'failed' : 'completed',
        content: text.length === 0 ? [] : [{ type: 'content', content: { type: 'text', text } }],
        rawOutput: text,
      }
    }
    case 'plan':
      return {
        sessionUpdate: 'plan',
        entries: event.entries.map((entry) => ({ ...entry, priority: 'medium' })),
      }
    case 'usage':
      return { sessionUpdate: 'usage_update', used: event.used, size: event.size }
    case 'session-info':
      return {
        sessionUpdate: 'session_info_update',
        ...(event.title === undefined ? {} : { title: event.title }),
        ...(event.updatedAt === undefined ? {} : { updatedAt: event.updatedAt }),
      }
  }
}
