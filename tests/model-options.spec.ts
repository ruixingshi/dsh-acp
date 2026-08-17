import { describe, expect, it } from 'vitest'
import {
  MODEL_CONFIG_ID,
  REASONING_CONFIG_ID,
  buildConfigOptions,
  decodeModelSelection,
  encodeModelSelection,
} from '../src/model-options.js'
import type { ModelInfo, ResolvedModelInfo } from '../src/runtime.js'

const models: ModelInfo[] = [
  {
    provider: 'deepseek-official',
    providerName: 'DeepSeek',
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    description: 'Strong general-purpose model',
  },
  {
    provider: 'gateway',
    providerName: 'Gateway',
    id: 'deepseek-v4-pro',
    name: 'V4 Pro (Gateway)',
  },
]

describe('model config options', () => {
  it('round-trips provider-qualified model values', () => {
    const encoded = encodeModelSelection({ provider: 'provider/with slash', model: '模型/v4' })
    expect(encoded).toMatch(/^dsh:model:/)
    expect(decodeModelSelection(encoded)).toEqual({
      provider: 'provider/with slash',
      model: '模型/v4',
    })
  })

  it('groups duplicate model ids by provider', () => {
    const options = buildConfigOptions(models, {
      provider: 'gateway',
      model: 'deepseek-v4-pro',
    })
    const model = options.find((option) => option.id === MODEL_CONFIG_ID)

    expect(model).toMatchObject({
      type: 'select',
      category: 'model',
      currentValue: encodeModelSelection({
        provider: 'gateway',
        model: 'deepseek-v4-pro',
      }),
    })
    expect(model && 'options' in model ? model.options : []).toEqual([
      {
        group: 'deepseek-official',
        name: 'DeepSeek',
        options: [
          {
            value: encodeModelSelection({
              provider: 'deepseek-official',
              model: 'deepseek-v4-pro',
            }),
            name: 'DeepSeek V4 Pro',
            description: 'Strong general-purpose model',
          },
        ],
      },
      {
        group: 'gateway',
        name: 'Gateway',
        options: [
          {
            value: encodeModelSelection({ provider: 'gateway', model: 'deepseek-v4-pro' }),
            name: 'V4 Pro (Gateway)',
          },
        ],
      },
    ])
  })

  it('keeps a configured pass-through model visible when absent from the catalog', () => {
    const options = buildConfigOptions(models, {
      provider: 'deepseek-official',
      model: 'deployment-only-model',
    })
    const model = options.find((option) => option.id === MODEL_CONFIG_ID)
    const groups = model && 'options' in model ? model.options : []

    expect(groups[0]).toMatchObject({
      group: 'deepseek-official',
      options: [
        { name: 'DeepSeek V4 Pro' },
        {
          value: encodeModelSelection({
            provider: 'deepseek-official',
            model: 'deployment-only-model',
          }),
          name: 'deployment-only-model',
          description: 'Current model (not advertised by the provider catalog)',
        },
      ],
    })
  })

  it('adds reasoning effort only when the selected model exposes it', () => {
    const resolved: ResolvedModelInfo = {
      ...models[0]!,
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'max', name: 'Maximum', description: 'Use the full reasoning budget' },
        ],
        defaultEffort: 'max',
      },
    }
    const options = buildConfigOptions(
      models,
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'off' },
      resolved,
    )

    expect(options.find((option) => option.id === REASONING_CONFIG_ID)).toEqual({
      id: REASONING_CONFIG_ID,
      name: 'Reasoning effort',
      description: 'How much reasoning the selected model should use',
      category: 'thought_level',
      type: 'select',
      currentValue: 'off',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'max', name: 'Maximum', description: 'Use the full reasoning budget' },
      ],
    })
  })

  it('falls back to the new model default when the old effort is unsupported', () => {
    const resolved: ResolvedModelInfo = {
      ...models[0]!,
      reasoning: {
        efforts: [{ id: 'high', name: 'High' }],
        defaultEffort: 'high',
      },
    }
    const options = buildConfigOptions(
      models,
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
      resolved,
    )

    expect(options.find((option) => option.id === REASONING_CONFIG_ID)).toMatchObject({
      currentValue: 'high',
    })
  })
})
