import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { Document, Page } from 'react-pdf'
import '../src/platform/pdfjs'

const base = navigator.userAgent.includes('Windows') ? 'http://slr-file.localhost' : 'slr-file://localhost'

interface Opened { path: string; text: string }

function App() {
  const [papers, setPapers] = useState<string[]>([])
  const [pdf, setPdf] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const say = (m: string) => { setLog((l) => [...l, m]); void invoke('probe_report', { line: m }) }

  async function open() {
    try {
      const r = await invoke<Opened | null>('project_open')
      if (!r) return say('cancelled')
      const project = JSON.parse(r.text)
      const list = (project.papers ?? []).map((p: { pdf?: string }) => p.pdf).filter(Boolean)
      setPapers(list)
      say(`opened ${r.path}: ${list.length} pdfs`)
    } catch (e) { say(`open error: ${e}`) }
  }

  useEffect(() => {
    void (async () => {
      const r = await invoke<Opened | null>('probe_auto')
      if (!r) return
      say(`UA ${navigator.userAgent}`)
      const list: string[] = (JSON.parse(r.text).papers ?? []).map((p: { pdf?: string }) => p.pdf).filter(Boolean)
      setPapers(list)
      say(`auto-opened: ${list.length} pdfs`)
      const target = (id: string) => `${base}/pdf?path=${encodeURIComponent(id)}`
      for (const rel of ['../package.json', 'nope.pdf']) {
        const res = await fetch(target(rel)).catch((e) => ({ status: `ERR ${e}` }))
        say(`probe ${rel} -> ${(res as Response).status}`)
      }
      if (list[0]) setPdf(target(list[0]))
    })()
  }, [])

  const url = (rel: string) => `${base}/pdf?path=${encodeURIComponent(rel)}`

  return (
    <div style={{ font: '14px sans-serif', padding: 12 }}>
      <button id="open" onClick={open}>Open project</button>
      <span id="ua"> {navigator.userAgent}</span>
      <ul>{papers.map((p) => <li key={p}><a href="#" onClick={() => { setPdf(url(p)); say(`load ${url(p)}`) }}>{p}</a></li>)}</ul>
      <button onClick={() => { setPdf(url('../../../../etc/passwd')); say('traversal attempt') }}>Traversal attempt</button>
      {pdf && (
        <Document file={pdf} onLoadSuccess={(d) => say(`PDF OK pages=${d.numPages}`)} onLoadError={(e) => say(`PDF ERROR ${e.message}`)}>
          <Page pageNumber={1} width={500} onRenderSuccess={() => say('RENDER OK')} onRenderError={(e) => say(`RENDER ERROR ${e.message}`)} />
        </Document>
      )}
      <pre id="log">{log.join('\n')}</pre>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
