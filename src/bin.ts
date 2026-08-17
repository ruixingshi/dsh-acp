#!/usr/bin/env node
/** Boot the rich ACP stdio adapter from a Cordis configuration. */

import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { parseArgs } from 'node:util'

const NAME = 'dsh-acp'

installFailLoud(NAME)
loadEnv(NAME)
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: 'string', short: 'c' } },
  strict: true,
})
const ctx = await boot(NAME, resolveConfigPath(values.config ?? './cordis.yml', undefined))
process.stdin.once('end', () => {
  void ctx.fiber.dispose().then(() => process.exit(0))
})
