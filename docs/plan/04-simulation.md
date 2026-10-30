# Phase 3 — Simulation Depth

Điều kiện vào phase: Phase 2 xong. Đây là các thay đổi chạm lõi mô phỏng, cần test kỹ.

---

## SIM-01 — Pathfinding

**Vấn đề:** `update()` di chuyển thẳng A→B; lính xuyên qua rừng, mỏ, nhà.
Đây là điểm lệch chuẩn AoE lớn nhất về cảm giác chơi.

**Phạm vi tối thiểu (khuyến nghị làm trước):**
- Grid 220×220, tile 1×1. Chỉ cần **A\* trên lưới 4 hướng** với heuristic octile.
- Bake `blocked` set từ `state.buildings` (footprint) + `state.resourceNodes` +
  `isDirtRoadTile` (đường đi nhanh hơn, không chặn).
- Cache `blocked` theo version: rebuild khi building/resource add/remove.
- Chỉ tính path **1 lần mỗi lệnh**, lưu mảng waypoint vào unit; mỗi tick đi theo waypoint
  hiện tại. Không tính lại mỗi tick (220×220 A* × 200 unit = nổ CPU).

**Schema mới `UnitState`:**
```ts
@type(['number']) pathX = new ArraySchema<number>();
@type(['number']) pathY = new ArraySchema<number>();
```

**Fallback:** nếu A* fail (bị vây) → đi thẳng như hiện tại, không kẹt cứng.

**Rủi ro:** 20 tick/s × nhiều unit. Cần đo: 1 lần A* trên map 220×220 mất bao nhiêu ms?
Nếu > 5ms, phải giới hạn số path tính mỗi tick (hàng đợi, tối đa vd 5 path/tick).

**File mới:** `apps/server/src/services/Pathfinder.ts`
**File sửa:** `UnitState.ts`, `WorldRoom.ts`

---

## SIM-02 — Drop-off & carry capacity

> **ĐÃ CHỐT: LÀM.** Đi kèm CMD-05 để kinh tế về đúng chuẩn AoE.

**Vấn đề:** `processUnitHarvest` cộng thẳng tài nguyên vào `player` mỗi 1s.
AoE bắt dân mang về TC / Lumber Camp / Mining Camp rồi mới cộng.

**Hiện trạng schema:** `UnitState` đã có `carryingResourceType` và `carryingAmount`
nhưng **chưa được dùng ở đâu**.

**Hành vi chuẩn:**
- Dân khai thác 10 đơn vị → `carryingAmount` tăng tới `carryCapacity` (AoE2 = 10).
- Đầy → `actionState = 'RETURNING'`, `targetEntityId` = building drop-off gần nhất.
- Tới nơi → `player[type] += carryingAmount`, `carryingAmount = 0`, quay lại node cũ.

**Cần:**
1. `UnitBlueprint.carryCapacity` (mới, = 10).
2. `BuildingBlueprint.dropOffs: ResourceType[]` — TOWN_CENTER: `['wood','food','gold','stone']`,
   FARM: `['food']` (AoE: farm là nguồn, không phải drop-off — cần quyết định riêng).
3. `UnitState.actionState` thêm `'RETURNING'`.
4. Server `update()` xử lý `RETURNING`: tìm building drop-off gần nhất thuộc cùng owner.
5. Client: hiện icon tài nguyên nhỏ trên đầu dân đang mang (tuỳ chọn).

**Lưu ý cân bằng:** sẽ làm chậm kinh tế đáng kể — cố ý, để đúng chuẩn. Có thể tinh chỉnh
`carryCapacity` và `gatherRate` để không quá chậm.

**Breaking:** thêm `carryCapacity` vào blueprint (không ảnh hưởng DB) +
`actionState` mới `'RETURNING'` (string, không cần reset DB).

**File:** shared constants + types, `WorldRoom.ts`, `WorldScene.ts` (icon tuỳ chọn)

---

## SIM-03 — Tower tấn công

**Vấn đề:** `BUILDING_BLUEPRINTS.TOWER.description` nói "fires arrows at approaching enemy
forces", nhưng `update()` **không** xử lý building combat. Tower chỉ là vật trang trí.

**Hành vi tối thiểu:**
- Thêm `attackPower`, `attackRange`, `attackCooldownMs` vào `BuildingBlueprint`.
- Trong `update()`, với mỗi building đã xong **và** có `attackRange > 0`:
  tìm unit địch gần nhất trong tầm → trừ HP theo cooldown.
- Dùng `Map<string, number>` timer riêng (`towerTimers`), tương tự `attackTimers`.
- Client: vẽ projectile (mũi tên) hoặc chỉ flash — có thể để backlog.

**File:** `packages/shared/src/constants/index.ts`, `WorldRoom.ts`

---

## SIM-04 — Test

**Hiện trạng:** không có test nào cho input, command, hay simulation tick.

**Phạm vi khuyến nghị (chỉ server — client Phaser khó test):**

| Test | Loại |
| --- | --- |
| `handleMoveUnits` từ chối unit không thuộc client | unit |
| `handleAttackTarget` từ chối target đồng minh | unit |
| `handleMoveUnits` giới hạn `unitIds.length` | unit |
| `handleTrainUnit` trừ tài nguyên đúng, chặn khi thiếu | unit |
| `handlePlaceBuilding` chặn overlap / ngoài map | unit |
| `update()` chuyển `MOVING → IDLE` khi tới đích | unit |
| `update()` hoàn thành construction theo `buildTimeMs` (sau CMD-05) | unit |
| `Pathfinder` tìm được đường vòng qua chướng ngại | unit |

**Cần setup:**
- Thêm `vitest` vào `apps/server/devDependencies`.
- Thêm script `"test": "vitest run"`.
- Room có thể instantiate trực tiếp (`new WorldRoom()`) nhưng cần mock `Client`
  (`{ sessionId: 'test', send: vi.fn() }`).

**File mới:** `apps/server/src/rooms/WorldRoom.test.ts`, `apps/server/vitest.config.ts`

---

## Thứ tự làm

`SIM-03` (nhỏ, độc lập) → `SIM-04` (setup test trước khi refactor lớn) →
`SIM-01` (pathfinding) → `SIM-02` (drop-off).

`SIM-02` phụ thuộc `CMD-05` + `SIM-01`: dân phải tìm đường về nhà, nên pathfinding làm trước.
