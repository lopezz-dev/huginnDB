/**
 * Clipboard text as a block of cells — what a spreadsheet, another grid or a
 * text editor puts there when several cells are copied (ADR #114).
 *
 * The format is the one Excel, LibreOffice and Google Sheets write: cells
 * separated by tabs, rows by line breaks, and a cell holding a tab, a line
 * break or a quote wrapped in double quotes with its own quotes doubled. They
 * also end the text with one line break, which is not an empty last row.
 */

/** Whether the text is a block at all — more than one cell — rather than one
 *  value. A single value keeps the grid's one-cell paste exactly as it was. */
export function isBlockText(text: string): boolean {
  const body = text.replace(/\r?\n$/, "");
  return body.includes("\t") || /\r?\n/.test(body);
}

/** The block's rows of cells. Rows may differ in length; a paste writes what
 *  each row has. */
export function parsePasteBlock(text: string): string[][] {
  const src = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  // A cell starts at `i`; read it, then the separator after it.
  for (;;) {
    let cell = "";
    if (src[i] === '"') {
      // Quoted: up to the closing quote, `""` standing for one quote.
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            cell += '"';
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        cell += src[j];
        j += 1;
      }
      if (closed && (j >= src.length || src[j] === "\t" || src[j] === "\n")) {
        i = j;
      } else {
        // Not a quoted cell after all (a quote that opens text with more
        // after its close, or never closes): read it literally, as the
        // spreadsheets do.
        const end = nextSeparator(src, i);
        cell = src.slice(i, end);
        i = end;
      }
    } else {
      const end = nextSeparator(src, i);
      cell = src.slice(i, end);
      i = end;
    }
    row.push(cell);
    if (i >= src.length) break;
    if (src[i] === "\n") {
      rows.push(row);
      row = [];
    }
    i += 1;
  }
  rows.push(row);
  return rows;
}

function nextSeparator(src: string, from: number): number {
  for (let k = from; k < src.length; k++) {
    if (src[k] === "\t" || src[k] === "\n") return k;
  }
  return src.length;
}
