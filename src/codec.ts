/** Baseline ACP prompt conversion and terminal-reason mapping. */

import { RequestError, type ContentBlock, type StopReason } from '@agentclientprotocol/sdk'
import type { RuntimeStopReason } from './runtime.js'

/** Convert supported baseline prompt blocks into one Harness text message. */
export function promptToText(prompt: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of prompt) {
    if (block.type === 'text') {
      parts.push(block.text)
      continue
    }
    if (block.type === 'resource_link') {
      parts.push(
        `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`,
      )
      continue
    }
    throw RequestError.invalidParams(
      undefined,
      'only text and resource_link prompt content is supported',
    )
  }
  const text = parts.join('')
  if (text.trim().length === 0) {
    throw RequestError.invalidParams(undefined, 'prompt must contain non-empty text')
  }
  return text
}

/** Map one runtime terminal outcome onto ACP's stable vocabulary. */
export function stopReason(reason: RuntimeStopReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    case 'cancelled':
      return 'cancelled'
    case 'refusal':
      return 'refusal'
  }
}
