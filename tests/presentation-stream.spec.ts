/** Transport ordering tests use a fake projection feed, not a second agent implementation. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Session, SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  ProjectionChangeListener,
  ProjectionSnapshot,
} from '@deepseek-ai/dsh-session-projection'
import type { AnyMessage, AnyRequest, SessionNotification } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { PresentationStream } from '../src/presentation-stream.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(write?: (message: AnyMessage) => void | Promise<void>) {
  const sessions = new Map<string, Session>()
  const snapshots = new Map<Session, ProjectionSnapshot>()
  const listeners = new Set<ProjectionChangeListener>()
  const stored = new Map<string, SessionPersistenceSnapshot>()
  const checkpoints = new Map<string, ProjectionSnapshot>()
  const stat = vi.fn<Context['sessionPersistence']['stat']>((id) => Promise.resolve(stored.get(id)))
  const cachedSnapshot = vi.fn<Context['sessionProjectionCache']['cachedSnapshot']>((header) =>
    checkpoints.get(header.id),
  )
  const cachedPredecessorTitle =
    vi.fn<Context['sessionProjectionCache']['cachedPredecessorTitle']>()
  const warn = vi.fn()
  const messages: AnyMessage[] = []
  const input = new TransformStream<AnyMessage, AnyMessage>()
  // Only the service methods consumed by the transport are supplied here.
  const ctx = {
    sessions: { get: (id: string) => sessions.get(id) },
    sessionPersistence: { stat },
    sessionProjectionCache: { cachedSnapshot, cachedPredecessorTitle },
    logger: { warn },
    sessionProjections: {
      snapshot: (session: Session) => snapshots.get(session)!,
      onChanged: (listener: ProjectionChangeListener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  } as unknown as Context
  const bridge = new PresentationStream(ctx, {
    readable: input.readable,
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        await write?.(message)
        messages.push(message)
      },
    }),
  })
  const incoming = input.writable.getWriter()
  const reader = bridge.stream.readable.getReader()
  const writer = bridge.stream.writable.getWriter()
  return {
    bridge,
    messages,
    listeners,
    sessions,
    reader,
    writer,
    stat,
    cachedSnapshot,
    cachedPredecessorTitle,
    warn,
    stored,
    persisted(id: string, title?: string | null) {
      const header = Session.create(brandString<SessionId>(id)).header
      stored.set(id, { header, revision: SessionPersistenceRevision('fixture') })
      if (title !== undefined) checkpoints.set(id, { asOfSeq: -1, values: { title } })
    },
    session(id: string, values: ProjectionSnapshot['values'] = {}) {
      const session = Session.create(brandString<SessionId>(id))
      sessions.set(id, session)
      snapshots.set(session, { asOfSeq: -1, values })
      return session
    },
    async request(request: AnyMessage) {
      await Promise.all([incoming.write(request), reader.read()])
    },
    change(session: Session, key: 'title' | 'todos', value: unknown, seq = 1) {
      for (const listener of listeners) listener(session, key, value, SessionSeq(seq))
    },
    async dispose() {
      try {
        await bridge.dispose()
      } finally {
        incoming.releaseLock()
        reader.releaseLock()
        writer.releaseLock()
      }
    },
  }
}

function request(id: number, method: string, sessionId?: string): AnyRequest {
  return { jsonrpc: '2.0', id, method, params: sessionId === undefined ? {} : { sessionId } }
}
function response(id: number, result: unknown): AnyMessage {
  return { jsonrpc: '2.0', id, result }
}
function updates(messages: AnyMessage[]): SessionNotification[] {
  return messages.flatMap((message) =>
    'method' in message && message.method === 'session/update'
      ? [message.params as SessionNotification]
      : [],
  )
}

describe('official ACP presentation stream', () => {
  it('adds stored titles only to official list rows and preserves upstream titles and pagination', async () => {
    const f = fixture()
    f.persisted('cached', 'Saved title')
    f.persisted('upstream', 'Outdated local title')
    f.persisted('empty', null)
    f.persisted('uncached')
    f.persisted('off-page', 'Never read')
    const page = {
      sessions: [
        {
          sessionId: 'upstream',
          cwd: '/a',
          title: 'Official title',
          _meta: { source: 'official' },
        },
        { sessionId: 'cached', cwd: '/a', updatedAt: '2026-10-27T00:00:00Z' },
        { sessionId: 'empty', cwd: '/b' },
        { sessionId: 'uncached', cwd: '/b' },
        { sessionId: 'deleted', cwd: '/b' },
      ],
      nextCursor: 'opaque-official-cursor',
      _meta: { page: 2 },
    }
    try {
      await f.request(request(1, 'session/list'))
      await f.writer.write(response(1, page))
      expect(f.messages).toEqual([
        response(1, {
          ...page,
          sessions: page.sessions.map((entry) =>
            entry.sessionId === 'cached' ? { ...entry, title: 'Saved title' } : entry,
          ),
        }),
      ])
      expect(page.sessions[1]).not.toHaveProperty('title')
      expect(f.stat.mock.calls.map(([id]) => id)).toEqual([
        'cached',
        'empty',
        'uncached',
        'deleted',
      ])
      expect(f.cachedSnapshot.mock.calls.every(([, keys]) => keys?.join() === 'title')).toBe(true)
      expect(f.sessions.size).toBe(0)
      expect(updates(f.messages)).toEqual([])
    } finally {
      await f.dispose()
    }
  })

  it('uses the official predecessor-title reader and isolates failed metadata reads', async () => {
    const f = fixture()
    f.persisted('older')
    f.persisted('healthy', 'Still visible')
    f.stat.mockRejectedValueOnce(new Error('metadata unavailable'))
    f.cachedPredecessorTitle.mockReturnValueOnce({ asOfSeq: -1, values: { title: 'Older title' } })
    try {
      await f.request(request(1, 'session/list'))
      await f.writer.write(
        response(1, {
          sessions: ['broken', 'older', 'healthy'].map((sessionId) => ({ sessionId, cwd: '/a' })),
        }),
      )
      expect(f.messages).toEqual([
        response(1, {
          sessions: [
            { sessionId: 'broken', cwd: '/a' },
            { sessionId: 'older', cwd: '/a', title: 'Older title' },
            { sessionId: 'healthy', cwd: '/a', title: 'Still visible' },
          ],
        }),
      ])
      expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('metadata unavailable'))
      const rejected: AnyMessage = {
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32602, message: 'invalid cursor' },
      }
      await f.request(request(2, 'session/list'))
      await f.writer.write(rejected)
      expect(f.messages.at(-1)).toEqual(rejected)
      expect(f.stat).toHaveBeenCalledTimes(3)
    } finally {
      await f.dispose()
    }
  })

  it('reserves output order while list metadata is pending', async () => {
    const f = fixture()
    const started = deferred<undefined>()
    const read = deferred<SessionPersistenceSnapshot | undefined>()
    f.persisted('stored', 'Saved')
    f.stat.mockImplementationOnce(() => {
      started.resolve(undefined)
      return read.promise
    })
    const live = f.session('live')
    try {
      await f.request(request(1, 'session/new'))
      await f.writer.write(response(1, { sessionId: 'live' }))
      await f.request(request(2, 'session/list'))
      const listing = f.writer.write(
        response(2, { sessions: [{ sessionId: 'stored', cwd: '/a' }] }),
      )
      await started.promise
      f.change(live, 'title', 'Live update')
      const following = f.writer.write(response(3, {}))
      expect(f.messages).toHaveLength(1)
      read.resolve(f.stored.get('stored'))
      await Promise.all([listing, following])
      expect(
        f.messages.map((message) => ('method' in message ? message.method : message.id)),
      ).toEqual([1, 2, 'session/update', 3])
    } finally {
      read.resolve(undefined)
      await f.dispose()
    }
  })

  it('cancels pending list reads during disposal and drains the original response', async () => {
    const f = fixture()
    const started = deferred<undefined>()
    let readingSignal: AbortSignal | undefined
    f.stat.mockImplementationOnce(
      (_id, options) =>
        new Promise((_resolve, reject) => {
          readingSignal = options?.signal
          readingSignal?.addEventListener('abort', () => reject(new Error('read cancelled')), {
            once: true,
          })
          started.resolve(undefined)
        }),
    )
    await f.request(request(1, 'session/list'))
    const original = response(1, { sessions: [{ sessionId: 'stored', cwd: '/a' }] })
    const listing = f.writer.write(original)
    await started.promise
    await f.dispose()
    await listing
    expect(readingSignal?.aborted).toBe(true)
    expect(f.messages).toEqual([original])
    expect(f.warn).not.toHaveBeenCalled()
  })

  it('sends the official activation response before restored title and plan', async () => {
    const f = fixture()
    f.session('s', { title: 'Existing title', todos: [{ content: 'Work', status: 'in_progress' }] })
    try {
      await f.request(request(1, 'session/resume', 's'))
      await f.writer.write(response(1, { configOptions: [] }))
      expect(f.messages[0]).toEqual(response(1, { configOptions: [] }))
      expect(updates(f.messages)).toEqual([
        {
          sessionId: 's',
          update: { sessionUpdate: 'session_info_update', title: 'Existing title' },
        },
        {
          sessionId: 's',
          update: {
            sessionUpdate: 'plan',
            entries: [{ content: 'Work', status: 'in_progress', priority: 'medium' }],
          },
        },
      ])
    } finally {
      await f.dispose()
    }
  })

  it('isolates successful sessions, clears old plans, and stops updates after close', async () => {
    const f = fixture()
    const a = f.session('a')
    const b = f.session('b')
    try {
      await f.request(request(1, 'session/new'))
      await f.writer.write(response(1, { sessionId: 'a' }))
      f.change(b, 'title', 'Unowned session')
      f.change(a, 'todos', [{ content: 'Work', status: 'pending' }])
      f.change(a, 'todos', null, 2)
      await f.request(request(2, 'session/close', 'a'))
      await f.writer.write(response(2, {}))
      f.change(a, 'title', 'Too late', 3)
      await f.writer.write(response(3, {}))
      expect(updates(f.messages)).toEqual([
        {
          sessionId: 'a',
          update: {
            sessionUpdate: 'plan',
            entries: [{ content: 'Work', status: 'pending', priority: 'medium' }],
          },
        },
        { sessionId: 'a', update: { sessionUpdate: 'plan', entries: [] } },
      ])
      expect(f.messages.at(-2)).toEqual(response(2, {}))
    } finally {
      await f.dispose()
    }
  })

  it('does not adopt failed activations or stale session objects after a resume', async () => {
    const f = fixture()
    const old = f.session('s')
    try {
      await f.request(request(1, 'session/new'))
      await f.writer.write({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'failed' } })
      f.change(old, 'title', 'Failed creation')
      const current = f.session('s')
      await f.request(request(2, 'session/resume', 's'))
      await f.writer.write(response(2, {}))
      f.change(old, 'title', 'Stale')
      f.change(current, 'title', 'Current')
      await f.writer.write(response(3, {}))
      expect(updates(f.messages)).toEqual([
        { sessionId: 's', update: { sessionUpdate: 'session_info_update', title: 'Current' } },
      ])
    } finally {
      await f.dispose()
    }
  })

  it('keeps ownership after a rejected duplicate resume and ignores repeated projection watermarks', async () => {
    const f = fixture()
    const s = f.session('s')
    try {
      await f.request(request(1, 'session/new'))
      await f.writer.write(response(1, { sessionId: 's' }))
      await f.request(request(2, 'session/resume', 's'))
      await f.writer.write({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32602, message: 'already active' },
      })
      f.change(s, 'title', 'Current', 2)
      f.change(s, 'title', 'Repeated', 2)
      f.change(s, 'title', 'Old', 1)
      await f.writer.write(response(3, {}))
      expect(updates(f.messages)).toEqual([
        { sessionId: 's', update: { sessionUpdate: 'session_info_update', title: 'Current' } },
      ])
    } finally {
      await f.dispose()
    }
  })

  it('does not publish a session already disposed before its activation response', async () => {
    const f = fixture()
    const s = f.session('s', { title: 'Already closed' })
    try {
      await f.request(request(1, 'session/new'))
      f.sessions.delete('s')
      await f.writer.write(response(1, { sessionId: 's' }))
      f.change(s, 'title', 'Late title')
      await f.writer.write(response(2, {}))
      expect(updates(f.messages)).toEqual([])
    } finally {
      await f.dispose()
    }
  })

  it('keeps a still-live session visible when a close request was rejected', async () => {
    const f = fixture()
    const s = f.session('s')
    try {
      await f.request(request(1, 'session/new'))
      await f.writer.write(response(1, { sessionId: 's' }))
      await f.request(request(2, 'session/close', 's'))
      await f.writer.write({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32602, message: 'invalid params' },
      })
      f.change(s, 'title', 'Still open')
      await f.writer.write(response(3, {}))
      expect(updates(f.messages)).toEqual([
        { sessionId: 's', update: { sessionUpdate: 'session_info_update', title: 'Still open' } },
      ])
    } finally {
      await f.dispose()
    }
  })

  it('drains a blocked update before transport disposal completes', async () => {
    let unblock!: () => void
    let entered!: () => void
    const block = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const writing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const f = fixture(async (message) => {
      if ('method' in message) {
        entered()
        await block
      }
    })
    const s = f.session('s')
    await f.request(request(1, 'session/new'))
    await f.writer.write(response(1, { sessionId: 's' }))
    f.change(s, 'title', 'Last title')
    await writing
    let disposed = false
    const disposal = f.dispose().then(() => {
      disposed = true
    })
    expect(f.listeners.size).toBe(0)
    expect(disposed).toBe(false)
    unblock()
    await disposal
    expect(updates(f.messages)).toHaveLength(1)
  })

  it('keeps presentation ahead of a prompt response while output is blocked', async () => {
    let unblock!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const writing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const f = fixture(async (message) => {
      if ('method' in message && message.method === 'session/update') {
        entered()
        await blocked
      }
    })
    const s = f.session('s')
    try {
      await f.request(request(1, 'session/new'))
      await f.writer.write(response(1, { sessionId: 's' }))
      f.change(s, 'title', 'Title')
      await writing
      const settled = f.writer.write(response(2, { stopReason: 'end_turn' }))
      expect(f.messages).toHaveLength(1)
      unblock()
      await settled
      expect(
        f.messages.map((message) => ('method' in message ? message.method : message.id)),
      ).toEqual([1, 'session/update', 2])
    } finally {
      unblock()
      await f.dispose()
    }
  })

  it('closes the official input on notification write failure and removes listeners', async () => {
    const failure = new Error('output disconnected')
    const f = fixture((message) => {
      if ('method' in message) throw failure
    })
    const s = f.session('s')
    await f.request(request(1, 'session/new'))
    await f.writer.write(response(1, { sessionId: 's' }))
    const read = f.reader.read()
    const failedRead = expect(read).rejects.toBe(failure)
    f.change(s, 'title', 'Title')
    await failedRead
    expect(f.listeners.size).toBe(0)
    await expect(f.writer.write(response(2, {}))).rejects.toBe(failure)
    await expect(f.dispose()).rejects.toBe(failure)
  })

  it('enriches generic tools without changing explicit categories', async () => {
    const f = fixture()
    try {
      const generic: AnyMessage = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 's',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call',
            title: 'read_file',
            kind: 'other',
            rawInput: { path: 'a.ts' },
          },
        },
      }
      await f.writer.write(generic)
      expect(updates(f.messages)[0]?.update).toMatchObject({
        kind: 'read',
        rawInput: { path: 'a.ts' },
      })
      const explicit: AnyMessage = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 's',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call',
            title: 'read_file',
            kind: 'search',
          },
        },
      }
      await f.writer.write(explicit)
      expect(f.messages.at(-1)).toEqual(explicit)
    } finally {
      await f.dispose()
    }
  })

  it('preserves bidirectional requests with the same id and passes permission messages through', async () => {
    const f = fixture()
    f.session('s', { title: 'Session' })
    try {
      await f.request(request(8, 'session/new'))
      const permission = {
        jsonrpc: '2.0',
        id: 8,
        method: 'session/request_permission',
        params: { sessionId: 's', toolCall: { toolCallId: 'tool' }, options: [] },
      } satisfies AnyMessage
      await f.writer.write(permission)
      await f.request(response(8, { outcome: { outcome: 'cancelled' } }))
      await f.writer.write(response(8, { sessionId: 's' }))
      expect(f.messages[0]).toEqual(permission)
      expect(updates(f.messages)).toEqual([
        { sessionId: 's', update: { sessionUpdate: 'session_info_update', title: 'Session' } },
      ])
    } finally {
      await f.dispose()
    }
  })
})
