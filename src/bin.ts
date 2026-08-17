#!/usr/bin/env node
/** Boot the standalone rich ACP stdio adapter. */

import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { VERSION } from './version.js'

const NAME = 'dsh-acp'

installFailLoud(NAME)
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
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
  npx --yes @dumbo/dsh-acp [options]

Options:
  -c, --config <path>  Use a custom Cordis configuration
  -h, --help           Show this help
  -v, --version        Show the package version

Configuration precedence:
  --config, ./cordis.yml, bundled standalone defaults

Environment:
  DEEPSEEK_API_KEY      DeepSeek API key
  DEEPSEEK_BASE_URL     Optional DeepSeek-compatible endpoint
  DSH_PERMISSION_MODE   workspace-write (default) or danger-full-access
`)
  process.exit(0)
}

loadEnv(NAME)
const localConfig = resolve(process.cwd(), 'cordis.yml')
const bundledConfig = fileURLToPath(new URL('../assets/cordis.default.yml', import.meta.url))
const configPath =
  values.config === undefined
    ? existsSync(localConfig)
      ? localConfig
      : bundledConfig
    : resolveConfigPath(values.config, undefined)
const ctx = await boot(NAME, configPath)
process.stdin.once('end', () => {
  void ctx.fiber.dispose().then(() => process.exit(0))
})
