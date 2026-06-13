/**
 * A small, dependency-free RFC-4180 CSV tokenizer.
 *
 * Amazon order exports quote any field containing a comma, quote, or newline —
 * including the PII columns this importer ignores — so a naïve `split(',')` would
 * shred rows. This handles the cases that actually appear: quoted fields, doubled
 * `""` escapes, embedded commas/newlines, and CRLF or bare-LF line endings. It is
 * intentionally tiny and lives inside the Amazon adapter directory rather than
 * pulling in a parser dependency (the workspace is offline, pure-TS core).
 */
export function parseCsv(text: string): string[][] {
  // Strip a leading UTF-8 BOM if present.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let sawAny = false; // distinguishes a real (possibly empty) field from "no content yet"

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    sawAny = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1; // consume the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ',') {
      sawAny = true;
      endField();
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      // Swallow CR; a following LF triggers the row end, a lone CR ends it too.
      if (input[i + 1] === '\n') {
        endRow();
        i += 1;
      } else {
        endRow();
      }
    } else {
      sawAny = true;
      field += ch;
    }
  }

  // Flush the trailing field/row unless the input ended exactly on a line break.
  if (sawAny || field.length > 0 || row.length > 0) {
    endRow();
  }

  return rows;
}
