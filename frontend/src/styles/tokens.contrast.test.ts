/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Read from disk because Vitest stubs every stylesheet import to an empty string.
const sheet = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

type Theme = 'light' | 'dark'
type RGBA = [number, number, number, number]

const declarations = new Map<string, string>()
for (const [, name, value] of sheet.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
  // The first declaration is the :root one; theme blocks only set color-scheme.
  if (!declarations.has(name)) declarations.set(name, value.trim())
}

/** Splits on top-level commas only, so `rgb(1 2 3 / 4%)` stays whole. */
function splitArgs(value: string) {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}

function parseColour(value: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [n >> 16, (n >> 8) & 255, n & 255, 1]
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+)%)?\)$/.exec(value)
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4] / 100]
  throw new Error(`Unparsed colour: ${value}`)
}

/** A token's colour in one theme, following var() and light-dark(). */
function resolve(name: string, theme: Theme): RGBA {
  const raw = declarations.get(name)
  if (!raw) throw new Error(`Unknown token ${name}`)
  let value = raw
  const pair = /^light-dark\((.*)\)$/s.exec(value)
  if (pair) value = splitArgs(pair[1])[theme === 'light' ? 0 : 1]
  const alias = /^var\((--[\w-]+)\)$/.exec(value)
  return alias ? resolve(alias[1], theme) : parseColour(value)
}

/** Translucent fills are judged as painted over the surface beneath them. */
function over([r, g, b, a]: RGBA, [br, bg, bb]: RGBA): RGBA {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1]
}

function luminance([r, g, b]: RGBA) {
  const channel = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function ratio(fg: RGBA, bg: RGBA) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * `background` may be `--soft-token on --base-token` for a tinted fill. The
 * foreground is always opaque.
 */
function contrast(foreground: string, background: string, theme: Theme) {
  const [fill, base] = background.split(' on ')
  const bg = base ? over(resolve(fill, theme), resolve(base, theme)) : resolve(fill, theme)
  return ratio(resolve(foreground, theme), bg)
}

const surfaces = ['--canvas', '--surface', '--surface-raised', '--surface-hover']
const tones = ['ok', 'warn', 'err', 'info', 'idle']

// Body copy: WCAG AA for normal-size text.
const textPairs: [string, string][] = [
  ...['--text', '--text-muted', '--text-subtle'].flatMap((fg) =>
    [...surfaces, '--surface-sunken', '--surface-selected'].map((bg): [string, string] => [fg, bg]),
  ),
  ...['--accent', ...tones.map((tone) => `--${tone}-fg`)].flatMap((fg) =>
    surfaces.map((bg): [string, string] => [fg, bg]),
  ),
  // Badges and banners: a tone's text on its own tint, over either page layer.
  ...tones.flatMap((tone) =>
    ['--surface', '--canvas'].map((base): [string, string] => [
      `--${tone}-fg`,
      `--${tone}-soft on ${base}`,
    ]),
  ),
  ['--accent', '--accent-soft on --surface'],
  ['--accent-fg', '--accent'],
  ['--text-inverse', '--surface-inverse'],
  ...['--code-fg', '--code-muted', '--log-err', '--log-warn', '--log-info', '--log-debug'].map(
    (fg): [string, string] => [fg, '--code-bg'],
  ),
]

// Non-text: WCAG 1.4.11, 3:1 for a boundary or mark that must be seen.
const uiPairs: [string, string][] = [
  ...surfaces.map((bg): [string, string] => ['--focus-ring-color', bg]),
  // Input edges and the off switch track are the only sign of the control.
  ...surfaces.map((bg): [string, string] => ['--border-control', bg]),
  ...tones.flatMap((tone) => surfaces.map((bg): [string, string] => [`--${tone}-solid`, bg])),
  ...[1, 2, 3, 4, 5, 6].flatMap((slot) =>
    ['--surface', '--surface-raised'].map((bg): [string, string] => [`--chart-${slot}`, bg]),
  ),
]

describe.each<Theme>(['light', 'dark'])('%s theme token contrast', (theme) => {
  it.each(textPairs)('%s on %s reads at 4.5:1 or better', (fg, bg) => {
    expect(contrast(fg, bg, theme)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(uiPairs)('%s on %s stands out at 3:1 or better', (fg, bg) => {
    expect(contrast(fg, bg, theme)).toBeGreaterThanOrEqual(3)
  })
})
