# Phase 0 — Bugfix (không thêm feature)

Mục tiêu: sửa các hành vi **sai** đang có, không đổi protocol, không đổi schema.
Làm hết phase này trước khi thêm feature, vì Phase 1–2 sẽ dựa trên nền input đã đúng.

---

## BUG-01 — `W` vừa pan camera vừa mở Barracks

**Hiện tượng:** bấm `W` → camera trôi lên *và* vào chế độ đặt Barracks.

**Nguyên nhân:** hai nơi bind cùng phím, không nơi nào biết nơi kia.
- `apps/client/src/App.tsx` → `handleKeyDown`: `'w'` → `handleSelectBuilding('BARRACKS')`
- `apps/client/src/game/scenes/WorldScene.ts` → `wasdKeys` (W/A/S/D) + `update()` pan camera

**Hướng sửa (chọn 1, ghi vào PR):**
- (A) Bỏ `WASD` pan, chuyển sang **mũi tên + edge scroll** (đúng AoE2). Giữ `Q/W/E/R/T` cho build.
- (B) Giữ `WASD`, đổi hotkey build sang dãy khác (vd `Z/X/C/V/B`).

> **Cần xác nhận với user trước khi làm.** Plan giả định chọn (A).

**File:** `apps/client/src/game/scenes/WorldScene.ts`, `apps/client/src/App.tsx`
**Cách kiểm:** bấm `W` → chỉ mở Barracks, camera đứng yên. Bấm mũi tên → camera pan.

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

---

## Thứ tự làm

`BUG-02` → `BUG-07` → `BUG-03` → `BUG-04` → `BUG-05` → `BUG-01` → `BUG-06`

(Bug phía client gom một lượt cho dễ test, `BUG-06` cần sửa shared nên tách commit.)
