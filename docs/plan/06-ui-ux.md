# Phase 5 — UI / UX

Phase 4 (`ECO-*`) đã đóng. Tài liệu này bốc từ `99-backlog.md` mục **UI / UX**.
Ba task nhỏ, cùng một chủ đề: HUD phải nói đúng những gì người chơi đang thấy.

---

## UIX-01 — Chuột trên HUD không còn làm kẹt trạng thái của canvas — DONE

**Vấn đề gốc:** HUD là DOM phủ lên canvas. `pointerdown` / `pointerup` trên panel
**không bao giờ** tới canvas, nên hai chỗ hỏng:

- Đang arm `A`/`P` hoặc đang đặt nhà mà click vào panel thì lệnh/ghost vẫn sống;
  người chơi phải click ra đất rồi chuột phải/Esc mới thoát.
- Nhả chuột kết thúc quét hộp trên một panel thì `isDragSelecting` không được reset:
  hình chữ nhật xanh còn nằm trên màn hình tới lần click kế tiếp.

**Hành vi mới:** `WorldScene` nghe thêm `pointerdown` / `pointerup` ở **window**
(phase capture), và chỉ xử lý khi `event.target` không nằm trong canvas
(`isCanvasTarget`):

- `pointerdown` ngoài canvas → `placement.cancel()` nếu đang đặt nhà, ngược lại
  `commands.cancelPendingOrder()`. Đây là đúng cảm giác "click ra ngoài là huỷ", và
  React tự nhận `onPlacementCancelled` nên nút "Hủy (Esc)" cũng biến mất.
- `pointerup` ngoài canvas → `middleDrag.end()` (kéo camera bằng chuột giữa cũng có
  thể thả trên panel) và nếu `isDragSelecting` thì gọi `handlePointerUp(pointer, outside = true)`
  nên hộp chọn **hoàn tất** thay vì bị bỏ dở.
- `outside = true` còn chặn nhánh **click-select**: một cú nhấn-rồi-nhả ngắn trên canvas
  nhưng thả vào panel (cách mép vài pixel) trước đây được coi là click tại toạ độ con
  trỏ — tức là `handleClick` hit-test **xuyên qua panel**, chọn unit bị panel che, hoặc
  xoá sạch selection vừa chọn. Giờ nhánh đó bị bỏ, chỉ hộp chọn (kéo thật) mới commit.
- `pointercancel` (touch bị ngắt, kéo chuột ra khỏi cửa sổ) cũng được xử lý, không lọc
  theo target: Phaser bỏ qua event này nên trước đây hộp chọn kẹt vĩnh viễn.
- Listener được gỡ ở `Scenes.Events.SHUTDOWN`.
- `target === null` được coi là canvas: event tổng hợp không bao giờ huỷ input.

**Đo (1 account, CDP, server + client thật):**

| Thao tác | Trước | Sau |
| --- | --- | --- |
| `A` rồi click thanh tài nguyên | `pendingOrder = 'ATTACK_MOVE'` | `null` |
| `A` rồi click ra đất | `null` (commit) | `null` (commit) — không hồi quy |
| quét hộp, thả trên thanh tài nguyên | `isDragSelecting = true` (kẹt) | `false`, selection 3 → 2 áp dụng |
| `Q` rồi click panel | `buildingToPlace = 'TOWN_CENTER'` | `null`, nút "Hủy (Esc)" ẩn |
| chọn 1 dân, nhấn cạnh mép panel + nhả 3 px vào panel | selection bị xoá (click xuyên panel) | selection giữ nguyên `[u_3071]` |
| cùng thao tác nhưng nhả trên canvas | — | selection xoá (đối chứng: đúng nhánh click) |
| `pointercancel` giữa lúc quét hộp | `isDragSelecting = true` (kẹt) | `false` |

---

## UIX-02 — Tooltip huấn luyện có thời gian — DONE

