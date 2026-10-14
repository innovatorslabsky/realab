import { describe, expect, it } from 'vitest';
import { Shape, renderMarkdown, summarizeHar, templatePath } from '../src/index.ts';

// Every string below is something that must NEVER appear in a report.
const SECRETS = [
  'SECRET-BEARER-TOKEN-abc123', 'sessionid=TOPSECRETCOOKIE', 'csrf-value-98765', 'Confidential Article About Cats',
  'my private highlight note', 'me@secret.example', 'https://news.example/very-private-story', 'very-private-story',
  'xk9QmZ3vLp2RtY8wNc4HdJ6s', 'qtoken=SEKRIT-QUERY-VALUE', 'tracking.thirdparty.example', 'cdn.secretnews.example',
  '5c9e2b1d-0000-4000-8000-0123456789ab',
];

const json = (v: unknown) => JSON.stringify(v);
const hdr = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));

const har = {
  log: {
    entries: [
      { request: { method: 'GET', url: 'https://app.example.test/library/', headers: [] }, response: { status: 200, content: { mimeType: 'text/html; charset=utf-8', text: '<html>' }, headers: [] } },
      {
        time: 120, _resourceType: 'fetch',
        request: {
          method: 'POST', url: 'https://app.example.test/api/v3/save/?qtoken=SEKRIT-QUERY-VALUE&format=full',
          headers: hdr({ Authorization: 'Bearer SECRET-BEARER-TOKEN-abc123', Cookie: 'sessionid=TOPSECRETCOOKIE', 'X-CSRFToken': 'csrf-value-98765', 'X-Client-Version': '4.2.1' }),
          postData: { mimeType: 'application/json', text: json({ url: 'https://news.example/very-private-story', title: 'Confidential Article About Cats', tags: ['a', 'b'], notes: 'my private highlight note', location: 'later' }) },
        },
        response: { status: 201, headers: hdr({ 'Set-Cookie': 'sessionid=TOPSECRETCOOKIE', 'X-RateLimit-Remaining': '19' }), content: { mimeType: 'application/json', text: json({ id: '5c9e2b1d-0000-4000-8000-0123456789ab', url: 'https://app.example.test/read/xk9QmZ3vLp2RtY8wNc4HdJ6s', created_at: '2026-10-14T01:02:03Z', owner: 'me@secret.example', word_count: 812, reading_progress: 0.5 }) } },
      },
      {
        time: 80, _resourceType: 'fetch',
        request: { method: 'POST', url: 'https://app.example.test/api/v3/save/?format=full', headers: hdr({ Authorization: 'Bearer SECRET-BEARER-TOKEN-abc123' }), postData: { mimeType: 'application/json', text: json({ url: 'https://news.example/another', location: 'archive', tags: [] }) } },
        response: { status: 201, headers: [], content: { mimeType: 'application/json', text: json({ id: '6d9e2b1d-0000-4000-8000-0123456789ab', url: 'x', created_at: '2026-10-14T01:02:03Z', owner: 'a@b.co', word_count: 5, reading_progress: 0, extra: null }) } },
      },
      {
        time: 40, _resourceType: 'fetch',
        request: { method: 'GET', url: 'https://app.example.test/api/v3/documents/5c9e2b1d-0000-4000-8000-0123456789ab/highlights/42?cursor=abc', headers: [] },
        response: { status: 200, headers: [], content: { mimeType: 'application/json', text: json({ results: [{ id: 1, text: 'Confidential Article About Cats', color: 'yellow', offsets: [3, 9] }], next: null }) } },
      },
      { request: { method: 'GET', url: 'https://app.example.test/read/xk9QmZ3vLp2RtY8wNc4HdJ6s', headers: [] }, response: { status: 200, headers: [], content: { mimeType: 'text/html', text: 'Confidential Article About Cats' } } },
      { _resourceType: 'script', request: { method: 'GET', url: 'https://app.example.test/static/main.3f9a1c7b2e.js' }, response: { status: 200, content: { mimeType: 'application/javascript' } } },
      { _resourceType: 'image', request: { method: 'GET', url: 'https://cdn.secretnews.example/img/very-private-story.png' }, response: { status: 200, content: { mimeType: 'image/png' } } },
      { request: { method: 'POST', url: 'https://tracking.thirdparty.example/collect', headers: [] }, response: { status: 204, content: {} } },
      {
        _resourceType: 'websocket', request: { method: 'GET', url: 'wss://app.example.test/ws/sync', headers: [] }, response: { status: 101, content: {} },
        _webSocketMessages: [{ type: 'send', data: json({ op: 'sub', channel: 'library' }) }, { type: 'receive', data: json({ op: 'event', doc: 'Confidential Article About Cats', n: 3 }) }],
      },
    ],
  },
};

