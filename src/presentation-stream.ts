/** Add display updates to the official ACP transport without owning Agent execution. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session, SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection'
import type {
  AnyMessage,
  JsonRpcId,
  ListSessionsResponse,
  SessionNotification,
  SessionUpdate,
  Stream,
} from '@agentclientprotocol/sdk'
import { planUpdate, titleUpdate, toolKind } from './projector.js'
import { withSessionTitles } from './session-list.js'

type PendingRequest =
  | { method: 'session/new' }
  | { method: 'session/list' }
  | {
      method: 'session/resume' | 'session/close'
      sessionId: string
    }
interface DisplaySession {
  session: Session
  watermarks: { title: SessionSeqCursor; todos: SessionSeqCursor }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Serializes upstream frames and display notifications through one writer.
 * Successful official replies establish display ownership; only the official
 * ACP implementation creates, cancels, closes, or settles an Agent.
 */
export class PresentationStream {
  readonly stream: Stream
  private readonly sessions = new Map<string, DisplaySession>()
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly reads = new AbortController()
  private readonly reader: ReadableStreamDefaultReader<AnyMessage>
  private readonly writer: WritableStreamDefaultWriter<AnyMessage>
  private readonly unsubscribe: () => void
  private input!: ReadableStreamDefaultController<AnyMessage>
  private inputEnded = false
  private disposing = false
  private tail = Promise.resolve()
  private disposal: Promise<void> | undefined

  /**
   * @param ctx - Harness session, persistence, and projection services from the same profile.
   * @param transport - client transport; the caller owns its underlying streams.
   */
  constructor(
    private readonly ctx: Pick<
      Context,
      'sessions' | 'sessionProjections' | 'sessionPersistence' | 'sessionProjectionCache' | 'logger'
    >,
    transport: Stream,
  ) {
    this.reader = transport.readable.getReader()
    this.writer = transport.writable.getWriter()
    this.stream = {
      readable: new ReadableStream<AnyMessage>({
        start: (controller) => {
          this.input = controller
        },
        pull: async (controller) => {
          try {
            const { done, value } = await this.reader.read()
            if (this.inputEnded) return
            if (done) {
              this.inputEnded = true
              this.stopDisplay()
              controller.close()
            } else {
              this.observeRequest(value)
              controller.enqueue(value)
            }
          } catch (error) {
            this.fail(error)
          }
        },
        cancel: async (reason: unknown) => {
          this.inputEnded = true
          this.stopDisplay()
          await this.reader.cancel(reason)
        },
      }),
      writable: new WritableStream<AnyMessage>({
        write: (message) => this.write(message),
        close: () => this.dispose(),
        abort: (reason: unknown) => {
          this.fail(reason)
          return this.dispose()
        },
      }),
    }
    this.unsubscribe = ctx.sessionProjections.onChanged((session, key: string, value, seq) => {
      if (key !== 'title' && key !== 'todos') return
      const display = this.sessions.get(session.id)
      if (display?.session !== session || ctx.sessions.get(session.id) !== session) return
      if (seq <= display.watermarks[key]) return
      display.watermarks[key] = seq
      // The projection registry validates the value against the schema for this key.
      const update =
        key === 'title'
          ? titleUpdate(value as SessionProjectionMap['title'])
          : planUpdate(value as SessionProjectionMap['todos'])
      if (update !== undefined) void this.enqueue([this.notification(session.id, update)])
    })
  }

