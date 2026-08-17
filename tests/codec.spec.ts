import { describe, expect, it } from 'vitest'
import { RequestError } from '@agentclientprotocol/sdk'
import { promptToText, stopReason } from '../src/codec.js'

describe('ACP codec', () => {
  it('keeps text and baseline resource links in order', () => {
    expect(
      promptToText([
        { type: 'text', text: 'Inspect ' },
        {
          type: 'resource_link',
          name: 'design',
          uri: 'file:///tmp/design.md',
        },
      ]),
    ).toBe('Inspect [resource_link name=design uri=file:///tmp/design.md]')
  })

  it('rejects empty and unsupported prompt content', () => {
    expect(() => promptToText([{ type: 'text', text: '   ' }])).toThrow(RequestError)
    expect(() => promptToText([{ type: 'image', mimeType: 'image/png', data: 'AA==' }])).toThrow(
      /only text and resource_link/,
    )
  })

  it('maps Harness terminal outcomes to ACP stop reasons', () => {
    expect(stopReason({ kind: 'completed' })).toBe('end_turn')
    expect(stopReason({ kind: 'max-tokens' })).toBe('max_tokens')
    expect(stopReason({ kind: 'cancelled' })).toBe('cancelled')
    expect(stopReason({ kind: 'refusal' })).toBe('refusal')
  })
})
