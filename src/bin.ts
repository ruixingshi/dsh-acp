#!/usr/bin/env node
/** Boot the official Harness ACP profile or the legacy rich adapter. */

import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { VERSION } from './version.js'

const NAME = 'dsh-acp'

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
  npx --yes @dumbo-ai/dsh-acp [options]

Options:
      --patch <path>   Patch the official DeepSeek Harness ACP profile; repeatable
  -c, --config <path>  Boot a legacy complete Cordis configuration
  -h, --help           Show this help
  -v, --version        Show the package version

Default runtime:
  DeepSeek Harness official ACP profile

Legacy configuration precedence:
  --config, then ./cordis.yml; --patch cannot be combined with legacy mode

Environment:
  DEEPSEEK_API_KEY      DeepSeek API key
  DEEPSEEK_BASE_URL     Optional inherited DeepSeek-compatible endpoint
  DSH_HOME              Optional Harness state and profile directory
  DSH_PERMISSION_MODE   Optional Harness permission preset
`)
  process.exit(0)
}

const localConfig = resolve(process.cwd(), 'cordis.yml')
const configPath =
  values.config === undefined
    ? existsSync(localConfig)
      ? localConfig
      : undefined
    : resolveConfigPath(values.config, undefined)
const patches = values.patch ?? []

if (configPath !== undefined && patches.length > 0) {
  process.stderr.write(`${NAME}: --patch cannot be combined with --config or ./cordis.yml\n`)
  process.exit(1)
}

if (configPath === undefined) {
  process.argv = [
    process.execPath,
    NAME,
    '--profile',
    'acp',
    ...patches.flatMap((path) => ['--patch', path]),
  ]
  const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js')
  await runCli()
} else {
  installFailLoud(NAME)
  loadEnv(NAME)
  const ctx = await boot(NAME, configPath)
  process.stdin.once('end', () => {
    void ctx.fiber.dispose().then(() => process.exit(0))
  })
}
