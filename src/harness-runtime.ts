/** DeepSeek Harness implementation of the protocol-neutral runtime contracts. */

import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {
  CreateRuntimeSessionOptions,
  HarnessRuntime,
  ModelInfo,
  ModelSelection,
  ResolvedModelInfo,
  RuntimeContent,
  RuntimeSession,
  RuntimeStopReason,
} from './runtime.js'

interface InflightPrompt {
  messageId: string
  turn: number | undefined
  endReason: TurnEndReason | undefined
  resolve(reason: RuntimeStopReason): void
  reject(error: Error): void
}

interface OwnedSession {
  agent: Agent
  handle: AgentHandle
  selection: ModelSelectionRef
  options: CreateRuntimeSessionOptions
  session: HarnessRuntimeSession
  inflight: InflightPrompt | undefined
  contextWindow: number | undefined
  released: boolean
}

function runtimeContent(blocks: readonly ContentBlock[]): RuntimeContent[] {
  return blocks.flatMap((block): RuntimeContent[] => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }]
    if (block.type === 'reasoning') return [{ type: 'text', text: block.text }]
    if (block.type === 'image') {
      return [
        { type: 'attachment', description: `image attachment ${block.attachment.attachmentId}` },
      ]
    }
    return []
  })
}

function usedTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sessionTitle(event: SessionEvent): { title: string; updatedAt?: string } | undefined {
  const candidate = event as unknown
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const envelope = candidate as Record<string, unknown>
  if (envelope.type !== 'session/title') return undefined
  const data = envelope.data
  if (typeof data !== 'object' || data === null) return undefined
  const title = (data as Record<string, unknown>).title
  if (typeof title !== 'string') return undefined
  const time = envelope.time
  const date = typeof time === 'number' && Number.isFinite(time) ? new Date(time) : undefined
  return {
    title,
    ...(date !== undefined && !Number.isNaN(date.getTime())
      ? { updatedAt: date.toISOString() }
      : {}),
  }
}

/** A single live RuntimeSession backed by one exact Harness AgentHandle. */
class HarnessRuntimeSession implements RuntimeSession {
  constructor(
    private readonly owner: CordisHarnessRuntime,
    readonly id: string,
  ) {}

  get selection(): ModelSelection {
    const current = this.owner.requireOwned(this.id).selection.current
    if (current === undefined) throw new Error(`session "${this.id}" has no model selection`)
    return {
      provider: current.provider,
      model: current.model,
      ...(current.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: String(current.reasoningEffort) }),
    }
  }

  setSelection(selection: ModelSelection): void {
    const record = this.owner.requireOwned(this.id)
    record.selection.current = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
    }
  }

  prompt(text: string): Promise<RuntimeStopReason> {
    return this.owner.prompt(this.id, text)
  }

  cancel(): void {
    this.owner.cancel(this.id, { kind: 'user' })
  }

  dispose(): Promise<void> {
    return this.owner.release(this.id)
  }
}

