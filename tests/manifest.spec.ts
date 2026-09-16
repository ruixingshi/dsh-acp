import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.js'

interface PackageManifest {
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
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

  it('pins every directly consumed Harness package to the official CLI release', () => {
    const root = readManifest(join(process.cwd(), 'package.json'))
    const dependencies = root.dependencies ?? {}
    const version = dependencies['@deepseek-ai/dsh']
    expect(version).toBeDefined()
    expect(dependencies['@deepseek-ai/dsh-agent-spine-demo']).toBeUndefined()
    expect(dependencies['@deepseek-ai/dsh-code-runtime']).toBeUndefined()
    for (const [name, dependencyVersion] of Object.entries(dependencies).filter(([name]) =>
      isDshPackage(name),
    )) {
      expect(dependencyVersion, name).toBe(version)
    }
    for (const [name, dependencyVersion] of Object.entries(root.devDependencies ?? {}).filter(
      ([name]) => isDshPackage(name),
    )) {
      expect(dependencyVersion, name).toBe(version)
    }
  })
})
