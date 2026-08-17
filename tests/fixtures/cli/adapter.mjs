import { ndJsonStream } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { DshAcpServer } from '../../../dist/server.js'

class Session {
  constructor(options) {
    this.id = options.sessionId
    this.selection = { ...options.selection }
    this.options = options
  }

  setSelection(selection) {
    this.selection = { ...selection }
  }

  async prompt() {
    this.options.onEvent({ type: 'assistant-thought', text: 'fixture thought' })
    this.options.onEvent({ type: 'assistant-text', text: 'fixture answer' })
    return { kind: 'completed' }
  }

  cancel() {}

  async dispose() {}
}

class Runtime {
  async listModels() {
    return [{ provider: 'fixture', providerName: 'Fixture', id: 'model', name: 'Fixture Model' }]
  }

  async resolveModel(selection) {
    return {
      provider: selection.provider,
      providerName: 'Fixture',
      id: selection.model,
      name: 'Fixture Model',
      reasoning: {
        efforts: [{ id: 'high', name: 'High' }],
        defaultEffort: 'high',
      },
    }
  }

  async createSession(options) {
    return new Session(options)
  }

  async dispose() {}
}

export const name = 'cli-fixture'

export function apply(ctx) {
  const server = new DshAcpServer(new Runtime(), {
    initialSelection: { provider: 'fixture', model: 'model', reasoningEffort: 'high' },
  })
  server.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
  ctx.effect(() => () => server.dispose(), 'cli-fixture.connection')
}
