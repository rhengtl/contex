/**
 * Turning one upload into the units the model will be asked to convert.
 * A port of contex/pipeline/inputs.py (_check_input, page_count, _split_pdf)
 * and run.py's _ai_units.
 *
 * WHY SINGLE-PAGE PDFs AND NOT IMAGES. inputs.py is explicit about it: the
 * model reads a PDF page natively, text layer included, and rasterising it
 * first throws that away for nothing. pdf.js is already here for the preview
 * and could render pages to canvas in a few lines -- doing so would be the
 * easy port and the wrong one.
 *
 * WHY SPLIT AT ALL. It is what makes a partial conversion survivable: when the
 * model gives out on page nine, the eight pages already converted keep their
 * output and only the rest degrades. run.py calls that "granularity, not
 * parallelism", and it is the reason merge_documents has to exist.
 *
 * pdf-lib is loaded on demand, so a photograph -- the ordinary case -- never
 * pays for it. It is vendored under /vendor/ rather than fetched from a CDN
 * because the CSP is script-src 'self' and stays that way.
 */

//: Everything the pipeline can read. The picker and the drop area derive from
//: this, so the control cannot offer something the converter will refuse.
export const IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif',
                            '.gif', '.webp'];

//: In the order a person expects to see them offered.
export const ACCEPTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp', '.tiff',
                                    '.tif', '.webp', '.gif', '.pdf', '.docx'];

export const ACCEPTED = new Set(ACCEPTED_EXTENSIONS);

// config.integer('AI_QA_MAX_PDF_PAGES', 10). A hard cap rather than a
// preference: ten pages is ten model calls, and the free allowance is what it
// is.
export const MAX_PDF_PAGES = 10;

export function extensionOf(filename) {
  const dot = (filename || '').lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

/**
 * Reject an unusable file type before any path starts.
 * Throws with inputs.py's own wording.
 */
export function checkInput(filename) {
  const extension = extensionOf(filename);
  if (extension && !ACCEPTED.has(extension)) {
    throw new Error(`Unsupported file type: '${extension}'`);
  }
}

let pdfLibPromise = null;
function getPdfLib() {
  if (!pdfLibPromise) pdfLibPromise = import('/vendor/pdf-lib/pdf-lib.esm.min.js');
  return pdfLibPromise;
}

/**
 * Cut a PDF into one single-page PDF per page.
 *
 * Returns null when the file cannot be split -- including a one-page PDF,
 * which has nothing to split -- and the caller then sends the whole document
 * in one call, exactly as _split_pdf does.
 */
export async function splitPdf(bytes, limit = MAX_PDF_PAGES) {
  let PDFDocument;
  try {
    ({ PDFDocument } = await getPdfLib());
  } catch (err) {
    // The equivalent of inputs.py's ImportError branch: no splitter, so the
    // whole document goes in one call rather than the conversion failing.
    console.warn('Notice: the PDF splitter could not be loaded.', err);
    return null;
  }
  try {
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const total = Math.min(source.getPageCount(), limit);
    if (total <= 1) return null;
    const out = [];
    for (let index = 0; index < total; index++) {
      const single = await PDFDocument.create();
      const [copied] = await single.copyPages(source, [index]);
      single.addPage(copied);
      out.push(await single.save());
    }
    return out;
  } catch (err) {
    console.warn(`Notice: could not split the PDF into pages (${err}).`);
    return null;
  }
}

/** How many pages this upload has, capped at the configured limit. */
export async function pageCount(bytes, filename) {
  if (extensionOf(filename) !== '.pdf') return 1;
  try {
    const { PDFDocument } = await getPdfLib();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return Math.max(1, Math.min(doc.getPageCount(), MAX_PDF_PAGES));
  } catch {
    return 1;
  }
}

/**
 * Split an upload into the units the model will be asked to convert.
 *
 * One entry for an image; one per page for a PDF that can be split. Mirrors
 * run.py _ai_units, including its shape: {number, bytes, name, mime}.
 */
export async function aiUnits(bytes, filename, mime) {
  if (extensionOf(filename) === '.pdf') {
    const parts = await splitPdf(bytes, MAX_PDF_PAGES);
    if (parts && parts.length) {
      return parts.map((data, i) => ({
        number: i + 1,
        bytes: data,
        name: `page-${i + 1}.pdf`,
        mime: 'application/pdf',
      }));
    }
  }
  return [{ number: 1, bytes, name: filename, mime: mime || 'image/png' }];
}
