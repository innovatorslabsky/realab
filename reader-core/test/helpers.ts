import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export async function startServer(routes: Record<string, Handler>) {
  const server = createServer((req, res) => {
    const h = routes[(req.url ?? '/').split('?')[0]!];
    if (h) return h(req, res);
    res.statusCode = 404;
    res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    /** Options that let a test talk to its own loopback server, and nothing else. */
    fetchOptions: { allowedPorts: [port, 80], isAddressAllowed: (a: string) => a === '127.0.0.1' },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const html = (body: string, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
};

const filler = 'Reading software succeeds when it gets out of the way of the text. '.repeat(6);

export const ARTICLE = `<!doctype html><html lang="en"><head>
<title>How Readers Work | Example Blog</title>
<meta property="og:site_name" content="Example Blog">
<meta property="og:image" content="/img/cover.png">
<meta property="article:published_time" content="2026-03-01T10:00:00Z">
<meta name="author" content="Ada Lovelace">
<link rel="canonical" href="/posts/how-readers-work?utm_source=x">
<script>window.stolen = document.cookie</script>
</head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<article>
<h1>How Readers Work</h1>
<p class="byline">By Ada Lovelace</p>
<p>${filler}</p>
<p>The quick brown fox jumps over the lazy dog, and the reader keeps its place. ${filler}</p>
<img src="/img/diagram.png" alt="diagram" onerror="alert(1)" srcset="a.png 1x">
<p>See <a href="/more">more</a> and <a href="javascript:alert(2)">bad</a>. <script>alert(3)</script>${filler}</p>
<form action="/x"><input name="q"><button>Go</button></form>
</article>
<footer>Copyright</footer></body></html>`;
