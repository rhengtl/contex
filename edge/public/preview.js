/**
 * The PDF preview -- the browser replacement for the preview half of
 * contex/web/output.py.
 *
 * The original compiled a PDF on the server, rasterised it with Poppler and
 * served page images, for a reason its docstring states plainly: a browser
 * hands an application/pdf response to its own viewer, or to a download
 * manager extension, before the page can display it -- so the one thing a
 * preview cannot be made of is a PDF *response*.
 *
 * That constraint does not apply to bytes we already hold. pdf.js renders the
 * compiled PDF to a canvas directly, so the whole texpng_ page-image store in
 * data/results.py disappears rather than being ported. Same preview, one fewer
 * moving part, and no server round trip.
 *
 * pdf.js is self-hosted under /vendor/ because the CSP is `script-src 'self'`
 * and stays that way.
 */

const PDFJS_URL = '/vendor/pdfjs/pdf.min.mjs';
const WORKER_URL = '/vendor/pdfjs/pdf.worker.min.mjs';

let pdfjsPromise = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = WORKER_URL;
      return lib;
    });
  }
  return pdfjsPromise;
}

/**
 * Render every page of `bytes` into `container` as canvases.
 *
 * Pages are rendered one at a time and the previous page's ImageBitmap is
 * released before the next starts: a ten-page document at preview scale is
 * several hundred megabytes of canvas if they are all held at once, which is
 * what makes low-memory phones drop the tab.
 */
export async function renderPdf(bytes, container, { scale = 1.4, maxPages = 20 } = {}) {
  const pdfjs = await getPdfjs();
  // pdf.js takes ownership of the buffer it is given, so hand it a copy --
  // the caller still needs these bytes for the download button.
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  container.replaceChildren();

  const count = Math.min(doc.numPages, maxPages);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  for (let n = 1; n <= count; n++) {
    const pg = await doc.getPage(n);
    const viewport = pg.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.className = 'preview-page';
    canvas.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`);
    container.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    await pg.render({ canvasContext: ctx, viewport }).promise;
    pg.cleanup();
  }

  if (doc.numPages > count) {
    const note = document.createElement('p');
    note.className = 'preview-note';
    note.textContent =
      `Showing the first ${count} of ${doc.numPages} pages. ` +
      'The downloaded PDF contains all of them.';
    container.appendChild(note);
  }
  return { pages: doc.numPages, rendered: count };
}

/** Save the compiled PDF, named after the uploaded file. */
export function downloadPdf(bytes, fileName) {
  const base = (fileName || 'converted').replace(/\.[^.]*$/, '') || 'document';
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
