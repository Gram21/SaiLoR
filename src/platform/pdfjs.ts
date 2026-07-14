import { pdfjs } from 'react-pdf'

/**
 * Single place that points pdf.js at its worker. Both the viewer and the
 * project editor's metadata extraction need it, and setting it twice from two
 * modules would be a silent footgun if they ever disagreed.
 *
 * The worker is loaded from the bundled dependency, so it works offline and
 * inside Electron.
 */
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

export { pdfjs }
