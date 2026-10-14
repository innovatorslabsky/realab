import { strToU8, zipSync } from 'fflate';

export const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

type Files = Record<string, Uint8Array | string>;

const CONTAINER = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>One</title><style>p{color:red}</style></head>
<body><h1 id="top">Chapter One</h1>
<p>Alpha beta gamma. <a id="x"/>Delta epsilon zeta eta theta. <img src="images/img1.png" alt="figure"/> <a href="ch2.xhtml#end">Next</a> <a href="#top">Up</a> <a href="https://example.com/ext">External</a> <a href="../../../etc/passwd">Evil</a><script>alert(1)</script></p>
<h2 id="s2">Section Two</h2><p>More text here to make some words for counting.</p></body></html>`;

// Deliberately not well-formed XML (&nbsp; with no DTD), as many real books are.
const CH2 = `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter Two</h1><p id="end">Final&nbsp;words here.</p><img src="images/fake.png" alt="not an image"/><img src="images/missing.png" alt="gone"/></body></html>`;

const NAV = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="landmarks"><ol><li><a href="ch1.xhtml">Ignore me</a></li></ol></nav>
<nav epub:type="toc"><ol><li><a href="ch1.xhtml">Chapter One</a><ol><li><a href="ch1.xhtml#s2">Section Two</a></li></ol></li><li><a href="ch2.xhtml">Chapter Two</a></li></ol></nav></body></html>`;

const OPF3 = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:1234</dc:identifier><dc:title>The Test Book</dc:title><dc:creator>Ada Lovelace</dc:creator><dc:creator>Alan Turing</dc:creator>
<dc:language>en</dc:language><dc:publisher>Open Press</dc:publisher><dc:date>2024-05-06</dc:date><dc:description>A &lt;b&gt;small&lt;/b&gt; book.</dc:description></metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
<item id="i1" href="images/img1.png" media-type="image/png"/><item id="fake" href="images/fake.png" media-type="image/png"/>
</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;

const NCX = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
<navPoint id="n1"><navLabel><text>First &amp; Foremost</text></navLabel><content src="ch1.xhtml"/><navPoint id="n2"><navLabel><text>Nested</text></navLabel><content src="ch1.xhtml#s2"/></navPoint></navPoint>
<navPoint id="n3"><navLabel><text>Second</text></navLabel><content src="ch2.xhtml"/></navPoint></navMap></ncx>`;

const OPF2 = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:identifier id="uid">isbn:9780000000002</dc:identifier><dc:title>Old Style Book</dc:title><dc:creator>Grace Hopper</dc:creator><meta name="cover" content="cov"/></metadata>
<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/><item id="cov" href="images/cover.png" media-type="image/jpeg"/></manifest>
<spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;

function zip(files: Files): Uint8Array {
  const out: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
  for (const [name, v] of Object.entries(files)) out[name] = typeof v === 'string' ? strToU8(v) : v;
  return zipSync(out);
}

export function epub3(mutate?: (files: Files) => void): Uint8Array {
  const files: Files = {
    'META-INF/container.xml': CONTAINER, 'OEBPS/content.opf': OPF3, 'OEBPS/nav.xhtml': NAV,
    'OEBPS/ch1.xhtml': CH1, 'OEBPS/ch2.xhtml': CH2,
    'OEBPS/images/cover.png': PNG, 'OEBPS/images/img1.png': PNG, 'OEBPS/images/fake.png': 'this is definitely not a png',
  };
  mutate?.(files);
  return zip(files);
}

export function epub2(mutate?: (files: Files) => void): Uint8Array {
  const files: Files = {
    'META-INF/container.xml': CONTAINER, 'OEBPS/content.opf': OPF2, 'OEBPS/toc.ncx': NCX,
    'OEBPS/ch1.xhtml': CH1, 'OEBPS/ch2.xhtml': CH2, 'OEBPS/images/cover.png': PNG, 'OEBPS/images/img1.png': PNG,
  };
  mutate?.(files);
  return zip(files);
}

export const rawZip = zip;
