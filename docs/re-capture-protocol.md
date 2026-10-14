# Quy trình bắt cấu trúc `read.readwise.io` (chạy trên máy anh, tài khoản của anh)

**Mục tiêu:** hiểu *cấu trúc* — endpoint, hình dạng dữ liệu, cách client tổ chức/đồng bộ — để mình tự thiết kế lại.
**Không** nhằm lấy nội dung bài đã lưu. Công cụ dưới đây chỉ in tên và kiểu, không in giá trị.

## 0. Quy tắc an toàn (đọc trước)

1. **Chỉ dùng tài khoản của anh.** Không dùng dữ liệu hay session của người khác.
2. **Dùng dữ liệu thử vô hại.** Tạo vài bài công khai (blog/Wikipedia), một PDF và một EPUB mẫu (sách miễn phí như Project Gutenberg),
   một RSS công khai. Nhờ vậy dù có gì lọt ra cũng không nhạy cảm.
3. **Không gửi file HAR thô cho ai, kể cả em.** HAR chứa session token, cookie và nội dung bài. Chỉ gửi **đầu ra của công cụ**.
4. **Đọc lướt đầu ra trước khi gửi.** Công cụ không ghi giá trị, nhưng tên database/store hay tên trường có thể chứa id của anh.
5. Đừng dùng cách này để vượt đăng nhập, paywall hay giới hạn của dịch vụ; và nên đọc điều khoản (ToS) của Readwise về reverse engineering.

## 1. Chuẩn bị

```bash
git clone https://github.com/innovatorslabsky/realab && cd realab/reader-core
git checkout claude/dazzling-darwin-ma4hrp
npm install            # cần Node >= 22.18
```

Chrome: mở một **cửa sổ mới**, đăng nhập `read.readwise.io`, mở DevTools (F12) → tab **Network** → tick **Preserve log**
và **Disable cache**.

## 2. Các "flow" cần bắt — mỗi flow một file HAR riêng

Bắt riêng từng flow giúp phân tích rõ ràng. Mỗi flow: bấm 🚫 (Clear) → làm các bước → chuột phải trong danh sách request →
**Save all as HAR with content**.

| # | Flow | Các bước |
|---|---|---|
| 1 | `cold-load` | Tải lại trang thư viện (Ctrl+Shift+R), đợi danh sách hiện đủ. |
| 2 | `save-url` | Lưu 1 URL công khai; đợi nó xuất hiện và được xử lý xong. |
| 3 | `read` | Mở bài đó, cuộn xuống giữa, cuộn lên, đóng bài, mở lại (xem nó nhớ chỗ đọc). |
| 4 | `highlight` | Bôi đen một đoạn → tô màu → thêm note → gắn tag → xoá highlight. |
| 5 | `organize` | Chuyển bài giữa các mục (Inbox/Later/Archive), xoá một bài. |
| 6 | `feed` | Thêm một RSS công khai, mở một bài từ feed, lưu nó vào thư viện. |
| 7 | `upload-pdf` | Tải lên PDF mẫu, mở, bôi đen một đoạn. |
| 8 | `upload-epub` | Tải lên EPUB mẫu, mở, đổi chương, bôi đen một đoạn. |
| 9 | `search` | Gõ vài truy vấn trong ô tìm kiếm. |
| 10 | `sync` | Mở trang ở **hai tab**; highlight ở tab A, quan sát tab B (xem có WebSocket/polling không). |
| 11 | `offline` | Network → *Offline*; tải lại; mở một bài đã đọc; highlight khi offline; bật mạng lại. |

## 3. Chạy công cụ trên từng HAR

```bash
node tools/har-structure.ts ~/Downloads/save-url.har --first-party readwise.io > save-url.md
```

- Mặc định **không** liệt kê từ vựng (vd tên `location`). Nếu muốn biết các giá trị enum ngắn (inbox/later…), thêm `--enums`.
  Chỉ các từ ngắn, ít giá trị, không thuộc trường nội dung (title, text, note, url…) mới được liệt kê.
- Có thể thêm `--json` nếu muốn dạng máy đọc.
- Xoá file `.har` thô sau khi chạy xong.

## 4. Khung giao diện (DOM) — không chứa chữ nào của bài

Dán toàn bộ nội dung `tools/dom-skeleton.browser.js` vào **Console** ở từng màn hình rồi copy kết quả
(script tự gọi `copy()`): thư viện, màn đọc, thanh công cụ highlight đang mở, màn PDF, màn EPUB, màn feed.
Có thể thu hẹp: `window.__domSkeletonOptions = { selector: '#root' }` trước khi dán.

## 5. Lưu trữ phía client (cho phần offline)

Tab **Application**: ghi lại (chỉ **tên**, không chép giá trị)
- Service Workers: có hay không, đường dẫn script.
- Cache Storage: tên các cache.
- localStorage / sessionStorage: chỉ tên key.
- IndexedDB — dán đoạn sau vào Console, nó chỉ in tên database/store/index và cấu hình khoá, **không đọc dữ liệu**
  (đoạn này mới ở mức đề xuất, chưa được test tự động):

```js
(async () => {
  const out = [];
  for (const { name } of await indexedDB.databases()) {
    const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const stores = [...db.objectStoreNames].map((s) => {
      const st = db.transaction(s).objectStore(s);
      return { store: s, keyPath: st.keyPath, autoIncrement: st.autoIncrement,
        indexes: [...st.indexNames].map((i) => ({ name: i, keyPath: st.index(i).keyPath, unique: st.index(i).unique })) };
    });
    out.push({ db: name, version: db.version, stores });
    db.close();
  }
  console.log(JSON.stringify(out, null, 2));
  copy(JSON.stringify(out, null, 2));
})();
```

## 6. Gửi lại cho em

Dán vào chat: các file `*.md` từ bước 3, kết quả bước 4 và 5. Nếu thấy dòng nào có thông tin cá nhân (tên database chứa id, v.v.), thay bằng `XXX`.

## 7. Em sẽ làm gì với nó

Từ các báo cáo này em dựng: bản đồ API (endpoint, auth, phân trang, mã lỗi), mô hình dữ liệu (document, highlight, tag, feed, tiến độ đọc),
cách đồng bộ & offline, cấu trúc giao diện, và cách họ xử lý PDF/EPUB — rồi đối chiếu với thiết kế ở `docs/reader-architecture.md`
để quyết định giữ/bỏ/đổi. Mọi thứ vẫn **viết lại bằng code của mình**, không sao chép.
