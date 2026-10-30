# Phase 2 — Command & Combat

Điều kiện vào phase: Phase 1 xong (đã có queue, stop, rally).

---

## CMD-01 — Attack-move / Patrol

**Mục tiêu:** lính vừa đi vừa đánh, đúng chuẩn AoE.

**Hành vi chuẩn:**
- `ATTACK_MOVE`: đi tới điểm đích, **tự tấn công mọi kẻ địch gặp trên đường**, tới đích thì IDLE.
- `PATROL`: đi qua lại giữa A và B, đánh kẻ địch gặp trên đường.
- Hotkey AoE2: `attack-move` = `Ctrl + chuột phải` (hoặc `A` rồi click), `patrol` = `P` rồi click.

**Schema mới trên `UnitState`:**
```ts
@type('string') previousActionState: string = '';  // để quay lại sau khi hết mục tiêu
@type('number') patrolX: number = 0;
@type('number') patrolY: number = 0;
```

**Protocol:**
```ts
export interface AttackMovePayload {
  unitIds: string[];
  targetGridX: number;
  targetGridY: number;
}
// ATACK_MOVE = 'ATTACK_MOVE', PATROL = 'PATROL'
```

**Server:**
- `handleAttackMove`: đặt `actionState = 'ATTACK_MOVE'`, `targetX/Y = grid`.
- Trong `update()`, xử lý `ATTACK_MOVE` giống `MOVING` nhưng trước mỗi tick gọi
  `findNearestEnemyInRange(unit, aggroRadius)`; nếu có → `targetEntityId` set tạm,
  `actionState = 'ATTACKING'`, lưu `previousActionState = 'ATTACK_MOVE'`.
- Khi mục tiêu chết / mất → khôi phục `previousActionState` và tiếp tục về đích.
- Cần thêm `UnitBlueprint.aggroRadius` (AoE2 ~ 6 tiles cho lính).

**Client:**
- `Ctrl + chuột phải` trên đất → `ATTACK_MOVE`. Nếu đang giữ `Ctrl` khi hover quân địch →
  hiện cursor kiếm đỏ.
- `P` rồi click → `PATROL` (2 điểm: vị trí hiện tại + điểm click).

**File:** shared types + constants (`aggroRadius`), `UnitState.ts`, `WorldRoom.ts`, `WorldScene.ts`

---

## CMD-02 — Formation

**Mục tiêu:** sửa cách xếp chỗ khi di chuyển nhóm.

**Hiện trạng (lệch chuẩn):**
```ts
const offsetX = (idx % 3) * 0.5;
const offsetY = Math.floor(idx / 3) * 0.5;
```
→ cả đội 60 lính dồn thành khối 3 cột × 20 hàng, không phải đội hình.

**Hướng sửa:** chia theo `Math.ceil(Math.sqrt(n))` để tạo khối vuông, canh giữa quanh điểm đích:
```ts
const cols = Math.ceil(Math.sqrt(n));
const row = Math.floor(idx / cols);
const col = idx % cols;
const offX = (col - (cols - 1) / 2) * spacing;
const offY = (row - (Math.ceil(n / cols) - 1) / 2) * spacing;
```
với `spacing ≈ 0.6` tile (đủ để ring không chồng).

**Server:** `handleMoveUnits` (và `handleAttackMove` của CMD-01) dùng chung helper
`assignFormationTargets(units, destX, destY)`.

**Alt giữ đội hình:** hiện chưa cần — AoE2 dùng Alt để *giữ* formation hiện tại khi
đang di chuyển; có thể để backlog.

**File:** `apps/server/src/rooms/WorldRoom.ts`

---

## CMD-03 — Context cursor

**Mục tiêu:** con trỏ đổi hình theo mục tiêu dưới chuột (AoE2 dùng `default.cur`, `attack.cur`, ...).

**Triển khai:**
1. Trong `handlePointerMove`, sau khi có `hoverGridCoord`, gọi `resolveCursorMode(worldPoint)`:
   - `attack` — có quân địch trong bán kính hit-test
   - `harvest` — có resource node, và selection hiện tại toàn là villager
   - `build` — đang `buildingToPlace` và ô hợp lệ
   - `move` — mặc định
2. Đổi `this.input.setDefaultCursor(...)` với CSS cursor:
   `default` / `crosshair` / `copy` / `not-allowed`.
3. Chỉ đổi khi **mode thay đổi** (tránh set mỗi frame).

**Lưu ý:** hiện chưa có asset cursor riêng. Dùng CSS cursor trước; asset AoE-style để backlog.

**File:** `apps/client/src/game/scenes/WorldScene.ts`

