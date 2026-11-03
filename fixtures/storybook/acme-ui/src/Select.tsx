export interface SelectProps<T> {
  options: T[]
  value?: T
  onChange?: (value: T) => void
  renderOption?: (option: T) => React.ReactNode
  getKey: (option: T) => string
  placeholder?: string
}

export function Select<T>({ options, value, onChange, renderOption, getKey, placeholder = "Select…" }: SelectProps<T>) {
  return (
    <ul role="listbox" aria-label={placeholder}>
      {options.map((option) => (
        <li key={getKey(option)} role="option" aria-selected={option === value} onClick={() => onChange?.(option)}>
          {renderOption ? renderOption(option) : getKey(option)}
        </li>
      ))}
    </ul>
  )
}
