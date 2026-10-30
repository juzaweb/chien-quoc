# Phase 0 — Bugfix (không thêm feature)

Mục tiêu: sửa các hành vi **sai** đang có, không đổi protocol, không đổi schema.
Làm hết phase này trước khi thêm feature, vì Phase 1–2 sẽ dựa trên nền input đã đúng.

---

## BUG-01 — `W` vừa pan camera vừa mở Barracks

**Hiện tượng:** bấm `W` → camera trôi lên *và* vào chế độ đặt Barracks.

**Nguyên nhân:** hai nơi bind cùng phím, không nơi nào biết nơi kia.
- `apps/client/src/App.tsx` → `handleKeyDown`: `'w'` → `handleSelectBuilding('BARRACKS')`
- `apps/client/src/game/scenes/WorldScene.ts` → `wasdKeys` (W/A/S/D) + `update()` pan camera

> **ĐÃ CHỐT: phương án (A)** — bỏ `WASD` pan, giữ `Q/W/E/R/T` cho build,
> pan bằng **mũi tên + edge scroll**.
> Hệ quả tích cực: `A`, `P`, `S` trở thành phím trống dùng được cho
> Attack-move (`CMD-01`) và Stop (`CTL-03`).

### BUG-01a — Bỏ WASD pan
1. Xoá khối `this.wasdKeys = this.input.keyboard.addKeys({up: W, left: A, down: S, right: D})`
   trong `create()` và field `wasdKeys`.
2. Xoá 4 nhánh `this.wasdKeys.*.isDown` trong `update()`, chỉ còn `this.cursors.*`.
3. Xoá `apps/client/src/App.tsx` cũng không cần đổi — hotkey build giữ nguyên.
4. Kiểm tra: bấm `W` → chỉ mở Barracks, camera đứng yên.

### BUG-01b — Edge scrolling (bắt buộc, bù cho WASD)
Không có edge scroll thì bỏ WASD sẽ khiến pan rất khó chịu, nên làm ngay trong task này.

1. Trong `update()`, đọc `this.input.activePointer` (toạ độ màn hình, không bị ảnh hưởng camera).
2. Vùng biên `EDGE_SIZE = 24` px (nên scale theo DPR nếu cần).
3. Nếu `pointer.x < EDGE_SIZE` → `scrollX -= cameraSpeed` … tương tự 4 cạnh, có thể chéo góc.
4. **Không** edge-scroll khi con trỏ đang ở ngoài canvas (vd đang hover HUD React) —
   kiểm tra `pointer.x >= 0 && pointer.y >= 0 && x <= width && y <= height`.
5. Có thể thêm hằng `EDGE_SCROLL_ENABLED` để tắt khi test.

**File:** `apps/client/src/game/scenes/WorldScene.ts`
**Cách kiểm:** để chuột ở mép trái màn hình → camera pan sang trái; bấm `W` → chỉ mở Barracks.

> **DONE (cả a và b).**
> - `BUG-01a`: xoá field `wasdKeys`, xoá `addKeys({W,A,S,D})` trong `create()`, xoá 4 nhánh
>   `this.wasdKeys.*.isDown` trong `update()`. `W` giờ chỉ còn hotkey Barracks ở `App.tsx`.
> - `BUG-01b`: thêm `applyEdgeScroll(cameraSpeed)` + hằng `EDGE_SCROLL_SIZE_PX = 24`.
>   Đọc `input.activePointer` (toạ độ màn hình, không phụ thuộc camera); bỏ qua khi con trỏ
>   ra ngoài canvas; hỗ trợ chéo góc; đặt hằng = 0 để tắt.
> - Cập nhật hint ở `AuthScreen.tsx` (bỏ "WASD", thêm "mép màn hình").
> - Verify: 4 cạnh + 2 góc chéo pan đúng chiều, giữa màn hình và ngoài canvas không pan.

---

## BUG-02 — Hit-test chuột phải lệch khỏi thân lính

**Hiện tượng:** chuột phải vào lính địch thường ra lệnh *di chuyển* thay vì *tấn công*.

**Nguyên nhân:** hai công thức hit-test khác nhau cho cùng một sprite.
- `performSingleClickSelection` (chuột trái): `Math.hypot(container.x - wx, (container.y - 18) - wy) < 32`
- `handleRightClickCommand` (chuột phải): `Math.hypot(container.x - wx, container.y - wy) < 25`

Trong khi thân lính thực tế nằm ở `container.y + visualOffsetY`
(`-40` cho bộ binh, `-52` cho kỵ binh, xem `createUnitSprite`).

