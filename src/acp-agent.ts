/** ACP v1 request handlers backed by a protocol-neutral Harness runtime. */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  PROTOCOL_VERSION,
  RequestError,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import { promptToText, stopReason } from './codec.js'
import {
  MODEL_CONFIG_ID,
  REASONING_CONFIG_ID,
  buildConfigOptions,
  decodeModelSelection,
  effectiveReasoningEffort,
} from './model-options.js'
import { projectRuntimeEvent } from './projector.js'
import type {
  HarnessRuntime,
  ModelInfo,
  ModelSelection,
  ResolvedModelInfo,
  RuntimeEvent,
  RuntimePermissionDecision,
  RuntimePermissionRequest,
  RuntimeSession,
} from './runtime.js'
import { VERSION } from './version.js'

/** Client callbacks used by the ACP request handlers. */
export interface AcpClient {
  /** Publish one presentation update. */
  sessionUpdate(notification: SessionNotification): Promise<void>
  /** Ask the user to approve or reject a tool call. */
  requestPermission(
    request: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse>
}

/** Initial routing and display identity for one ACP connection. */
export interface DshAcpAgentOptions {
  /** Initial route inherited by every new session. */
  initialSelection: ModelSelection
  /** Wire implementation name. */
  name?: string
  /** Human-readable agent title. */
  title?: string
  /** Wire implementation version. */
  version?: string
}

/** Minimal logger accepted by the protocol layer. */
export interface AcpLogger {
  /** Report a contained client notification failure. */
  warn(message: string): void
}

interface SessionRecord {
  runtime: RuntimeSession
  catalog: ModelInfo[]
  resolved: ResolvedModelInfo
  prompting: boolean
  updateTail: Promise<void>
}

function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** ACP v1 agent handler implementation with one exact RuntimeSession per wire session. */
export class DshAcpAgent {
  private readonly sessions = new Map<string, SessionRecord>()
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly runtime: HarnessRuntime,
    private readonly client: AcpClient,
    private readonly options: DshAcpAgentOptions,
    private readonly logger: AcpLogger = {
      warn: (message) => process.stderr.write(`${message}\n`),
    },
  ) {}