/** Harness service adapter used by one ACP connection. */
export class CordisHarnessRuntime implements HarnessRuntime {
  private readonly sessions = new Map<string, OwnedSession>()
  private readonly disposers: (() => unknown)[] = []
  private readonly agents
  private readonly llm
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly ctx: Context) {
    this.agents = ctx.agents
    this.llm = ctx.llm
    this.disposers.push(
      ctx.on('session/event', (session, event) =>
        this.onSessionEvent(session.header.id, session, event),
      ),
      ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
        const record = this.ownedAgent(agent)
        if (record?.inflight?.messageId === message.id) record.inflight.turn = turn
      }),
      ctx.on('agent/inbox/discarded', ({ agent, message }) => {
        const record = this.ownedAgent(agent)
        if (record?.inflight?.messageId === message.id) this.settle(record, { kind: 'cancelled' })
      }),
      ctx.on('agent/status', ({ agent, status }) => {
        const record = this.ownedAgent(agent)
        if (record !== undefined && status === 'idle') this.settleAtIdle(record)
      }),
      ctx.on('agent/error', ({ agent, turn, error }) => {
        const record = this.ownedAgent(agent)
        const inflight = record?.inflight
        if (record === undefined || inflight === undefined) return
        if (inflight.turn !== undefined && inflight.turn !== turn) return
        this.reject(record, new Error(`Harness turn failed: ${errorMessage(error)}`))
      }),
      ctx.on('approval/request', (request, next) => {
        const record = this.ownedAgent(request.agent)
        if (record === undefined || request.callId === undefined) return next()
        return record.options
          .requestPermission({
            callId: String(request.callId),
            name: request.toolName,
            ...(request.reason === undefined ? {} : { title: request.reason }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
          .then((decision) => decision)
      }),
    )
  }

  /** Return the detached advisory catalog for every registered provider. */
  async listModels(): Promise<ModelInfo[]> {
    this.assertOpen()
    const providers = this.llm.listProviders()
    const lists = await Promise.all(
      providers.map(async (provider) => {
        const models = await this.llm.listModels(provider.id)
        return models.map((model): ModelInfo => ({
          provider: provider.id,
          providerName: provider.name,
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(model.inputModalities === undefined
            ? {}
            : { inputModalities: [...model.inputModalities] }),
        }))
      }),
    )
    return lists.flat()
  }

  /** Resolve exact provider metadata without treating catalog membership as validation. */
  async resolveModel(selection: ModelSelection): Promise<ResolvedModelInfo> {
    this.assertOpen()
    const provider = this.llm.listProviders().find((entry) => entry.id === selection.provider)
    const model = await this.llm.resolveModelInfo(selection.provider, selection.model)
    return {
      provider: selection.provider,
      providerName: provider?.name ?? selection.provider,
      id: selection.model,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.inputModalities === undefined
        ? {}
        : { inputModalities: [...model.inputModalities] }),
      ...(model.context === undefined ? {} : { contextWindow: model.context.contextWindow }),
      ...(model.reasoning === undefined
        ? {}
        : {
            reasoning: {
              efforts: model.reasoning.efforts.map((effort) => ({
                id: String(effort.id),
                name: effort.name,
                ...(effort.description === undefined ? {} : { description: effort.description }),
              })),
              ...(model.reasoning.defaultEffort === undefined
                ? {}
                : { defaultEffort: String(model.reasoning.defaultEffort) }),
            },
          }),
    }
  }

  /** Create one unpublished Agent scope, install model selection, then publish it. */
  async createSession(options: CreateRuntimeSessionOptions): Promise<RuntimeSession> {
    this.assertOpen()
    if (this.sessions.has(options.sessionId)) {
      throw new Error(`session "${options.sessionId}" already exists`)
    }
    const selection: ModelSelectionRef = {
      current: {
        provider: options.selection.provider,
        model: options.selection.model,
        ...(options.selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(options.selection.reasoningEffort) }),
      },
      assembled: undefined,
    }
    const handle = await this.agents.create({
      sessionId: SessionId(options.sessionId),
      meta: { cwd: options.cwd },
      agentOptions: { provider: options.selection.provider, model: options.selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, selection)
      },
    })
    if (this.closed) {
      await handle.dispose()
      throw new Error('Harness runtime closed during session creation')
    }
    const session = new HarnessRuntimeSession(this, options.sessionId)
    this.sessions.set(options.sessionId, {
      agent: handle.agent,
      handle,
      selection,
      options,
      session,
      inflight: undefined,
      contextWindow: undefined,
      released: false,
    })
    return session
  }

  /** Quiesce and release every exact AgentHandle and listener. */
  dispose(): Promise<void> {
    return (this.disposal ??= this.disposeOnce())
  }

  requireOwned(id: string): OwnedSession {
    const record = this.sessions.get(id)
    if (record === undefined || record.released) throw new Error(`unknown Harness session: ${id}`)
    return record
  }

  prompt(id: string, text: string): Promise<RuntimeStopReason> {
    const record = this.requireOwned(id)
    if (record.inflight !== undefined) throw new Error('a prompt is already in flight')
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    const response = new Promise<RuntimeStopReason>((resolve, reject) => {
      record.inflight = {
        messageId: message.id,
        turn: undefined,
        endReason: undefined,
        resolve,
        reject,
      }
    })
    try {
      record.agent.followup(message)
    } catch (error) {
      record.inflight = undefined
      throw error
    }
    return response
  }

  cancel(id: string, cause: { kind: 'user' } | { kind: 'disposed' }): void {
    const record = this.sessions.get(id)
    if (record === undefined || record.released) return
    this.settle(record, { kind: 'cancelled' })
    record.agent.cancel(cause)
  }

  async release(id: string): Promise<void> {
    const record = this.sessions.get(id)
    if (record === undefined || record.released) return
    record.released = true
    this.sessions.delete(id)
    this.settle(record, { kind: 'cancelled' })
    record.agent.cancel({ kind: 'disposed' })
    await record.handle.dispose()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Harness runtime is closed')
  }

  private ownedAgent(agent: Agent): OwnedSession | undefined {
    const record = this.sessions.get(String(agent.session.id))
    return record?.agent === agent && !record.released ? record : undefined
  }

  private onSessionEvent(id: SessionId, session: Agent['session'], event: SessionEvent): void {
    const record = this.sessions.get(String(id))
    if (record === undefined || record.released || record.agent.session !== session) return
    const title = sessionTitle(event)
    if (title !== undefined) record.options.onEvent({ type: 'session-info', ...title })
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta' && chunk.text.length > 0) {
          record.options.onEvent({
            type: 'assistant-text',
            text: chunk.text,
            messageId: `assistant:${event.data.turn}:${event.data.step}:${chunk.index}`,
          })
        } else if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) {
          record.options.onEvent({
            type: 'assistant-thought',
            text: chunk.text,
            messageId: `reasoning:${event.data.turn}:${event.data.step}:${chunk.index}`,
          })
        }
        break
      }
      case 'tool/call':
        record.options.onEvent({
          type: 'tool-call',
          callId: String(event.data.callId),
          name: event.data.name,
          arguments: event.data.arguments,
        })
        break
      case 'tool/result': {
        const block = event.data.message.content[0]
        record.options.onEvent({
          type: 'tool-result',
          callId: String(block.toolCallId),
          isError: block.isError === true || event.data.error !== undefined,
          content: runtimeContent(block.content),
        })
        break
      }
      case 'todo/write':
        record.options.onEvent({
          type: 'plan',
          entries: event.data.todos.map((todo) => ({ ...todo })),
        })
        break
      case 'request/context':
        record.contextWindow = event.data.contextWindow
        break
      case 'assistant/message':
        if (event.data.usage !== undefined && record.contextWindow !== undefined) {
          record.options.onEvent({
            type: 'usage',
            used: usedTokens(event.data.usage),
            size: record.contextWindow,
          })
        }
        break
      case 'turn/end':
        this.onTurnEnd(record, event.data.turn, event.data.reason)
        break
      default:
        break
    }
  }

  private onTurnEnd(record: OwnedSession, turn: number, reason: TurnEndReason): void {
    const inflight = record.inflight
    if (inflight?.turn !== turn) return
    if (reason.kind === 'error') {
      this.reject(record, new Error(`Harness turn failed: ${reason.error.message}`))
      return
    }
    inflight.endReason = reason
  }

  private settleAtIdle(record: OwnedSession): void {
    const inflight = record.inflight
    if (inflight === undefined) return
    if (inflight.turn === undefined || inflight.endReason?.kind === 'aborted') {
      this.settle(record, { kind: 'cancelled' })
    } else if (inflight.endReason?.kind === 'max-tokens') {
      this.settle(record, { kind: 'max-tokens' })
    } else {
      this.settle(record, { kind: 'completed' })
    }
  }

  private settle(record: OwnedSession, reason: RuntimeStopReason): void {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.resolve(reason)
  }

  private reject(record: OwnedSession, error: Error): void {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.reject(error)
  }

  private async disposeOnce(): Promise<void> {
    this.closed = true
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map((id) => this.release(id)))
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
  }
}