**Hướng sửa:** tách một helper dùng chung, ví dụ:
```ts
private hitTestUnit(worldX: number, worldY: number): string | null
```
dùng `visualOffsetY` lưu trong `container.setData('visualOffsetY', ...)`.
Cả `performSingleClickSelection` và `handleRightClickCommand` gọi helper này.

**File:** `apps/client/src/game/scenes/WorldScene.ts`
**Cách kiểm:** chuột trái và chuột phải vào cùng một điểm trên thân lính địch → cùng nhận diện đúng unit.

> **DONE.** Đã tách `getUnitBodyBox()` (hình học đo từ content box của spritesheet,
> lưu vào container qua `bodyOffsetY`/`bodyRadiusX`/`bodyRadiusY`) + `hitTestUnit()`.
> Dùng chung cho `performSingleClickSelection`, `handleRightClickCommand` và
> `performBoxSelection`. Chọn theo depth nên click chồng nhiều lính vẫn ra lính trên cùng.
> Đã verify bằng cách đo trực tiếp: hit ở đỉnh đầu / thân / chân / hai bên, miss khi ra ngoài.

---

## BUG-03 — Ngưỡng phân biệt click/kéo cứng 8px

**Hiện tượng:** khi zoom lớn (2.2), click hụt vài pixel bị hiểu thành kéo hộp → mất selection cũ.

**Nguyên nhân:** `handlePointerUp` dùng `Math.hypot` trên **pixel màn hình** với ngưỡng `8`
không chia theo `cameras.main.zoom`.

**Hướng sửa:** quy ngưỡng về **world pixel**:
```ts
const zoom = this.cameras.main.zoom;
const dragDistance = Math.hypot(...) / zoom;
if (dragDistance > 8) { /* box */ } else { /* click */ }
```

**File:** `apps/client/src/game/scenes/WorldScene.ts`

> **DONE.** Ngưỡng đổi thành world-pixel + sàn screen-pixel:
> `threshold = max(CLICK_DRAG_THRESHOLD_WORLD_PX, CLICK_DRAG_MIN_SCREEN_PX / zoom)`
> = `max(8, 6/zoom)`. Hằng số khai báo ở đầu file. Ở zoom 1.6–2.2 dung sai screen là
> 12.8–17.6px nên jitter tay không còn thành kéo hộp; ở zoom 0.4 sàn 6px giữ cho click
> vẫn cảm thấy bình thường thay vì siết còn 3.2px.

---

## BUG-04 — Đặt nhà sai ô thì im lặng

**Hiện tượng:** `isPlacementValid` false → `commitBuildingPlacement` return, **không** feedback,
ghost vẫn hiện, người chơi tưởng game lag.

**Hướng sửa:**
1. Gọi `showCommandFeedback(x, y, 0xef4444)` tại vị trí ghost khi không hợp lệ.
2. Giữ nguyên `buildingToPlace` (AoE giữ chế độ đặt để thử ô khác).

**File:** `apps/client/src/game/scenes/WorldScene.ts`

---

## BUG-05 — `hoverGridCoord` cũ khi click không qua `pointermove`

**Hiện tượng:** đặt nhà bằng cảm ứng / click ngay sau khi camera di chuyển → nhà rơi vào toạ độ cũ.

**Nguyên nhân:** `commitBuildingPlacement` đọc `this.hoverGridCoord`, chỉ được cập nhật trong
`handlePointerMove`.

**Hướng sửa:** trong `handlePointerDown`, khi `buildingToPlace` đang bật, tính lại
`hoverGridCoord` từ `pointer` hiện tại trước khi commit.
Tương tự cho `handleRightClickCommand` (đã tự tính — ok).

**File:** `apps/client/src/game/scenes/WorldScene.ts`

> **DONE.** `commitBuildingPlacement(pointer)` giờ nhận pointer và tự tính
> `screenToGrid(pointer.positionToCamera(cam))` trước khi commit, ghi đè `hoverGridCoord`.
> Nhánh hợp lệ gửi `PLACE_BUILDING` rồi thoát; nhánh sai gọi `showCommandFeedback(...,0xef4444)`
> tại tâm ghost và **vẫn giữ** `buildingToPlace` để thử ô khác.

---

## BUG-06 — Server tin tưởng payload của client

**Hiện tượng:** `handleAttackTarget` / `handleHarvestResource` / `handleMoveUnits` nhận
`unitIds` và `targetEntityId` từ client mà chỉ kiểm tra `unit.ownerId === client.sessionId`.

