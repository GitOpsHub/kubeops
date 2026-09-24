import './SearchInput.css'

type Props = {
  /** Accessible name. The placeholder is not a label. */
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
}

export function SearchInput({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
  className = '',
}: Props) {
  return (
    <span className={`search-input ${className}`.trim()}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.5 10.5 3 3" />
      </svg>
      <input
        className="input"
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  )
}
