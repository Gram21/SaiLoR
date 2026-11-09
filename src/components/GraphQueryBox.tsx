// [impl->req~ui-400~1]
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useT } from '../i18n'
import { CypherError, isCypher, parseCypher } from '../model/graphCypher'
import { suggest } from '../model/graphSuggest'

interface Props {
  value: string
  onChange: (value: string) => void
  fields: string[]
  props: string[]
  placeholder: string
  label: string
  describedBy: string
  /** True when the form already shows an error for the last run. */
  hideLiveError?: boolean
}

/** Query input: grows to 10 lines, offers completions, names the detected language and shows Cypher errors while typing. */
export function GraphQueryBox({ value, onChange, fields, props, placeholder, label, describedBy, hideLiveError }: Props) {
  const t = useT()
  const id = useId()
  const area = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  const [forced, setForced] = useState(false)
  const [active, setActive] = useState(0)
  const [closed, setClosed] = useState(false)
  const cypher = isCypher(value)

  useEffect(() => {
    const el = area.current
    if (!el) return
    if (!value) el.style.height = ''
    else if (el.scrollHeight > el.clientHeight) el.style.height = `${el.scrollHeight}px`
  }, [value])

  const live = useMemo(() => {
    if (!cypher) return null
    try {
      parseCypher(value)
      return null
    } catch (err) {
      if (!(err instanceof CypherError)) throw err
      return t(err.key, err.params)
    }
  }, [cypher, value, t])

  const sug = closed ? null : suggest(value, caret, fields, props, forced)
  const open = sug !== null

  const accept = (item: string) => {
    if (!sug) return
    onChange(value.slice(0, sug.from) + item + value.slice(sug.to))
    const next = sug.from + item.length
    setCaret(next)
    setActive(0)
    requestAnimationFrame(() => area.current?.setSelectionRange(next, next))
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault()
      setForced(true)
      setClosed(false)
    } else if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : sug.items.length - 1)) % sug.items.length)
    } else if (open && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      e.preventDefault()
      accept(sug.items[Math.min(active, sug.items.length - 1)])
    } else if (open && e.key === 'Escape') {
      e.stopPropagation()
      setClosed(true)
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      e.currentTarget.form?.requestSubmit()
    }
  }

  return (
    <div className="graph-query-box">
      <span className="graph-query-lang" title={t('graphView.lang')}>
        {t(cypher ? 'graphView.lang.cypher' : 'graphView.lang.text')}
      </span>
      <textarea
        ref={area}
        rows={1}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setCaret(e.target.selectionStart)
          setForced(false)
          setClosed(false)
          setActive(0)
        }}
        onKeyDown={onKey}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={() => setClosed(true)}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={live !== null}
        aria-autocomplete="list"
        aria-controls={open ? id : undefined}
        spellCheck={false}
        dir="auto"
      />
      {open && (
        <ul id={id} role="listbox" className="graph-suggest" aria-label={t('graphView.suggestions')}>
          {sug.items.map((item, i) => (
            <li key={item} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); accept(item) }}>
              {item}
            </li>
          ))}
        </ul>
      )}
      {live && !hideLiveError && (
        <p className="graph-hint graph-error" role="status">
          {live}
        </p>
      )}
    </div>
  )
}
