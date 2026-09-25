import { useState } from 'react'
import { WrapIcon } from './icons'
import { CopyButton } from './ui/CopyButton'
import './ManifestCode.css'

type Props = {
  code: string
  /** Names the code block, e.g. "YAML for payments-api". */
  label: string
  /** What the copy button copies, for its name: "Copy YAML". */
  copyLabel?: string
  language?: string
}

/**
 * A read-only code pane: line numbers, wrap on demand, and copy. Each line is
 * its own row, so a wrapped line keeps its number beside its first visual
 * line; the numbers are hidden from assistive technology and from selection,
 * so copying by hand yields the code alone.
 */
export function ManifestCode({ code, label, copyLabel = 'YAML', language = 'YAML' }: Props) {
  const [wrap, setWrap] = useState(false)
  const lines = code.split('\n')
  // Line numbers take the width of the largest one, not a fixed guess.
  const gutter = `${String(lines.length).length + 1}ch`

  return (
    <div className={`manifest-code${wrap ? ' is-wrapped' : ''}`}>
      <div className="manifest-code-bar">
        <span className="manifest-code-meta">
          {language} · {lines.length.toLocaleString()} {lines.length === 1 ? 'line' : 'lines'}
        </span>
        <span className="manifest-code-actions">
          <button
            type="button"
            className={`manifest-code-tool${wrap ? ' is-active' : ''}`}
            aria-pressed={wrap}
            aria-label="Wrap lines"
            title="Wrap lines"
            onClick={() => setWrap((current) => !current)}
          >
            <WrapIcon aria-hidden="true" />
          </button>
          <CopyButton value={code} label={copyLabel} className="manifest-code-copy" />
        </span>
      </div>
      <pre className="code-pane" aria-label={label} style={{ '--gutter': gutter } as object}>
        <code>
          {lines.map((line, index) => (
            <span className="code-line" key={index}>
              <span className="code-ln" aria-hidden="true">
                {index + 1}
              </span>
              <span className="code-text">{line || ' '}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