Các lỗ hổng:
1. `handleAttackTarget` không kiểm tra `targetEntityId` có tồn tại, có phải **kẻ địch**,
   hay `targetType` có khớp với thực thể thật.
2. Tấn công đồng minh / chính mình vẫn được chấp nhận (hậu quả: tự sát).
3. `handleMoveUnits` không giới hạn `unitIds.length` → client gửi 10k id trong 1 message.
4. `handleHarvestResource` không kiểm tra `remainingAmount > 0`.

**Hướng sửa:** thêm validation ở đầu mỗi handler:
- `if (payload.unitIds.length > MAX_SELECTION) return;` (hằng mới trong shared)
- Tra thực thể đích; nếu không tồn tại / cùng `ownerId` → `ERROR_NOTIFICATION` + return.
- Chỉ chấp nhận `HARVEST_RESOURCE` cho unit `type === 'VILLAGER'` **và** `blueprint.canHarvest`.

**File:** `apps/server/src/rooms/WorldRoom.ts`, `packages/shared/src/constants/index.ts`

> **DONE.** Thêm `MAX_SELECTION = 120` vào shared và helper `rejectCommand(client, msg)`.
> - `MOVE_UNITS`: chặn `unitIds.length > MAX_SELECTION`, chặn toạ độ `NaN/Infinity`.
> - `ATTACK_TARGET`: tra target theo `targetType` từ state thật; thiếu → `Target no longer exists`;
>   `ownerId === sessionId` → `Cannot attack your own units or buildings`.
> - `HARVEST_RESOURCE`: kiểm tra node tồn tại, `remainingAmount > 0`, và dùng
>   `UNIT_BLUEPRINTS[type].canHarvest` thay vì so cứng `=== 'VILLAGER'`.
>
> **Lưu ý vận hành:** server đọc `packages/shared/dist`, nên sau khi sửa shared phải
> `cd packages/shared && ../../node_modules/.bin/tsc` rồi restart server, nếu không hằng mới
> sẽ là `undefined` và guard âm thầm bị bỏ qua.
>
> **Lưu ý test:** `ws` chặn frame quá lớn ở tầng transport (không tới handler). Muốn test
> nhánh `MAX_SELECTION` phải dùng payload vừa đủ lớn nhưng dưới ngưỡng frame — 150 id
> (~1.9KB) là đủ, 500 id (6.4KB) làm đứt socket.

---

## BUG-07 — Animation của lính luôn dùng key `villager_*`

**Hiện tượng:** Spearman / Archer / Cavalry di chuyển nhưng chạy animation `villager_walk`.

**Nguyên nhân:** trong `update()` của `WorldScene`:
```ts
if (unitDisplay instanceof Phaser.GameObjects.Sprite && this.anims.exists('villager_walk')) {
  ...
  unitDisplay.play('villager_walk');
```
Đã có sẵn `updateVisualState(actionState)` trong `createUnitSprite` (dùng đúng `${lowerType}_walk`)
nhưng `update()` lại ghi đè bằng key cứng.

**Hướng sửa:** trong `update()`, dùng `container.getData('unitType')` (cần set khi tạo sprite)
để chọn `${lowerType}_walk` / `_idle` / `_harvest`, hoặc gọi lại `updateVisualState`
đã lưu trong `container.setData('updateVisualState', fn)`.

**File:** `apps/client/src/game/scenes/WorldScene.ts` (`createUnitSprite`, `update`)

> **DONE.** `updateVisualState` giờ là một `switch` trên `actionState`, lưu vào container
> qua `setData('updateVisualState', fn)`; `update()` chỉ gọi lại nó, không còn key cứng.
> Có fallback đúng: villager không có `_attack` → về `_idle` thay vì kẹt clip cũ;
> lính không harvest thì `HARVESTING` → `_idle`. `update()` ưu tiên trạng thái lerp thật
> (`MOVING` khi còn di chuyển, `IDLE` khi đã dừng) nên không bị "trượt chân tại chỗ".
> Ma trận đã verify: 4 loại lính × 4 trạng thái đều đúng.

---

## Thứ tự làm

`BUG-02` ✅ → `BUG-07` ✅ → `BUG-03` ✅ → `BUG-04` ✅ → `BUG-05` ✅ → `BUG-01a` ✅ → `BUG-01b` ✅ → `BUG-06` ✅

Phase 0 hoàn tất. Tiếp theo: Phase 1 (`CTL-01`).

(Bug phía client gom một lượt cho dễ test, `BUG-06` cần sửa shared nên tách commit.)
