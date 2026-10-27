import { describe, expect, it } from 'vitest'
import { planUpdate, titleUpdate, toolKind } from '../src/projector.js'

describe('Harness presentation mappings', () => {
  it('preserves task status and clears a previous plan for a new turn', () => {
    expect(
      planUpdate([
        { content: 'Inspect', status: 'in_progress' },
        { content: 'Ship', status: 'pending' },
      ]),
    ).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Inspect', status: 'in_progress', priority: 'medium' },
        { content: 'Ship', status: 'pending', priority: 'medium' },
      ],
    })
    expect(planUpdate(null)).toEqual({ sessionUpdate: 'plan', entries: [] })
  })
  it('forwards accepted titles and leaves untitled sessions alone', () => {
    expect(titleUpdate('修复登录问题')).toEqual({
      sessionUpdate: 'session_info_update',
      title: '修复登录问题',
    })
    expect(titleUpdate(null)).toBeUndefined()
    expect(titleUpdate(undefined)).toBeUndefined()
  })
  it.each([
    ['read_file', 'read'],
    ['write_file', 'edit'],
    ['apply_patch', 'edit'],
    ['delete_file', 'delete'],
    ['rename_file', 'move'],
    ['web_search', 'search'],
    ['bash', 'execute'],
    ['web_fetch', 'fetch'],
    ['todo_write', 'think'],
    ['mcp__external__read_file', 'other'],
    ['custom_tool', 'other'],
  ])('classifies %s as %s', (name, kind) => {
    expect(toolKind(name)).toBe(kind)
  })
})
