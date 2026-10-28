const QUOTE = '"';
const COMMA = ",";
const CR = "\r";
const LF = "\n";

/** A row is blank when every cell is empty after trimming (an empty line, or only commas). */
export function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

/**
 * Splits CSV text into rows of cells (RFC 4180): double quotes, `""` inside quotes, line breaks
 * inside quotes, and CRLF / LF / CR record ends. Trailing empty lines are dropped. Cells are
 * returned as written (not trimmed); a quote that does not open a cell is kept as a character.
 */
export function parseCsvTable(text: string): string[][] {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;

  const endCell = (): void => {
    row.push(cell);
    cell = "";
    cellStarted = false;
  };
  const endRow = (): void => {
    endCell();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (quoted) {
      if (char === QUOTE) {
        if (source.charAt(index + 1) === QUOTE) {
          cell += QUOTE;
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    switch (char) {
      case QUOTE:
        if (cellStarted) cell += char;
        else quoted = true;
        cellStarted = true;
        break;
      case COMMA:
        endCell();
        break;
      case CR:
        if (source.charAt(index + 1) === LF) index += 1;
        endRow();
        break;
      case LF:
        endRow();
        break;
      default:
        cell += char;
        cellStarted = true;
    }
  }
  if (cellStarted || cell !== "" || row.length > 0) endRow();

  while (rows.length > 0 && rows[rows.length - 1]?.every((value) => value === "")) rows.pop();
  return rows;
}
