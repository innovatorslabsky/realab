# MindFerry — Architecture Map & Reader Integration Notes

Nguồn: đọc trực tiếp repo `innovatorslabsky/MindFerry` @ `05645ce` (shallow clone, chỉ đọc code/doc,
**chưa chạy app**). Mỗi nhận định có ghi file nguồn. Chỗ nào là suy luận của em thì đánh dấu **[suy luận]**.

---

## Phần A — Bản đồ kiến trúc

### A1. MindFerry thực sự là gì

Fork của LibreChat (MIT) + một lớp **"Context Hub"** (`docs/mindferry.md`): kho lưu hội thoại
đa-provider (ChatGPT / Claude / Gemini / chính MindFerry) và phơi ra qua **MCP** để Claude.ai /
Claude Code đọc làm context. Vậy repo có **hai nửa**:

| Nửa | Là gì | Code chính |
|---|---|---|
| **Chat app** (từ LibreChat) | Chat đa-model, agents, MCP client, artifacts, code workspace… | `api/`, `client/`, `packages/*` |
| **Context Hub** (phần riêng của MindFerry) | Archive hội thoại + notes, MCP server, OAuth 2.1, import, git mirror | `packages/api/src/hub/`, `api/server/routes/hub.js` |

> Nửa thứ hai mới là điểm cắm tự nhiên cho reader — xem Phần B.

### A2. Cấu trúc monorepo (theo `AGENTS.md`)

- `packages/api` — backend **TypeScript** (nơi code backend mới nên nằm)
- `packages/data-schemas` — schema + hàm truy cập DB (Mongoose)
- `packages/data-provider` — types/service dùng chung client ↔ server
- `packages/client` (`@librechat/client`) — component primitives; `client/` — React app
- `api/` — Express **legacy**, chủ yếu là wiring (routes/controllers/services gọi vào `packages/api`)

Quy ước đáng nhớ: nhánh làm việc `dev`, PR target `dev`; `npx tsc --noEmit` ở mỗi workspace đã đổi;
đổi startup/auth/config/message-loading phải chạy `npm run lighthouse`.

### A3. Luồng chat

```
Client (ChatView + ChatForm)
  └─ hooks: useChatHelpers / useAdaptiveSSE / useResumeOnLoad   (client/src/hooks/Chat)
        │  POST tin nhắn
        ▼
api/server/routes/agents/chat.js      ← middleware: auth, moderation, validateConvoAccess,
        │                                buildEndpointOption, canAccessAgentFromBody
        ▼
controllers/agents/request.js         ← orchestration (file rất lớn, import ~70 helper từ @librechat/api)
        │   GenerationJobManager (packages/api) — quản lý job sinh, hủy, resume
        ▼
Agent run  → model/provider + tools + MCP  → stream về client
        │
        ▼
saveMessage / saveConvo  →  Mongo (Conversation, Message)
```

- Streaming: tên hook (`useSSE`, `useAdaptiveSSE`) + `GenerationJobManager` cho thấy là SSE có resume;
  **em chưa đọc nội bộ** nên không khẳng định chi tiết giao thức.
- `CONTEXT.md` là glossary rất dày (agent run envelope, execution host, queued turn, steer…): đây là
  phần "agent runtime" phức tạp. **Reader không cần đụng vào nó.**

### A4. Data model chính

| Model | File | Ghi chú |
|---|---|---|
| `Conversation` | `data-schemas/src/schema/convo.ts` | `conversationId`, `title`, `user`, `messages[]`; plugin **Meili** tùy chọn (`MEILI_HOST`) |
| `Message` | `.../schema/message.ts` | `messageId`, `conversationId`, `parentMessageId` (cây), `text`, `sender`, `tokenCount`… |
| `HubThread` | `.../schema/hubThread.ts` | Thread đã archive. id = `${provider}:${sourceId}`; `messages[].segments[]` kiểu `text/thinking/code/tool`; `searchText` cho `$text`; unique `(userId, id)` |
| `HubNote` | `.../schema/hubNote.ts` | `title`, `text`, `threadId?` (neo vào thread), `surface?`, `sessionTag?` |