  /** Stop subscriptions and input, then await writes before releasing transport locks. */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeTransport()
    return this.disposal
  }

  private async disposeTransport(): Promise<void> {
    this.disposing = true
    if (!this.inputEnded) {
      this.inputEnded = true
      this.input.close()
    }
    this.stopDisplay()
    try {
      try {
        await this.reader.cancel()
      } finally {
        await this.tail
      }
    } finally {
      this.reader.releaseLock()
      this.writer.releaseLock()
    }
  }

  private stopDisplay(): void {
    this.unsubscribe()
    this.reads.abort()
    this.sessions.clear()
    this.pending.clear()
  }

  private fail(error: unknown): void {
    if (this.inputEnded) return
    this.inputEnded = true
    this.stopDisplay()
    this.input.error(error)
    // Input cancellation may also fail after disconnect; the output error is retained in tail.
    void this.reader.cancel(error).catch(() => undefined)
  }

  private observeRequest(message: AnyMessage): void {
    if (Array.isArray(message) || !('method' in message) || !('id' in message)) return
    // The SDK validates incoming frames after this decorator; do not retain invalid request ids.
    const id = object(message)?.id
    if (id !== null && typeof id !== 'string' && typeof id !== 'number') return
    if (typeof id === 'number' && !Number.isFinite(id)) return
    if (message.method === 'session/new' || message.method === 'session/list') {
      this.pending.set(id, { method: message.method })
    } else if (message.method === 'session/resume' || message.method === 'session/close') {
      const sessionId = object(message.params)?.sessionId
      if (typeof sessionId === 'string') this.pending.set(id, { method: message.method, sessionId })
    }
  }

  private write(message: AnyMessage): Promise<void> {
    const frames = [this.enrichTool(message)]
    if (!('method' in message)) {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (pending !== undefined) {
        if (pending.method === 'session/list') {
          if ('result' in message) {
            return this.enqueue(async () => [
              {
                ...message,
                result: await withSessionTitles(
                  this.ctx,
                  message.result as ListSessionsResponse,
                  this.reads.signal,
                ),
              },
            ])
          }
        } else if (pending.method === 'session/close') {
          const display = this.sessions.get(pending.sessionId)
          // Upstream can dispose the Agent and then report a persistence/teardown error.
          if (
            'result' in message ||
            (display !== undefined && this.ctx.sessions.get(display.session.id) !== display.session)
          ) {
            this.sessions.delete(pending.sessionId)
          }
        } else if ('result' in message) {
          const sessionId =
            pending.method === 'session/new' ? object(message.result)?.sessionId : pending.sessionId
          if (typeof sessionId === 'string') frames.push(...this.activate(sessionId))
        }
      }
    }
    return this.enqueue(frames)
  }

  private activate(sessionId: string): AnyMessage[] {
    const session = this.ctx.sessions.get(brandString<SessionId>(sessionId))
    // A concurrent official close may dispose the session before its activation reply is written.
    if (session === undefined) return []
    const snapshot = this.ctx.sessionProjections.snapshot(session, ['title', 'todos'])
    this.sessions.set(sessionId, {
      session,
      watermarks: { title: snapshot.asOfSeq, todos: snapshot.asOfSeq },
    })
    const updates: SessionUpdate[] = []
    const title = titleUpdate(snapshot.values.title)
    if (title !== undefined) updates.push(title)
    if (snapshot.values.todos !== undefined) updates.push(planUpdate(snapshot.values.todos))
    return updates.map((update) => this.notification(sessionId, update))
  }

  private notification(sessionId: string, update: SessionUpdate): AnyMessage {
    return {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update } satisfies SessionNotification,
    }
  }

  private enrichTool(message: AnyMessage): AnyMessage {
    if (!('method' in message) || message.method !== 'session/update') return message
    const params = message.params as SessionNotification
    const update = params.update
    if (update.sessionUpdate !== 'tool_call' || (update.kind != null && update.kind !== 'other'))
      return message
    return {
      ...message,
      params: { ...params, update: { ...update, kind: toolKind(update.title) } },
    }
  }

  private enqueue(frames: AnyMessage[] | (() => Promise<AnyMessage[]>)): Promise<void> {
    if (this.disposing) return Promise.reject(new Error('ACP presentation transport disposed'))
    const write = this.tail.then(async () => {
      const resolved = typeof frames === 'function' ? await frames() : frames
      for (const frame of resolved) await this.writer.write(frame)
    })
    this.tail = write
    // A display-only failure must also stop the official connection, even when no prompt is active.
    void write.catch((error: unknown) => this.fail(error))
    return write
  }
}
