/**
 * Protocol-neutral runtime contracts implemented by the DeepSeek Harness bridge.
 *
 * @module @dumbo/dsh-acp/runtime
 */

/** Provider/model route selected for one session. */
export interface ModelSelection {
  /** Registered Harness provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Optional adapter-owned reasoning effort. */
  reasoningEffort?: string
}

/** One selectable reasoning effort reported by a model adapter. */
export interface ReasoningEffortInfo {
  /** Stable value accepted by the Harness adapter. */
  id: string
  /** Human-readable selector label. */
  name: string
  /** Optional distinction from nearby effort levels. */
  description?: string
}

/** Reasoning metadata for an exact provider/model route. */
export interface ModelReasoningInfo {
  /** Efforts in provider-preferred display order. */
  efforts: ReasoningEffortInfo[]
  /** Provider-configured default effort. */
  defaultEffort?: string
}

/** Advisory model catalog entry detached from Harness services. */
export interface ModelInfo {
  /** Registered Harness provider route. */
  provider: string
  /** Human-readable provider label. */
  providerName: string
  /** Provider-owned model id. */
  id: string
  /** Human-readable model label. */
  name: string
  /** Optional distinction from nearby models. */
  description?: string
  /** Accepted input modalities when the provider reports them. */
  inputModalities?: string[]
}

/** Exact-route model metadata used to configure one live session. */
export interface ResolvedModelInfo extends ModelInfo {
  /** Context capacity when known. */
  contextWindow?: number
  /** Selectable reasoning efforts when exposed by the provider. */
  reasoning?: ModelReasoningInfo
}

/** Displayable text emitted by a Harness tool. */
export interface RuntimeTextContent {
  type: 'text'
  text: string
}

/** Non-text tool output that cannot be transferred without an attachment resolver. */
export interface RuntimeAttachmentContent {
  type: 'attachment'
  description: string
}

/** Tool output retained by the ACP projector. */
export type RuntimeContent = RuntimeTextContent | RuntimeAttachmentContent

/** One portable plan entry projected from the Harness todo log. */
export interface RuntimePlanEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Events a runtime session may publish to the ACP presentation layer. */
export type RuntimeEvent =
  | { type: 'assistant-text'; text: string; messageId?: string }
  | { type: 'assistant-thought'; text: string; messageId?: string }
  | { type: 'tool-call'; callId: string; name: string; arguments: string }
  | {
      type: 'tool-result'
      callId: string
      isError: boolean
      content: RuntimeContent[]
    }
  | { type: 'plan'; entries: RuntimePlanEntry[] }
  | { type: 'usage'; used: number; size: number }
  | { type: 'session-info'; title?: string; updatedAt?: string }

/** Terminal outcome of one accepted runtime prompt. */
export type RuntimeStopReason =
  { kind: 'completed' } | { kind: 'max-tokens' } | { kind: 'cancelled' } | { kind: 'refusal' }

/** One runtime-owned live Harness agent. */
export interface RuntimeSession {
  /** Shared ACP/Harness session identity. */
  readonly id: string
  /** Current selection for the next Harness step. */
  readonly selection: ModelSelection
  /** Replace the selection used by the next Harness step. */
  setSelection(selection: ModelSelection): void
  /** Queue one text prompt and await its correlated terminal outcome. */
  prompt(text: string): Promise<RuntimeStopReason>
  /** Cancel only this session's current activity. */
  cancel(): void
  /** Quiesce and release the exact owned Harness agent. */
  dispose(): Promise<void>
}

/** Inputs needed to create one runtime session. */
export interface CreateRuntimeSessionOptions {
  /** Caller-minted identity shared with ACP before Harness creation begins. */
  sessionId: string
  /** Absolute workspace directory. */
  cwd: string
  /** Initial provider/model selection. */
  selection: ModelSelection
  /** Presentation event sink for this session. */
  onEvent(event: RuntimeEvent): void
  /** Ask the connected ACP client for a one-shot tool decision. */
  requestPermission(request: RuntimePermissionRequest): Promise<RuntimePermissionDecision>
}

/** Harness approval request exposed to the connected ACP client. */
export interface RuntimePermissionRequest {
  callId: string
  /** Programmatic tool name when known. */
  name?: string
  /** Human-readable action title when known. */
  title?: string
  /** Withdrawal signal for a cancelled turn. */
  signal?: AbortSignal
}

/** One-shot permission decision understood by the Harness approval seam. */
export type RuntimePermissionDecision = 'allowed-once' | 'rejected' | 'cancelled'

/** Narrow capability consumed by the ACP protocol agent. */
export interface HarnessRuntime {
  /** Discover every model currently advertised by registered providers. */
  listModels(): Promise<ModelInfo[]>
  /** Resolve exact metadata for one provider/model route. */
  resolveModel(selection: ModelSelection): Promise<ResolvedModelInfo>
  /** Create and own one live Harness session. */
  createSession(options: CreateRuntimeSessionOptions): Promise<RuntimeSession>
  /** Release every session and stop accepting new work. */
  dispose(): Promise<void>
}
