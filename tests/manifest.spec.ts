import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.js'

interface PackageManifest {
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function isDshPackage(name: string): boolean {
  return name.startsWith('@deepseek-ai/dsh-')
}

describe('published manifest', () => {
  it('reports the package manifest version on every protocol surface', () => {
    const root = readManifest(join(process.cwd(), 'package.json'))
    expect(root.version).toBe(VERSION)
  })

  it('matches the Node.js versions supported by DeepSeek Harness', () => {
    const root = readManifest(join(process.cwd(), 'package.json'))
    expect(root.engines?.node).toBe('^22.19.0 || >=24.0.0')
  })

  it('pins the complete standalone Harness peer closure to one release', () => {
    const root = readManifest(join(process.cwd(), 'package.json'))
    const dependencies = root.dependencies ?? {}
    const version = dependencies['@deepseek-ai/dsh-agent']
    expect(version).toBeDefined()
    expect(root.devDependencies?.['@deepseek-ai/dsh-agent-loop-testkit']).toBe(version)

    const pending = Object.keys(dependencies).filter(isDshPackage)
    const visited = new Set<string>()
    while (pending.length > 0) {
      const name = pending.pop()
      if (name === undefined || visited.has(name)) continue
      visited.add(name)
      expect(dependencies[name], name).toBe(version)

      const manifest = readManifest(join(process.cwd(), 'node_modules', name, 'package.json'))
      for (const peer of Object.keys(manifest.peerDependencies ?? {}).filter(isDshPackage)) {
        expect(dependencies[peer], `${name} requires ${peer}`).toBe(version)
        pending.push(peer)
      }
    }
  })
})
