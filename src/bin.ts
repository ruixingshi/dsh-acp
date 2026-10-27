#!/usr/bin/env node
/** Launch the official Harness ACP profile with the bundled presentation plugin. */
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { VERSION } from './version.js'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
    patch: { type: 'string', multiple: true },
    version: { type: 'boolean', short: 'v' },
  },
  strict: true,
})
if (values.version === true) {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}
if (values.help === true) {
  process.stdout.write(`dsh-acp ${VERSION}

Usage:
  dsh-acp [options]
  npx --yes @dumbo-ai/dsh-acp [options]

Options:
      --patch <path>   Customize the Harness profile; repeatable
  -h, --help           Show this help
  -v, --version        Show the package version

Default runtime:
  DeepSeek Harness official ACP profile with plans, titles and tool categories
  Custom model settings target the dsh-acp entry in a --patch overlay.

Environment:
  DEEPSEEK_API_KEY      DeepSeek API key
  DEEPSEEK_BASE_URL     Optional inherited DeepSeek-compatible endpoint
  DSH_HOME              Optional Harness state and profile directory
  DSH_PERMISSION_MODE   Optional Harness permission preset
`)
  process.exit(0)
}
if (values.config !== undefined) {
  process.stderr.write(
    'dsh-acp: --config has been removed. Use --patch with a profile overlay (id: dsh-acp); complete cordis.yml files are no longer loaded.\n',
  )
  process.exit(1)
}
process.argv = [
  process.execPath,
  'dsh-acp',
  '--profile',
  'acp',
  '--patch',
  fileURLToPath(new URL('../assets/acp.patch.yml', import.meta.url)),
  ...(values.patch ?? []).flatMap((path) => ['--patch', path]),
]
const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js')
await runCli()