describe('summarizeHar', () => {
  const summary = summarizeHar(har);
  const md = renderMarkdown(summary);
  const all = `${JSON.stringify(summary)}\n${md}`;

  it('never emits secrets, content, query values, third-party hosts or slug-like path parts', () => {
    for (const secret of SECRETS) expect(all, `leaked: ${secret}`).not.toContain(secret);
  });

  it('recovers the API surface', () => {
    const save = summary.endpoints.find((e) => e.key === 'POST app.example.test/api/v3/save/')!;
    expect(save.count).toBe(2);
    expect(save.statuses).toEqual({ '201': 2 });
    expect(save.queryKeys).toEqual({ format: 2, qtoken: 1 });
    expect(save.auth).toEqual(['Authorization: bearer', 'CSRF header: x-csrftoken', 'cookie session']);
    expect(save.requestHeaderNames).toContain('x-client-version');
    expect(save.requestHeaderNames).not.toContain('authorization');
    expect(save.responseHeaderNames).toContain('x-ratelimit-remaining');
    expect(save.responseHeaderNames).not.toContain('set-cookie');
    expect(save.requestShape).toBe('{ url: string(url); title?: string; tags: string[]; notes?: string; location: string }');
    expect(save.responseShape).toContain('id: string(uuid)');
    expect(save.responseShape).toContain('created_at: string(iso-datetime)');
    expect(save.responseShape).toContain('owner: string(email)');
    expect(save.responseShape).toContain('word_count: integer');
    expect(save.responseShape).toContain('reading_progress: number | integer');
    expect(save.responseShape).toContain('extra?: null');
  });

  it('templates ids in paths', () => {
    expect(summary.endpoints.map((e) => e.path)).toContain('/api/v3/documents/:uuid/highlights/:int');
  });

  it('keeps third parties to a count, lists first-party bundles by templated name, and finds websockets', () => {
    expect(summary.thirdParty).toEqual({ requests: 2, hosts: 2 });
    expect(summary.assets.scripts).toEqual(['app.example.test/main.:hash.js']);
    expect(summary.websockets).toEqual([{ host: 'app.example.test', path: '/ws/sync', sent: '{ op: string; channel: string }', received: '{ op: string; doc: string; n: integer }' }]);
  });

  it('lists vocabulary only when explicitly asked, and never for content-like keys', () => {
    expect(summary.endpoints.find((e) => e.key.includes('/save/'))!.requestShape).not.toContain('enum');
    const withEnums = summarizeHar(har, { collectEnums: true });
    const save = withEnums.endpoints.find((e) => e.key === 'POST app.example.test/api/v3/save/')!;
    // only 2 samples of `location` → below the 3-sample bar, so still no enum
    expect(save.requestShape).not.toContain('enum');
    const many = new Shape({ collectEnums: true });
    for (const v of ['new', 'later', 'archive', 'later', 'new']) many.add({ location: v, title: v });
    const r = many.render();
    expect(r).toContain('location: string enum("archive"|"later"|"new")');
    expect(r).toMatch(/title: string(?! enum)/);
  });

  it('rejects things that are not HARs', () => {
    expect(() => summarizeHar({})).toThrow(/Not a HAR/);
    expect(() => summarizeHar({ log: { entries: [] } })).toThrow(/Not a HAR/);
  });
});

describe('templatePath', () => {
  it.each([
    ['/api/v3/list/', '/api/v3/list/'],
    ['/api/doc/5c9e2b1d-0000-4000-8000-0123456789ab/x', '/api/doc/:uuid/x'],
    ['/h/42', '/h/:int'],
    ['/read/xk9QmZ3vLp2RtY8wNc4HdJ6s', '/read/:token'],
    ['/a/0123456789abcdef0123', '/a/:hex'],
    ['/articles/how-readers-work-and-why-it-matters-for-everyone-here', '/articles/:opaque'],
    ['/bài-viết', '/:opaque'],
  ])('%s → %s', (input, expected) => expect(templatePath(input)).toBe(expected));
});
