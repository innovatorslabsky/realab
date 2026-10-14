/** Hand-built PDFs for tests: valid xref table, Helvetica text, optional outline and password-less metadata. */
export interface PdfSpec {
  /** One entry per page; each line is `[x, y, text]` in PDF points (origin bottom-left, page 612x792). */
  pages: Array<Array<[number, number, string]>>;
  title?: string;
  author?: string;
  outline?: Array<{ title: string; page: number }>;
  encrypt?: boolean;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function makePdf(spec: PdfSpec): Uint8Array {
  const objs: string[] = []; // 1-based object bodies
  const add = (body: string): number => objs.push(body);

  const n = spec.pages.length;
  const catalog = add(''); // 1
  const pagesRoot = add(''); // 2
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 3
  const info = add(`<< ${spec.title ? `/Title (${esc(spec.title)}) ` : ''}${spec.author ? `/Author (${esc(spec.author)}) ` : ''}/CreationDate (D:20260314120000Z) >>`); // 4
  const pageIds: number[] = [];
  for (const lines of spec.pages) {
    const stream = lines.map(([x, y, t]) => `BT /F1 12 Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  let outlinesRef = '';
  if (spec.outline?.length) {
    const root = add('');
    const items = spec.outline.map((o) => add(`<< /Title (${esc(o.title)}) /Parent ${root} 0 R /Dest [${pageIds[o.page]} 0 R /Fit] >>`));
    items.forEach((id, i) => {
      objs[id - 1] = objs[id - 1]!.replace(' >>', `${i > 0 ? ` /Prev ${items[i - 1]} 0 R` : ''}${i < items.length - 1 ? ` /Next ${items[i + 1]} 0 R` : ''} >>`);
    });
    objs[root - 1] = `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items[items.length - 1]} 0 R /Count ${items.length} >>`;
    outlinesRef = ` /Outlines ${root} 0 R`;
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRoot} 0 R${outlinesRef} >>`;
  objs[pagesRoot - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${n} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