Tooltip trong `EntityDetails` đã có cost + giáp/máu; thiếu `trainTimeMs`, thứ duy nhất
cho biết một đơn vị đắt hay rẻ theo thời gian. Thêm dòng `Huấn luyện: Ns` lấy thẳng từ
`UNIT_BLUEPRINTS` (5 s dân, 7 s giáo, 8 s cung, 10 s kỵ) — không hard-code.

Hotkey huấn luyện **không** thêm: `Q/W/E/R/T` đã thuộc menu xây dựng toàn cục, nên
một phím tắt cho lính cần một lớp ngữ cảnh riêng (chọn nhà nào thì phím đổi nghĩa).
Việc đó nằm lại backlog, không gộp vào task tooltip.

---

## UIX-03 — Panel nhóm quân bên phải HUD — DONE

**Vấn đề:** `Ctrl+1..9` đã gán được nhóm (CTL-01) nhưng không có gì trên màn hình cho
biết nhóm nào còn sống, còn bao nhiêu lính, gồm loại gì — phải bấm thử từng số.

**Hành vi mới:**

- `CommandController.publishControlGroups()` dựng `ControlGroupSummary[]`
  (`index`, `count`, `breakdown` theo `unit.type`), **prune id đã chết** trước khi đếm.
  Push-based: gọi sau khi gán nhóm, sau khi recall (đây là lúc nhóm mất thành viên đã
  chết), khi một unit bị remove (`forgetUnit`), và khi đổi world (`resetControlGroups`).
- Không poll, không quét snapshot mỗi frame — HUD chỉ re-render khi roster đổi thật.
- `ControlGroups.tsx`: hàng `số nhóm · loại + số lượng · tổng`, click = recall y như
  bấm phím số (dùng chung `recallControlGroup`, nên bấm hai lần vẫn pan camera).
  Không có nhóm nào thì không render gì (không thêm chrome vô ích).

**Đo (1 account, CDP):** quét 3 dân → `Ctrl+1` → panel hiện `NHÓM QUÂN | 1 | Dân 3 | 3`;
`clearSelection()` → 0 lính; click hàng nhóm → 3 lính được chọn lại.

**Chưa làm:** nhóm chứa cả công trình (AoE2 cho phép), và kéo-thả để đổi thứ tự nhóm.

---

## Refactor kèm theo — tách camera + guard chuột ra khỏi scene

`WorldScene.ts` đã ở 968 dòng trước đợt này, và UIX-01/UIX-03 đẩy nó lên **1047** —
vượt ngưỡng soi ~1000 mà chính backlog đã ghi. Đã tách đúng hai khối liền mạch:

| File mới | Dòng | Nội dung |
| --- | --- | --- |
| `input/CameraController.ts` | 104 | `setZoom`/`zoomBySteps`/wheel, `Ctrl+F2..F4` bookmarks, `MiddleDragPan`, hằng `ZOOM_*` |
| `input/hudPointerGuard.ts` | 72 | `installHudPointerGuard` (window capture `pointerdown`/`pointerup`/`pointercancel`) + `isCanvasTarget` |

Bốn wrapper cũ trong scene (`zoomTo`, `zoomBySteps`, `saveCameraBookmark`,
`recallCameraBookmark`) đã **xoá**: chúng chỉ chuyển tiếp sang `cameraControl` và làm hai
nơi cùng nhận là chủ của zoom range. `CommandController` gọi thẳng `scene.cameraControl`.
Sau khi tách + xoá wrapper: **`WorldScene.ts` 987 dòng**, `CommandController.ts` 995 dòng
(`tsc --noEmit` sạch cả client và server, 54 test server pass).

Đo lại sau refactor (cùng kịch bản CDP): chọn 3 dân ✓, `Ctrl+1` → panel `Dân 3` ✓,
click hàng nhóm → 3 lính được chọn lại ✓, `+` → zoom 1 → 1.2 ✓, `Ctrl+F2` rồi `+` (1.44)
rồi `F2` → quay lại 1.2 ✓, `A` rồi click HUD → `pendingOrder` `ATTACK_MOVE` → `null` ✓,
tooltip TC hiện `Huấn luyện: 5s` ✓.
