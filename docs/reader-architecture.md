# Reader Architecture — kiến trúc "reader kiểu Readwise" cho MindFerry

Trạng thái: **bản thiết kế + các cơ chế lõi đã có code và test** (`reader-core/`: bài web, PDF, EPUB, RSS, neo highlight, công cụ bắt cấu trúc để reverse engineer). Phần còn lại là thiết kế, chưa code.

## 0. Nói thật về nguồn gốc

- **Chưa reverse engineer Readwise.** Môi trường này không truy cập được `readwise.io` / `docs.readwise.io`
  (DNS bị chặn). Qua tìm kiếm web em chỉ xác nhận được: Reader API có endpoint *Document CREATE* (POST, header
  `Authorization: Token …`) và rate limit mặc định 20 req/phút/token, riêng create/update 50 req/phút
  ([Reader API docs](https://docs.readwise.io/reader/docs/api)). Danh sách `location`/`category` lấy từ wrapper bên thứ ba,
  **chưa xác minh với tài liệu chính thức**.
- Vì vậy mọi câu kiểu "Readwise làm X" trong tài liệu này là **kiến thức chung về sản phẩm, chưa kiểm chứng**.
  Kiến trúc dưới đây **không sao chép** hệ thống của họ: nó là thiết kế độc lập, dựng trên chuẩn mở
  (W3C Web Annotation) và thư viện mã nguồn mở (Mozilla Readability, DOMPurify, jsdom, undici).
- Không có "mã nguồn Readwise" nào trong repo này, và sẽ không có. Code ở đây là code gốc.

## 1. Tính năng → cơ chế → trạng thái

| Tính năng reader | Cơ chế mình chọn | Trạng thái |
|---|---|---|
| Lưu bài từ URL | Fetch an toàn → Readability → sanitize → draft | ✅ code + test (`ingest/`, `net/`) |
| Chống tấn công qua URL (SSRF) | Chặn IP nội bộ ngay trong DNS lookup lúc connect, kiểm lại từng redirect, giới hạn cổng/dung lượng | ✅ code + test + mutation test |
| Chống trùng bài | `normalizeUrl` (bỏ utm/fbclid…) + canonical cùng host → `urlKey` sha256 | ✅ code + test |
| Highlight bền vững | Quote + prefix/suffix + offset (W3C TextQuote/TextPosition), fuzzy fallback | ✅ code + test |
| Chọn chữ ↔ DOM | `offsetsFromRange` / `rangeFromOffsets` trên `textContent` | ✅ code + test (jsdom) |
| Nhớ chỗ đang đọc | Lưu **text offset**, không lưu pixel cuộn | 🟡 schema (`types.ts`), chưa có UI/API |
| Lưu từ extension / email | `saveHtml()` không cần mạng | ✅ hàm có; extension/email chưa |
| Trang render bằng JS (SPA) | Headless browser (Playwright) ở worker cách ly | ❌ chưa — xem §4 |
| PDF | `pdfjs-dist` (không chạy JS nhúng), văn bản theo trang, mục lục, cờ `needsOcr` | ✅ code + test (`pdf/`) — §3b |
| EPUB | zip an toàn → OPF/spine/toc → chương đã sanitize + ảnh đã kiểm tra | ✅ code + test (`epub/`) — §3b |
| Nhận file tải lên | `ingestUpload`: định tuyến theo **nội dung**, không tin tên file/MIME | ✅ code + test |
| RSS / Atom / JSON Feed | Parse + GET có điều kiện (ETag/If-Modified-Since) + tự tìm feed từ trang | ✅ code + test (`feed/`) — §3b |
| Newsletter qua email, lịch poll feed | Hộp thư nhận email; scheduler | ❌ chưa |
| Tìm kiếm | MVP `$text`; sau này vector (pgvector) | ❌ chưa — xem §6 |
| Offline + đồng bộ đa thiết bị | Local-first (IndexedDB) + sync theo `updatedAt`/op log | ❌ chưa — rủi ro cao nhất, xem §7 |
| AI (tóm tắt, hỏi đáp tài liệu) | Dùng lại chat/agents/MCP của MindFerry | ❌ chưa — nối ở §5 |

## 2. Tổng thể

```
 Browser ext / Web app / Mobile / Email-in / RSS
        │  POST /library/documents {url}  |  {url, html}
        ▼
 API (MindFerry, Express legacy → packages/api)
   auth · quota · rate-limit · zod validate
        │
        ├─ saveUrl()  ─► safeFetchHtml ─► extractArticle ─► DocumentDraft   (reader-core)
        │                  (SSRF guard)    (Readability + DOMPurify)
        ▼
 Mongo: SavedDocument · Highlight · ReadingProgress     (tenant-isolated)
        │
        ├─► search (MVP: $text) ──► sau này: chat_search_db (pgvector)
        └─► MCP tools: search_library / get_document / list_highlights
                         └► "Continue in chat" đưa tài liệu/highlight vào hội thoại
```

## 3. Pipeline thu thập bài (đã code)

`saveUrl(url)` → `safeFetchHtml` → `extractArticle` → `DocumentDraft`.

Các quyết định đáng nhớ (mỗi cái có test):

1. **Kiểm IP tại thời điểm connect**, không phải lúc parse URL. Hostname trông hợp lệ nhưng resolve ra `10.x`/`169.254.x`
   bị chặn trong chính hàm `lookup` của socket → chặn được DNS rebinding. IP literal (kể cả dạng thập phân `2130706433`,
   hex `0x7f.1`, octal, `::ffff:127.0.0.1`) bị chặn ở bước parse vì literal không đi qua DNS.
2. **Mỗi redirect được kiểm lại** (redirect sang `169.254.169.254`, `file://` đều bị chặn); tối đa 5 hop.
3. **Giới hạn**: cổng 80/443, 5 MiB (đếm khi stream, không tin `Content-Length`), 15 s, chỉ `text/html`/`xhtml`,
   không gửi cookie, từ chối URL có `user:pass@`.
4. **Sanitize bằng allow-list** (DOMPurify): bỏ `script/form/input/iframe/style`, `on*`, `javascript:`, `srcset`;
   link thêm `rel="noopener noreferrer nofollow"`, ảnh thêm `referrerpolicy="no-referrer"`.
5. **Canonical chỉ được tin khi cùng host** với trang đã fetch — nếu không, một trang xấu có thể tự nhận là bài của
   người khác và đụng khoá dedupe. (Lỗi này em tự bắt được khi review code vừa viết; có test chặn lại.)
6. `contentHash` = sha256 của text đã trích → biết khi nào bài đổi và cần re-anchor highlight.

**Giới hạn đã biết — không giấu:**
- Chỉ xử lý HTML tĩnh. Bài render bằng JS sẽ ra `NotReadableError`. Thêm headless browser **mở rộng bề mặt tấn công**
  (chạy JS của trang lạ) — phải chạy trong sandbox/container không có quyền mạng nội bộ.
- Phát hiện charset chỉ qua header và `<meta charset>` trong 2 KiB đầu.
- Egress qua HTTP proxy của hạ tầng: `undici.Agent` ở đây kết nối thẳng, chưa tích hợp proxy. Nếu deploy sau proxy bắt buộc,
  phải kiểm lại lớp chặn IP (lúc đó proxy mới là nơi resolve DNS).
- Chưa tôn trọng `robots.txt`, chưa có paywall handling, chưa có chính sách lưu bản sao nội dung có bản quyền (§9).

## 3b. PDF, EPUB, RSS (đã code)

Cả ba đi qua cùng nguyên tắc: **không tin đầu vào, chặn theo giới hạn khai báo trước khi xử lý, sanitize mọi HTML, mỗi chốt chặn có test
và đã được thử phá (mutation)**.

**Mỗi định dạng có một "không gian toạ độ" riêng cho highlight** — nên highlight mang thêm `unit`:

| Định dạng | Anchor nằm trong | `unit` | Ghi chú |
|---|---|---|---|
| Bài web | `textContent` của `contentHtml` | — | như §4 |
| EPUB | `textContent` của `chapters[i].contentHtml` | `{kind:'chapter', index}` | mỗi chương một văn bản, `contentHash` theo chương |
| PDF | `pages[i].anchorText` | `{kind:'page', index}` | xem hợp đồng bên dưới |

**EPUB** (`parseEpub`)
- Giải nén bằng `fflate`. Em đã thử thực tế: khi header khai man kích thước giải nén, fflate **cắt đúng ở kích thước khai**, không phình bộ nhớ;
  vì vậy chặn theo `originalSize` (kích thước giải nén khai báo — còn `size` là kích thước *nén*, dễ nhầm) **trước khi** giải nén là đủ.
- Giới hạn: kích thước tải lên, số entry, tổng dung lượng giải nén, dung lượng mỗi chương và mỗi ảnh.
- Đường dẫn: mọi `href` đi qua `resolveZipPath` (từ chối `..` thoát gốc, đường dẫn tuyệt đối, URL scheme); entry tên `../` bị bỏ qua.
- **DRM: từ chối** (`EpubDrmError`), không cố giải mã. Làm xáo trộn font (font obfuscation) thì không phải DRM nên vẫn đọc được.
- XHTML được parse bằng **XML trước** (HTML parser biến `<a id="x"/>` thành thẻ không đóng, nuốt phần còn lại của trang), sách cẩu thả thì quay về HTML.
- HTML ra khỏi parser **không còn `src`/`href` nội bộ**: ảnh mang `data-epub-resource="<đường dẫn trong zip>"`, link nội bộ mang
  `data-epub-link="<chương>#<fragment>"`. Client/API phục vụ ảnh từ `resources` và tự xử lý điều hướng.
- Ảnh chỉ nhận khi **byte thật** là PNG/JPEG/GIF/WebP (kiểu lấy từ byte, không tin manifest); SVG bị loại vì có thể chứa script.
  Chương không bao giờ trỏ tới ảnh đã bị loại.
- Chưa làm: CSS/font của sách (cố ý bỏ), SVG, audio/video, fixed-layout EPUB, `epub:type` footnote popup, EPUB có nhiều rootfile.

**PDF** (`parsePdf`)
- `pdfjs-dist` với `isEvalSupported:false`, không dùng font hệ thống, không auto-fetch, **không bật scripting** — JS nhúng trong PDF không chạy.
- Giới hạn: dung lượng, số trang (`truncated` báo rõ), ký tự mỗi trang, tổng thời gian; có `AbortSignal` để huỷ giữa chừng.
- Cần mật khẩu → `PdfEncryptedError` (không thử đoán). Ít chữ → `needsOcr: true` (có thể chỉ là ảnh quét; quyết định OCR thuộc về app).
- Mỗi trang có **hai văn bản**: `anchorText` (nối nguyên `str` của các text item — đây là không gian toạ độ highlight) và `text`
  (gộp dòng thành đoạn, nối lại từ bị gạch ngang cuối dòng, chỉ khi dòng sau bắt đầu bằng chữ thường).
- **Hợp đồng client chưa được kiểm chứng:** client dựng text layer của pdf.js phải nối `textContent` các span theo thứ tự để ra đúng `anchorText`.
  Điều này chỉ được xác nhận ở phía server; cần một test tích hợp trên trình duyệt thật trước khi tin.
- Phát hiện khi thử: pdf.js **bỏ chữ nằm ngoài khung trang** — hữu ích (chặn "chữ ẩn" ngoài trang) nhưng cũng có nghĩa là PDF lỗi toạ độ có thể mất chữ.
- Chưa làm: thứ tự đọc cho PDF nhiều cột (hiện theo thứ tự content stream), bảng, công thức, OCR, ảnh trang để hiển thị, hạn chế quyền sao chép của PDF
  (cờ owner-permission) — **chưa quyết định có tôn trọng hay không**, cần chốt chính sách.

**RSS / Atom / JSON Feed** (`parseFeed`, `fetchFeed`, `subscribeToUrl`)
- Hỗ trợ RSS 2.0, RSS 1.0 (RDF), Atom 1.0, JSON Feed 1.x. XML dùng parser của jsdom; mọi `<!ENTITY` bị từ chối thẳng (chặn entity bomb và XXE).
- Mỗi item có `guid` ổn định (guid → url → hash) và `feedItemKey(feedUrl, guid)` để chống trùng giữa các lần poll.
- HTML trong item được tuyệt đối hoá URL rồi sanitize; Atom `type="text"` được escape, **không** diễn giải thành markup.
- Poll rẻ: gửi `If-None-Match`/`If-Modified-Since`, nhận 304 thì không parse.
- Người dùng dán địa chỉ trang web: `subscribeToUrl` tự đọc `<link rel="alternate">` rồi lấy feed (một bước, vẫn qua bộ fetch an toàn).
- Nhiều feed chỉ chứa đoạn tóm tắt; muốn bài đầy đủ thì lưu `item.url` bằng `saveUrl`. **Việc đó là hành vi của ứng dụng, chưa nối sẵn.**
- Chưa làm: lịch poll và backoff, giới hạn số feed/người dùng, OPML import/export, đọc `<media:content>`, podcast.

## 4. Highlight bền vững (đã code)

**Vấn đề:** lưu "ký tự 1042–1080" thì hỏng ngay khi bài được trích xuất lại hoặc tác giả sửa một đoạn phía trên.

**Cách làm:** lưu `{exact, prefix, suffix, start, end}`. `resolveAnchor` thử theo thứ tự:
1. Tìm `exact` trong văn bản mới; nếu có nhiều bản, chọn bản có **ngữ cảnh xung quanh khớp nhất** (hoà thì gần offset cũ nhất).
   Đúng offset cũ → `position`, ngược lại → `quote`.
2. Không thấy nguyên văn → **fuzzy**: định vị giữa `prefix` và `suffix`, chấp nhận nếu giống ≥ 0.8 (Levenshtein).
3. Không được → trả `null`: highlight thành **"mồ côi"** (giữ lại, báo người dùng) thay vì gắn bừa.
   Trích dẫn ngắn như "the" mà không có ngữ cảnh cũng bị coi là mồ côi — có test.

Tọa độ là `textContent` của HTML đã sanitize, **cùng một chuỗi trên server và client** — đây là hợp đồng quan trọng:
nếu client render HTML khác bản đã sanitize, offset lệch. Do đó client phải render đúng `contentHtml` do server trả.

Giới hạn: `textContent` không chèn khoảng trắng giữa các block (`<p>a</p><p>b</p>` → `ab`), nên prefix/suffix có thể "dính"
qua ranh giới đoạn — vẫn nhất quán nhưng kém đọc được khi debug. Fuzzy chỉ cho đoạn ≤ 2000 ký tự.

**Vẽ highlight lên màn hình:** có hai hướng — bọc `<mark>` quanh range (sửa DOM, rối khi highlight chồng nhau) hoặc
**CSS Custom Highlight API** (không sửa DOM). Em nghiêng về cái sau + fallback `<mark>`, nhưng **chưa kiểm tra mức hỗ trợ
trình duyệt trong phiên này** — cần xác minh trước khi chốt.

## 5. Tích hợp vào MindFerry (đề xuất, chưa code, chưa build thử trong repo đó)

Theo bản đồ ở `docs/mindferry-architecture-map.md` (§A2, §A5) và quy ước `AGENTS.md` (backend mới đặt ở `packages/api`, TypeScript):

| Việc | Vị trí đề xuất |
|---|---|
| Schema `SavedDocument`, `Highlight`, `ReadingProgress` | `packages/data-schemas/src/schema/` + `models/` (dùng `applyTenantIsolation` như `hubThread`) |
| Dịch vụ library dùng `reader-core` | `packages/api/src/library/` |
| Route mỏng | `api/server/routes/library.js` (wiring, giống `hub.js`) |
| MCP tools mới | đăng ký cạnh `hub/mcp/server.ts` (`search_library`, `get_document`, `list_highlights`) |
| UI | `client/src/components/Library/` (list, reader, panel highlight) |

Trường chính cần có: `userId`, `tenantId`, `urlKey` (**unique cùng `userId`**), `normalizedUrl`, `title`, `byline`, `siteName`,
`lang`, `publishedTime`, `contentHtml`, `text` (cho search), `contentHash`, `wordCount`, `readingMinutes`, `location`
(`inbox|later|archive|feed`), `tags`, `fetchedAt`. Highlight: `documentId`, `anchor`, `color`, `note`, `contentHash`, `orphaned`.

Lưu ý khi đưa `reader-core` vào repo đó: kéo theo `jsdom` (nặng) vào server; repo đang dùng `bun.lock` — cần kiểm tra
tương thích. Cả hai điều này **chưa được thử**.

## 6. Search

Semantic search hiện có của MindFerry chỉ re-rank trong pool `$text` (`docs/semantic-search.md`), nên một kho đọc cần
vector index thật. `search/` có hạ tầng pgvector nhưng **chưa có bảng/projector** và `PLAN.md` không nằm trong repo.
Đề xuất: MVP `$text`; đặt search sau một interface để đổi backend sau.

## 7. Offline & đồng bộ — phần khó nhất

Không có code. Hướng: local-first (IndexedDB), mỗi thay đổi là một operation có id, đồng bộ theo `updatedAt`/op-log,
highlight là "thêm-chỉ" nên xung đột ít; tiến độ đọc lấy bản mới nhất. Đây là chỗ dễ sai và tốn công nhất — nên làm
sau khi MVP online chạy ổn.

## 8. Chưa làm (liệt kê để khỏi hiểu nhầm là xong)

HTTP layer & persistence · JS-rendered pages · newsletter qua email · lịch poll feed · OCR · PDF nhiều cột · browser extension · UI ·
offline/sync · tags & filter · quota/rate-limit theo người dùng · AI features · kiểm thử tải · tích hợp proxy egress ·
kiểm chứng hợp đồng `anchorText` của PDF trên trình duyệt thật.

## 9. Ranh giới pháp lý (vì mục tiêu là bán sản phẩm)

- MindFerry/LibreChat là MIT → được bán, giữ nguyên notice bản quyền.
- Mình **không** dùng mã/asset của Readwise. Học cơ chế từ hành vi công khai rồi tự viết lại là chuyện khác với sao chép.
- Reverse engineer app thật (nếu làm sau này) phải bằng tài khoản của chính anh và đọc ToS của Readwise trước.
- **Lưu bản sao nội dung bài báo của bên thứ ba có bản quyền** cho người dùng cuối là rủi ro riêng của sản phẩm kiểu này
  (Readwise cũng gặp). Cần ý kiến pháp lý trước khi thương mại hoá: lưu riêng tư theo từng người dùng, không chia sẻ công khai,
  có cơ chế gỡ khi bị yêu cầu.
- Dữ liệu Readwise của người dùng (nếu tích hợp) → dùng API chính thức với token của chính họ.

## 10. Quyết định

Đã chốt: MVP gồm **PDF, EPUB, RSS**; reverse engineer bằng **tài khoản của chủ dự án, chỉ lấy cấu trúc** (công cụ ở
`reader-core/tools/`, quy trình ở [`re-capture-protocol.md`](re-capture-protocol.md)); sau này mở public để người dùng tự lưu nội dung của họ.

Còn mở:
1. Chính sách với PDF có **hạn chế sao chép** (owner permissions): tôn trọng, hay chỉ cảnh báo?
2. Reader nằm trong cùng deployment MindFerry (multi-tenant) hay tách instance?
3. Có cần headless browser cho trang JS ở MVP không? (kéo theo sandbox)
4. Newsletter qua email: tự dựng hộp thư nhận, hay dùng dịch vụ inbound email bên thứ ba?
