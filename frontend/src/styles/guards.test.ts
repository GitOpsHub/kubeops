/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { breakpoints as breakpointValues } from '../lib/breakpoints'

// Read from disk because Vitest stubs every stylesheet import to an empty
// string, raw or not.
const root = join(import.meta.dirname, '..')

function collect(pattern: RegExp) {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => pattern.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => [relative(root, join(root, file)), readFileSync(join(root, file), 'utf8')]),
  )
}

const stylesheets = collect(/\.css$/)
const sources = collect(/\.tsx?$/)

// Colours live in tokens.css so both themes, forced colours, and contrast
// checks have a single place to look. Brand glyphs carry their vendors' fixed
// colours by design.
const colourAllowlist = new Set(['styles/tokens.css', 'components/BrandIcons.tsx'])
const rawColour = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/g

// Mirrors lib/breakpoints.ts, so a layout never switches at a width only one
// stylesheet knows about.
const breakpoints = new Set(Object.values(breakpointValues).map((value) => `${value}px`))

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('style guards', () => {
  it('keeps raw colours inside the token sheet', () => {
    const offenders = Object.entries({ ...stylesheets, ...sources })
      .filter(([path]) => !colourAllowlist.has(path))
      .flatMap(([path, source]) =>
        (stripComments(source).match(rawColour) ?? []).map((match) => `${path}: ${match}`),
      )

    expect(offenders).toEqual([])
  })

  it('only uses the shared breakpoints in width media queries', () => {
    const offenders = Object.entries(stylesheets).flatMap(([path, source]) =>
      [...stripComments(source).matchAll(/@media[^{]*/g)].flatMap(([query]) =>
        [...query.matchAll(/(?:min|max)-width:\s*([\d.]+\w*)/g)]
          .filter(([, value]) => !breakpoints.has(value))
          .map(([, value]) => `${path}: ${query.trim()} (${value})`),
      ),
    )

    expect(offenders).toEqual([])
  })
})
