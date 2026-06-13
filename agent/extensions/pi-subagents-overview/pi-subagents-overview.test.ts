import { describe, it, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const HOME = process.env.HOME || '/home/abdwhb'
const SETTINGS_PATH = path.join(HOME, '.pi', 'agent', 'settings.json')

function parseFrontmatterSimple(raw: string): Record<string, string> | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) return null
  const yaml = match[1]
  const result: Record<string, string> = {}
  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const val = line.slice(colonIdx + 1).trim()
    result[key] = val
  }
  return result
}

// Render function for testing truncation - at module scope to avoid unicorn warning
function renderLine(line: string, width: number): string {
  if (line.length <= width) return line
  return line.substring(0, width - 1) + '…'
}

describe('pi-subagents-overview', () => {
  describe('readOverrides', () => {
    it('finds agents with overrides in settings.json', () => {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      const overrides = parsed?.subagents?.agentOverrides ?? {}
      const agentNames = Object.keys(overrides)
      expect(agentNames.length).toBeGreaterThan(0)
    })

    it('worker override has safe_bash tool', () => {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      const overrides = parsed?.subagents?.agentOverrides ?? {}
      const workerTools = overrides.worker?.tools
      expect(Array.isArray(workerTools)).toBe(true)
      expect(workerTools).toContain('safe_bash')
      expect(workerTools).not.toContain('bash')
    })

    it('scout override tools are valid', () => {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      const overrides = parsed?.subagents?.agentOverrides ?? {}
      const scoutTools = overrides.scout?.tools
      expect(Array.isArray(scoutTools)).toBe(true)
      expect(scoutTools).not.toContain('bash')
    })

    it('all override tools are arrays', () => {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      const overrides = parsed?.subagents?.agentOverrides ?? {}
      for (const [name, ov] of Object.entries(overrides)) {
        if (ov.tools !== undefined && ov.tools !== false) {
          expect(Array.isArray(ov.tools), `${name}.tools should be array`).toBe(true)
        }
      }
    })
  })

  describe('parseBuiltinAgents', () => {
    const builtinNames = ['scout', 'researcher', 'planner', 'worker', 'reviewer', 'context-builder', 'oracle', 'delegate']
    const BUILTIN_AGENTS_DIR = path.join(HOME, '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents', 'agents')

    it.each(builtinNames)('parses %s.md with frontmatter', (agentName) => {
      const filePath = path.join(BUILTIN_AGENTS_DIR, `${agentName}.md`)
      expect(fs.existsSync(filePath)).toBe(true)
      const raw = fs.readFileSync(filePath, 'utf-8')
      const fm = parseFrontmatterSimple(raw)
      expect(fm).not.toBeNull()
      expect(fm!.name).toBe(agentName)
      expect(fm!.description).toBeTruthy()
      expect(fm!.tools).toBeTruthy()
    })
  })

  describe('renderer truncation', () => {
    it('truncates long lines to width', () => {
      const longLine = 'a'.repeat(100)
      const truncated = renderLine(longLine, 70)
      expect(truncated.length).toBeLessThanOrEqual(70)
    })

    it('leaves short lines unchanged', () => {
      const shortLine = 'short line'
      const unchanged = renderLine(shortLine, 70)
      expect(unchanged).toBe(shortLine)
    })
  })

  describe('videographer agent', () => {
    const filePath = path.join(HOME, '.pi', 'agent', 'agents', 'videographer.md')

    it('videographer.md file exists', () => {
      expect(fs.existsSync(filePath)).toBe(true)
    })

    it('videographer.md has valid frontmatter', () => {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const fm = parseFrontmatterSimple(raw)
      expect(fm).not.toBeNull()
      expect(fm!.name).toBe('videographer')
      expect(fm!.description).toBeTruthy()
      expect(fm!.tools).toBeTruthy()
    })
  })

  describe('widget line formatting', () => {
    it('widget line does not exceed reasonable length', () => {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      const overrides = parsed?.subagents?.agentOverrides ?? {}
      const overrideCount = Object.keys(overrides).length

      const BUILTIN_AGENTS_DIR = path.join(HOME, '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents', 'agents')
      const builtinCount = fs.readdirSync(BUILTIN_AGENTS_DIR).filter(f => f.endsWith('.md')).length
      const userAgentsDir = path.join(HOME, '.pi', 'agent', 'agents')
      const userCount = fs.existsSync(userAgentsDir)
        ? fs.readdirSync(userAgentsDir).filter(f => f.endsWith('.md')).length
        : 0

      const parts: string[] = []
      parts.push(`🧠 Subagents: ${builtinCount}B/${userCount}U`)
      if (overrideCount > 0) parts.push(`${overrideCount} ovr`)
      parts.push(`total ${builtinCount + userCount}`)

      const widgetLine = parts.join(' · ')
      expect(widgetLine.length).toBeLessThan(120)
    })
  })
})