Mọi model dùng `applyTenantIsolation` (multi-tenant sẵn) — **đây là thứ sản phẩm bán được cần**, nên reader phải đi theo.

### A5. Context Hub chi tiết

- **Config**: khối `contextHub` trong `librechat.yaml` (`enabled`, `mcp.*`, `git.*`). Mặc định tắt.
- **Adapter pattern**: `ChatSource { provider, detect(payload), parse(payload) → HubThread[] }`
  (`hub/source.ts`). Adapter có sẵn: `chatgpt`, `claude`, `gemini`, `librechat`. Thêm nguồn mới =
  thêm adapter, không sửa code chung. Mọi consumer (render markdown, MCP, git mirror) chỉ đọc `HubThread`.
- **MCP server** (`hub/mcp/server.ts`), 7 tool: `search_context`, `get_thread_outline`, `get_thread`,
  `read_notes`, `append_note`, `archive_thread`, `open_in_chat`. Thiết kế 3 tầng chi phí: search → outline → full.
- **Auth**: OAuth 2.1 (Dynamic Client Registration + PKCE) cho Claude.ai connector; Agent API key cho Claude Code
  (`hub/oauth/*`). Cần `DOMAIN_SERVER` + `JWT_SECRET`.
- **REST cho UI**: `api/server/routes/hub.js` (threads, notes, import, continue-in-chat…).
- **Import/continue**: đưa thread hub thành chat thường qua importer có sẵn → kế thừa content filter + size limit.
- **Git mirror** (tùy chọn): ghi archive ra repo GitHub dạng Markdown (`hub/git/*`).
- **Semantic search**: query-time re-rank trên candidate pool của `$text`, **không lưu embedding**
  (`docs/semantic-search.md`).
- **Client**: `client/src/components/Nav/SettingsTabs/ApiKeys/{BrowseHubDialog,HubArchiveBrowser,HubThreadDetail,HubNoteList}.tsx`,
  `components/Conversations/HubSection.tsx`, `data-provider/Hub/`.

### A6. Lưu ý dễ nhầm

- `components/Bookmarks/` = **gắn nhãn hội thoại**, không phải "lưu bài viết".
- `useLazyHighlight` = tô màu code, không phải highlight văn bản của reader.
- → **MindFerry hiện chưa có khái niệm "tài liệu để đọc"** (URL/PDF/EPUB, tiến độ đọc, highlight có vị trí).

---

## Phần B — Hạ tầng search & điểm cắm reader

### B1. Hiện trạng đọc được

