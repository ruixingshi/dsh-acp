/** Start a real Harness followup independently of ACP, after an atomic file trigger. */
import { readFile, watch } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'fixture-autonomous'
export const inject = ['agents']
export function apply(ctx) {
  ctx.effect(() => {
    const abort = new AbortController()
    const root = dirname(process.env.DSH_ACP_TEST_FILE)
    const run = (async () => {
      try {
        for await (const { filename } of watch(root, { signal: abort.signal })) {
          if (filename !== 'autonomous.json') continue
          const { sessionId, text } = JSON.parse(await readFile(join(root, filename), 'utf8'))
          abort.signal.throwIfAborted()
          ctx.agents
            .get(sessionId)
            .followup(
              createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
            )
          return
        }
      } catch (error) {
        if (!abort.signal.aborted) throw error
      }
    })()
    void run.catch((error) => ctx.logger.error(error))
    return async () => {
      abort.abort()
      await run
    }
  })
}