---

## CMD-04 — Huỷ huấn luyện / huỷ móng nhà

### CMD-04a — Huỷ 1 unit trong queue
- `NetworkMessage.CANCEL_TRAIN`, payload `{ buildingId }` (huỷ unit đầu hàng đợi).
- Server: `shift()` khỏi `trainingQueue`, hoàn lại **100%** tài nguyên của unit đó,
  reset `trainingProgressMs = 0`.
- Server phải biết giá của unit bị huỷ → `building.trainingQueue[0]` chính là unit đó.
- Client: `EntityDetails.tsx` thêm nút ✕ cạnh "Đang chờ: N".

### CMD-04b — Huỷ móng nhà chưa xong
- `NetworkMessage.CANCEL_BUILDING`, payload `{ buildingId }`.
- Server: chỉ cho phép khi `!isConstructed`; hoàn lại tài nguyên **theo tỉ lệ** (AoE hoàn 100%
  khi chưa xây, giảm dần khi đã xong một phần) — chọn: hoàn 100% nếu `constructionProgress < 10`,
  còn lại hoàn 50%.
- Client: chuột phải vào móng nhà của mình khi đang chọn → huỷ (hoặc phím `Delete`).

**File:** shared types, `WorldRoom.ts`, `EntityDetails.tsx` / `WorldScene.ts`

---

## CMD-05 — Nông dân xây nhà (thay vì tự mọc)

**Đây là thay đổi gameplay lớn, cần user xác nhận trước khi làm.**

**Hiện trạng:** `PLACE_BUILDING` trừ tài nguyên → `update()` cộng
`constructionProgress += dt * 100 / 5` → nhà tự hoàn thành sau 5s, bất kể có dân hay không.
`blueprint.buildTimeMs` trong shared **không được dùng**.

**Hành vi AoE2:**
- Đặt móng (0%) → chọn dân → chuột phải vào móng → dân đi tới và bắt đầu xây.
- Tốc độ xây = `Σ(buildPower của dân đang xây)`.
- Không có dân → progress đứng yên.

**Schema mới `BuildingState`:**
```ts
@type(['string']) builderUnitIds = new ArraySchema<string>();
```

**Hành vi server:**
1. `PLACE_BUILDING` giữ nguyên: trừ tiền, tạo building ở 0%, **nhưng** `hp` bắt đầu ở 1
   (AoE: móng nhà HP rất thấp) thay vì 20% `maxHp`.
2. Thêm `BUILD_TARGET` message (hoặc tái dùng `MOVE_UNITS` với cờ `build: true`):
   dân đi tới móng, khi `dist <= 1.5` → push id vào `builderUnitIds`, `actionState = 'BUILDING'`.
3. `update()`: `constructionProgress += dt * 100 * builderCount / buildTimeMs`;
   clamp; khi ≥100 → `isConstructed = true`, `hp = maxHp`, clear `builderUnitIds`.
4. Dân trong `builderUnitIds` mà bị lệnh khác → remove khỏi mảng.
5. `UnitState.actionState` thêm giá trị `'BUILDING'`.

**Client:**
- `handleRightClickCommand`: ưu tiên mới — nếu target là **móng nhà của mình** và selection
  toàn villager → gửi `BUILD_TARGET`.
- Animation `villager_harvest` dùng lại cho `BUILDING`, hoặc thêm `villager_build`.

**Breaking:** đổi `BUILDING_BLUEPRINTS.*.buildTimeMs` sẽ ảnh hưởng cân bằng — review riêng.

**File:** shared types, `BuildingState.ts`, `UnitState.ts`, `WorldRoom.ts`, `WorldScene.ts`

---

## CMD-06 — Auto-retarget cho dân khai thác

**Hiện trạng:** `processUnitHarvest` khi node cạn → `actionState = 'IDLE'` và đứng im.
Trong AoE, dân tự tìm node gần nhất cùng loại.

**Hướng sửa:** trong `processUnitHarvest`, khi `resource.remainingAmount <= 0` (hoặc
`resource` bị xoá), gọi `findNearestResource(unit, resourceType, radius = 10)`;
nếu tìm được → gán `targetEntityId` mới và giữ `actionState = 'HARVESTING'`;
nếu không → `IDLE`.

**File:** `apps/server/src/rooms/WorldRoom.ts`

---

## Thứ tự làm

`CMD-02` (nhỏ, độc lập) → `CMD-03` → `CMD-06` → `CMD-04` → `CMD-01` → `CMD-05`
(CMD-05 cần xác nhận user trước và nên làm sau cùng vì chạm gameplay).