**Không có `PLAN.md` trong repo.** `search/README.md` và `search/compose.yml` trích dẫn nó ("PLAN.md
decision 3", "track 4") và một worktree tên `postgres-ferretdb-clickhouse-rag-b6bc87` — kế hoạch nằm
ngoài repo này. Vì vậy dưới đây chỉ là những gì **README/compose khẳng định**, không phải toàn bộ kế hoạch.

`search/` là **PoC hạ tầng (Track 1) — chỉ infra, chưa có migration hay app code**:

| Service | Image | Vai trò |
|---|---|---|
| `ferretdb-postgres` | postgres-documentdb 17 (wal_level=logical) | backing store của FerretDB |
| `ferretdb` | FerretDB 2.7.0 (port 27021) | cầu Mongo-wire → Postgres |
| `chat_search_db` | pgvector 0.8.6 / PG17 (port 5435) | **store search chuyên dụng** (khác `vectordb` của `rag_api`) |
| `clickhouse` | 26.3 LTS | tầng search lịch sử, additive |

Đã dựng sẵn 3 role least-privilege cho `chat_search_db`: `owner` (migration), `writer` (projector/outbox
consumer — không bao giờ là request pod), `reader` (**forced RLS**, chỉ role này request pod được giữ).
README ghi các bảng dự kiến `chat_search.documents / embeddings / outbox / watermark` là **"việc của track 4"** →
**chưa tồn tại**. README cũng ghi kiểm tra live ngày 2026-08-07 (4 container healthy, role đúng, pgvector `<=>`
chạy được).

Mô hình ngụ ý: **outbox/projector** — Mongo vẫn là source of truth, một projector ghi sang Postgres/ClickHouse,
request chỉ đọc qua reader role có RLS. **[suy luận từ tên role/bảng, chưa có code xác nhận]**

Hiện đã có song song: `rag.yml` (`vectordb` pg15 + `rag_api`) cho file search của LibreChat gốc.

### B2. Hai cách cắm reader

**Cách 1 — Reader như một "provider" của Hub.** Thêm adapter, biến mỗi bài đã lưu thành `HubThread`;
highlight thành `HubNote` neo vào `threadId`.
- (+) Được sẵn: MCP, OAuth, search, Browse UI, git mirror, tenant isolation.
- (−) `HubThread` hình **hội thoại** (messages/role/segments). Bài báo ≠ hội thoại; `HubNote` không có
  offset/quote nên highlight phải mở rộng schema. `HUB_PROVIDERS` là const tuple dùng trong `z.enum` → đổi là đổi hợp đồng MCP.
  **[suy luận]** Dễ "nhét vừa" ở MVP nhưng sẽ vướng khi thêm tiến độ đọc, HTML gốc, tag, PDF/EPUB.

**Cách 2 — Collection riêng (`SavedDocument`, `Highlight`) + học pattern của Hub.** Schema đúng hình bài đọc,
vẫn dùng `applyTenantIsolation`, `$text`, đăng ký thêm MCP tool (`search_library`, `get_document`…), cùng OAuth.
- (+) Mô hình sạch, mở rộng được.
- (−) Phải tự làm UI list/reader/Browse; MCP/OAuth chỉ tái dùng ở mức pattern + đăng ký thêm tool.

**Khuyến nghị: Cách 2**, copy pattern của Hub. Chỉ dùng chung với Hub ở 3 điểm: tenant isolation, cơ chế MCP/OAuth,
và nút "Continue in chat" (đưa tài liệu/highlight vào chat qua importer có filter + size limit).

### B3. Vấn đề search cho thư viện đọc

- Semantic search hiện tại **không đủ** cho kho tài liệu: nó chỉ re-rank trong pool `$text`; tài liệu không
  trùng từ khóa thì không bao giờ lọt vào pool (doc tự nói đây là giới hạn có chủ ý).
- Kho đọc cần **vector index thật** → khớp với hướng `chat_search_db` (pgvector). Nhưng nó **chưa có bảng, chưa có
  projector**. Hai lựa chọn: (a) MVP dùng `$text` + re-rank như hiện tại, nâng cấp sau; (b) chờ/đóng góp Track 4.
  **[đề xuất]** (a) trước để ra sản phẩm; thiết kế interface search để thay backend sau này.

### B4. Câu hỏi cần anh/chủ repo trả lời trước khi code

1. `PLAN.md` ở đâu? Track 4 (DDL `documents/embeddings`) đã có ai làm chưa, hay reader sẽ tự dựng?
2. Reader có chạy trong cùng deployment MindFerry (multi-tenant) hay tách instance?
3. Loại nội dung MVP: chỉ URL→bài đọc, hay có PDF/EPUB/RSS từ đầu? (ảnh hưởng lớn tới công sức)
4. `contextHub` có bắt buộc bật cho người mua không? (reader sẽ phụ thuộc OAuth/MCP của hub nếu theo hướng chia sẻ)

### B5. Chưa kiểm chứng

- Chưa chạy app / test; chưa đọc nội bộ streaming (`GenerationJobManager`), `hub/mcp/route.ts`, `ingest.ts`, `sync.ts`.
- Chưa xác nhận `search/` được nối vào app (chỉ thấy infra + flag `CHAT_SEARCH_*` nhắc trong README).
- Không đọc được PLAN.md.

### B6. Ranh giới pháp lý (cho mục tiêu bán sản phẩm)

Nền MindFerry/LibreChat là MIT → được bán, **giữ nguyên notice bản quyền gốc**. Phần "giống Readwise":
chỉ học **cơ chế** và tự viết lại; không copy mã/asset của Readwise; kiểm tra ToS của họ; nếu tích hợp
dữ liệu Readwise của người dùng thì dùng **API chính thức** với token của chính họ.