  /** Negotiate stable ACP v1 and advertise only implemented capabilities. */
  initialize(_request: InitializeRequest): Promise<InitializeResponse> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: this.options.name ?? 'dsh-acp',
        title: this.options.title ?? 'DeepSeek Harness',
        version: this.options.version ?? VERSION,
      },
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {} },
      },
      authMethods: [],
    })
  }

  /** Create one fresh Harness agent and return its complete selector state. */
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertOpen()
    if (!isAbsolute(params.cwd)) throw invalidParams('cwd must be an absolute path')
    if ((params.additionalDirectories?.length ?? 0) > 0) {
      throw invalidParams('additionalDirectories are not supported')
    }
    if (params.mcpServers.length > 0) throw invalidParams('mcpServers are not supported')

    const catalog = await this.runtime.listModels()
    const initialResolved = await this.runtime.resolveModel(this.options.initialSelection)
    const initialSelection = normalizedSelection(this.options.initialSelection, initialResolved)
    const sessionId = randomUUID()
    const buffered: RuntimeEvent[] = []
    const target: { record?: SessionRecord } = {}
    const onEvent = (event: RuntimeEvent): void => {
      if (target.record === undefined) {
        buffered.push(event)
      } else {
        this.publish(target.record, event)
      }
    }
    const runtime = await this.runtime.createSession({
      sessionId,
      cwd: params.cwd,
      selection: initialSelection,
      onEvent,
      requestPermission: (request) => this.requestPermission(sessionId, request),
    })
    if (this.closed) {
      await runtime.dispose()
      throw RequestError.internalError(undefined, 'ACP connection closed during session creation')
    }
    if (runtime.id !== sessionId) {
      await runtime.dispose()
      throw RequestError.internalError(undefined, 'Harness returned a different session id')
    }
    const record: SessionRecord = {
      runtime,
      catalog: [...catalog],
      resolved: initialResolved,
      prompting: false,
      updateTail: Promise.resolve(),
    }
    target.record = record
    this.sessions.set(sessionId, record)
    for (const event of buffered) this.publish(record, event)
    return {
      sessionId,
      configOptions: buildConfigOptions(record.catalog, runtime.selection, record.resolved),
    }
  }

  /** Replace one model-related configuration option for a live session. */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    this.assertOpen()
    const record = this.requireSession(params.sessionId)
    if (typeof params.value !== 'string') {
      throw invalidParams(`config option "${params.configId}" requires a string value`)
    }

    if (params.configId === MODEL_CONFIG_ID) {
      let selected: Pick<ModelSelection, 'provider' | 'model'>
      try {
        selected = decodeModelSelection(params.value)
      } catch {
        throw invalidParams('invalid provider-qualified model value')
      }
      const available = record.catalog.some(
        (model) => model.provider === selected.provider && model.id === selected.model,
      )
      const current = record.runtime.selection
      if (
        !available &&
        (current.provider !== selected.provider || current.model !== selected.model)
      ) {
        throw invalidParams('selected model is not available in this session')
      }
      const candidate: ModelSelection = {
        ...selected,
        ...(current.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: current.reasoningEffort }),
      }
      const resolved = await this.runtime.resolveModel(candidate)
      if (this.sessions.get(params.sessionId) !== record) {
        throw RequestError.internalError(undefined, 'session closed during model resolution')
      }
      record.resolved = resolved
      record.runtime.setSelection(normalizedSelection(candidate, resolved))
    } else if (params.configId === REASONING_CONFIG_ID) {
      const effort = record.resolved.reasoning?.efforts.find((entry) => entry.id === params.value)
      if (effort === undefined) throw invalidParams('selected reasoning effort is not available')
      record.runtime.setSelection({ ...record.runtime.selection, reasoningEffort: effort.id })
    } else {
      throw invalidParams(`unknown config option: ${params.configId}`)
    }

    return {
      configOptions: buildConfigOptions(record.catalog, record.runtime.selection, record.resolved),
    }
  }

  /** Queue one prompt on its exact Harness agent and await the correlated outcome. */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.assertOpen()
    const record = this.requireSession(params.sessionId)
    if (record.prompting) throw invalidParams('a prompt is already in flight for this session')
    const text = promptToText(params.prompt)
    record.prompting = true
    try {
      const reason = await record.runtime.prompt(text)
      await record.updateTail
      return { stopReason: stopReason(reason) }
    } finally {
      record.prompting = false
    }
  }

  /** Cancel only the addressed session; unknown ids are protocol no-ops. */
  cancel(params: CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.runtime.cancel()
    return Promise.resolve()
  }

  /** Cancel, quiesce, and release one live session. */
  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const record = this.requireSession(params.sessionId)
    this.sessions.delete(params.sessionId)
    record.runtime.cancel()
    await record.runtime.dispose()
    await record.updateTail
    return {}
  }

  /** Close admission and release every connection-owned session and runtime resource. */
  dispose(): Promise<void> {
    return (this.disposal ??= this.disposeOnce())
  }

  private async disposeOnce(): Promise<void> {
    this.closed = true
    const records = [...this.sessions.values()]
    this.sessions.clear()
    for (const record of records) record.runtime.cancel()
    await Promise.all(
      records.map(async (record) => {
        await record.runtime.dispose()
        await record.updateTail
      }),
    )
    await this.runtime.dispose()
  }

  private assertOpen(): void {
    if (this.closed) throw RequestError.internalError(undefined, 'ACP connection is closed')
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  private publish(record: SessionRecord, event: RuntimeEvent): void {
    const sessionId = record.runtime.id
    const update = projectRuntimeEvent(event)
    record.updateTail = record.updateTail
      .then(() => this.client.sessionUpdate({ sessionId, update }))
      .catch((error: unknown) => {
        this.logger.warn(`dsh-acp: session/update failed: ${String(error)}`)
      })
  }

  private async requestPermission(
    sessionId: string,
    request: RuntimePermissionRequest,
  ): Promise<RuntimePermissionDecision> {
    const response = await this.client.requestPermission(
      {
        sessionId,
        toolCall: {
          toolCallId: request.callId,
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.title === undefined ? {} : { title: request.title }),
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
      request.signal,
    )
    if (response.outcome.outcome === 'cancelled') return 'cancelled'
    return response.outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
  }
}

function normalizedSelection(
  selection: ModelSelection,
  resolved: ResolvedModelInfo,
): ModelSelection {
  const effort = effectiveReasoningEffort(selection, resolved)
  return {
    provider: selection.provider,
    model: selection.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  }
}
