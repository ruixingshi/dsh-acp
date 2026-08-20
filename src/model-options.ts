/** ACP session configuration options for Harness model routing. */

import type { SessionConfigOption, SessionConfigSelectGroup } from '@agentclientprotocol/sdk'
import type { ModelInfo, ModelSelection, ResolvedModelInfo } from './runtime.js'

/** Stable ACP config id for provider-qualified model selection. */
export const MODEL_CONFIG_ID = 'model'

/** Stable ACP config id for adapter-owned reasoning effort. */
export const REASONING_CONFIG_ID = 'reasoning_effort'

const MODEL_VALUE_PREFIX = 'dsh:model:'

/** Encode one provider/model pair as an opaque ACP selector value. */
export function encodeModelSelection(
  selection: Pick<ModelSelection, 'provider' | 'model'>,
): string {
  return `${MODEL_VALUE_PREFIX}${Buffer.from(
    JSON.stringify([selection.provider, selection.model]),
    'utf8',
  ).toString('base64url')}`
}

/** Decode and validate one provider-qualified ACP selector value. */
export function decodeModelSelection(value: string): Pick<ModelSelection, 'provider' | 'model'> {
  if (!value.startsWith(MODEL_VALUE_PREFIX)) throw new Error('invalid model selection')
  let decoded: unknown
  try {
    decoded = JSON.parse(
      Buffer.from(value.slice(MODEL_VALUE_PREFIX.length), 'base64url').toString('utf8'),
    )
  } catch {
    throw new Error('invalid model selection')
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== 'string' ||
    decoded[0].length === 0 ||
    typeof decoded[1] !== 'string' ||
    decoded[1].length === 0
  ) {
    throw new Error('invalid model selection')
  }
  const selection = { provider: decoded[0], model: decoded[1] }
  if (encodeModelSelection(selection) !== value) throw new Error('invalid model selection')
  return selection
}

/** Resolve the effort value a selector should display for an exact model. */
export function effectiveReasoningEffort(
  selection: ModelSelection,
  resolved: ResolvedModelInfo | undefined,
): string | undefined {
  const reasoning = resolved?.reasoning
  if (reasoning === undefined || reasoning.efforts.length === 0) return undefined
  if (
    selection.reasoningEffort !== undefined &&
    reasoning.efforts.some((effort) => effort.id === selection.reasoningEffort)
  ) {
    return selection.reasoningEffort
  }
  if (
    reasoning.defaultEffort !== undefined &&
    reasoning.efforts.some((effort) => effort.id === reasoning.defaultEffort)
  ) {
    return reasoning.defaultEffort
  }
  return reasoning.efforts[0]?.id
}

/** Build the complete ACP model and reasoning configuration state. */
export function buildConfigOptions(
  catalog: readonly ModelInfo[],
  selection: ModelSelection,
  resolved?: ResolvedModelInfo,
): SessionConfigOption[] {
  const providers = new Map<string, { name: string; models: ModelInfo[] }>()
  for (const model of catalog) {
    const provider = providers.get(model.provider)
    if (provider === undefined) {
      providers.set(model.provider, { name: model.providerName, models: [model] })
    } else if (!provider.models.some((entry) => entry.id === model.id)) {
      provider.models.push(model)
    }
  }

  let selectedProvider = providers.get(selection.provider)
  if (selectedProvider === undefined) {
    selectedProvider = { name: selection.provider, models: [] }
    providers.set(selection.provider, selectedProvider)
  }
  if (!selectedProvider.models.some((model) => model.id === selection.model)) {
    selectedProvider.models.push({
      provider: selection.provider,
      providerName: selectedProvider.name,
      id: selection.model,
      name: selection.model,
      description: 'Current model (not advertised by the provider catalog)',
    })
  }

  const groups: SessionConfigSelectGroup[] = [...providers.entries()].map(
    ([providerId, provider]) => ({
      group: providerId,
      name: provider.name,
      options: provider.models.map((model) => ({
        value: encodeModelSelection({ provider: model.provider, model: model.id }),
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      })),
    }),
  )

  const options: SessionConfigOption[] = [
    {
      id: MODEL_CONFIG_ID,
      name: 'Model',
      description: 'Provider and model used by this DeepSeek Harness session',
      category: 'model',
      type: 'select',
      currentValue: encodeModelSelection(selection),
      options: groups,
    },
  ]

  const currentEffort = effectiveReasoningEffort(selection, resolved)
  if (resolved?.reasoning !== undefined && currentEffort !== undefined) {
    options.push({
      id: REASONING_CONFIG_ID,
      name: 'Reasoning effort',
      description: 'How much reasoning the selected model should use',
      category: 'thought_level',
      type: 'select',
      currentValue: currentEffort,
      options: resolved.reasoning.efforts.map((effort) => ({
        value: effort.id,
        name: effort.name,
        ...(effort.description === undefined ? {} : { description: effort.description }),
      })),
    })
  }
  return options
}
