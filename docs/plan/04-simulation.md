# Phase 3 — Simulation Depth

Điều kiện vào phase: Phase 2 xong. Đây là các thay đổi chạm lõi mô phỏng, cần test kỹ.

---

## SIM-01 — Pathfinding — DONE

**Trạng thái:** xong. `apps/server/src/services/Pathfinder.ts` (A* 4 hướng trên lưới
220×220, binary heap, mảng làm việc cấp phát một lần + generation stamp thay cho việc
xoá 48k ô mỗi lần tìm). `UnitState` thêm `pathX`/`pathY`; `update()` đi theo waypoint và
tiêu thụ từng ô khi tới, đoạn cuối đi thẳng tới `targetX/targetY`.

Quyết định:
- **Heuristic Manhattan, không phải octile** như plan ghi. Di chuyển là 4 hướng, chi phí
  mỗi bước = 1; octile vẫn admissible nhưng ước lượng cao hơn chi phí thật của phần chéo
  nên A* nở thêm node vô ích. Manhattan là heuristic khớp đúng bài toán.
- **Lưới chặn có cache**: dựng từ footprint của `state.buildings` + `state.resourceNodes`
  còn tài nguyên. Chỉ dựng lại khi số building hoặc số node đổi, hoặc quá 1 giây — không
  nằm trên đường đi mỗi tick.
- **Không tính path mỗi tick**: lệnh mới đẩy unit id vào hàng đợi, mỗi tick xử lý tối đa
  12 path / 3 ms. Đích đọc từ `targetX/targetY` hiện tại của unit chứ không phải từ request,
  nên unit bị ra lệnh lại giữa lúc chờ sẽ đi theo đích mới.
- **Fallback đúng như plan**: không có đường (bị vây, hoặc vượt ngân sách tìm kiếm) thì
  path rỗng và unit đi thẳng như trước — không bao giờ đứng im.
- Đích nằm trong vật cản (click vào cây/nhà, hoặc ô đội hình rơi vào tường) được kéo về ô
  trống gần nhất trong bán kính 3 — lệnh vẫn có nghĩa "đi gần nhất có thể".

Đo: A* chéo góc 220×220 trên map trống **0.88 ms/path** (20 lần lấy trung bình) — nên
ngân sách 12 path/tick là ~10 ms xấu nhất, thực tế thường ngắn hơn nhiều vì path ngắn.
Probe socket thật 8/8 PASS: dân đi từ (37,86) tới (27,87) vòng qua Town Center 4×4
(15 waypoint), không mẫu nào nằm trong footprint, tới nơi `IDLE` đúng toạ độ; lệnh mới
được cấp path mới (15 waypoint) chứ không dùng lại path cũ. Test tự động: 3 test
`pathfinding (SIM-01)` trong `WorldRoom.test.ts` (vòng qua tường, không có đường thì đi
thẳng và vẫn tiến, lệnh mới xoá path cũ) + 8 test `Pathfinder.test.ts`.

**Chưa làm (ghi backlog):** không tự tính lại path khi có nhà mới mọc giữa đường (unit sẽ
đi xuyên qua nhà vừa đặt); không mô hình hoá va chạm unit–unit; path không lưu vào SQLite
nên sau restart unit đi thẳng tới đích cũ.

---

**Vấn đề gốc:** `update()` di chuyển thẳng A→B; lính xuyên qua rừng, mỏ, nhà.
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

## SIM-02 — Drop-off & carry capacity — DONE

**Trạng thái:** xong. `UnitBlueprint.carryCapacity` (dân 10, lính 0),
`BuildingBlueprint.dropOffs` (TOWN_CENTER: cả 4 loại; các building khác rỗng — chưa có
Mill/Lumber Camp nên TC là drop-off duy nhất), `UnitState.dropOffId`, action state mới
`RETURNING`.

Luồng: dân đứng cạnh node → mỗi giây lấy `GATHER_AMOUNT_PER_SECOND = 10` vào
`carryingAmount` (không cộng vào player) → đầy túi thì `RETURNING` tới drop-off gần nhất
theo mép footprint, đi bằng pathfinding → tới nơi mới cộng tài nguyên vào player → quay
lại đúng node cũ, hoặc sang node kế tiếp cùng loại nếu node đã cạn.

Quyết định:
- **`targetEntityId` vẫn trỏ node**, `dropOffId` riêng: nhờ vậy dân biết quay về đâu sau khi
  trả hàng, và mỗi trường chỉ có một nghĩa.
- **Mang dở thì vẫn trả** (node cạn giữa lúc đào) — đúng AoE, không xoá tài nguyên đã lấy
  khỏi thế giới.
- **Đổi loại tài nguyên khi đang mang**: `carryingResourceType` chỉ nhớ một loại, nên dân
  mang gỗ được lệnh đi đào vàng sẽ **trả gỗ trước** rồi mới đào vàng. Không có chuyện gỗ
  biến thành vàng.
- **Mất drop-off giữa đường** (nhà bị phá): mỗi tick đọc lại `state.buildings`, không trả
  tiền cho toạ độ ma; nếu còn drop-off khác thì tính đường lại, không còn thì dân đứng giữ
  hàng chứ không làm mất tài nguyên.
- `approachPointOutsideFootprint` tách sang `rooms/geometry.ts` và dùng chung cho cả
  builder (CMD-05) lẫn dân đi trả hàng — cùng một bài toán "đứng sát mép footprint".
- **Client**: `RETURNING` dùng animation đi bộ. Icon tài nguyên trên đầu dân để backlog.
- **Code sống ở `rooms/EconomySystem.ts`** (tách khỏi `WorldRoom` ngay sau SIM-02): class
  nhận `WorldState` + một port `{ setWalkTarget, resumeQueuedWaypoint, rejectCommand }`, giữ
  hai map transient (`gatherTimers`, `harvestTypeByUnit`) và expose `forgetUnit` /
  `clearHarvestOrder`. `WorldRoom` 2215 → 1929 dòng, handler `HARVEST_RESOURCE` chỉ còn một
  dòng gọi sang.

Đo (server thật, 1 account): dân cách TC 5 tile — túi đầy 10 gỗ, `wood` của player vẫn 300;
`RETURNING` với `dropOffId = b_2861`; tới TC `wood 300 → 310`; quay lại `HARVESTING`
`carry=0`; chuyến thứ hai `310 → 320` mất **2.6 s** (≈3.8 gỗ/s/dân, gồm cả đi lại). Probe
9/9 PASS. Test tự động: 6 test `gathering and drop-off (SIM-02)` (mang đầy, trả hàng rồi
quay lại node, mang dở khi node cạn, không có drop-off thì giữ hàng và IDLE, drop-off bị
phá giữa đường không trả tiền, đổi loại tài nguyên thì trả trước).

**Chưa làm (backlog):** chưa có Mill / Lumber Camp / Mining Camp nên mọi loại đều phải về
TC; client chưa hiện icon tài nguyên đang mang; chưa có UI hiển thị tốc độ kinh tế để cân
chỉnh `carryCapacity`.

---

**Vấn đề gốc:** `processUnitHarvest` cộng thẳng tài nguyên vào `player` mỗi 1s.

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

## SIM-03 — Tower tấn công — DONE

**Trạng thái:** xong. `BuildingBlueprint` có `attackPower` / `attackRange` /
`attackCooldownMs` (0 với mọi building trừ TOWER: 10 dmg, 8 tile, 2s). `update()` gọi
`processTowerCombat()` cho building đã xong có `attackRange > 0`; timer riêng
`towerTimers` (xoá cùng lúc xoá building). Tầm đo từ **mép footprint** qua helper dùng
chung `rooms/geometry.ts::distanceToFootprint` (construction và tower cùng một định nghĩa).
Cooldown chỉ reset khi bắn trúng đích, nên tower rảnh sẽ bắn ngay khi có địch bước vào.
Đo thật: 2 account, tower dựng bằng 3 dân, dân địch 50hp mất 10hp mỗi phát và chết sau
~10s; dân cùng chủ đứng sát tower không mất máu; unit ngoài tầm không bị bắn; móng chưa
xong không bắn.
**Còn lại (backlog):** client chưa vẽ projectile/mũi tên — hiện chỉ thấy thanh máu tụt.

---

**Vấn đề gốc:** `BUILDING_BLUEPRINTS.TOWER.description` nói "fires arrows at approaching enemy
forces", nhưng `update()` **không** xử lý building combat. Tower chỉ là vật trang trí.

**Hành vi tối thiểu:**
- Thêm `attackPower`, `attackRange`, `attackCooldownMs` vào `BuildingBlueprint`.
- Trong `update()`, với mỗi building đã xong **và** có `attackRange > 0`:
  tìm unit địch gần nhất trong tầm → trừ HP theo cooldown.
- Dùng `Map<string, number>` timer riêng (`towerTimers`), tương tự `attackTimers`.
- Client: vẽ projectile (mũi tên) hoặc chỉ flash — có thể để backlog.

**File:** `packages/shared/src/constants/index.ts`, `WorldRoom.ts`

---

## SIM-04 — Test — DONE

**Trạng thái:** xong. `vitest` 5.0 + `vitest.config.ts` trong `apps/server`, script
`test` / `test:watch`. 15 test trong `apps/server/src/rooms/WorldRoom.test.ts`, chạy
`npx vitest run` 15/15 pass, `tsc --noEmit` sạch (test file nằm trong `src/**` nên
`tsc` kiểm luôn).

Harness: `new WorldRoom()` + `room.setState(new WorldState())`, **không** gọi `onCreate()`
(vì `onCreate` dựng simulation interval, autosave 30 s và restore SQLite — test không cần
và timer sẽ giữ event loop). Handler private được gọi qua một helper `internals(room)`
duy nhất thay vì rải `as any` khắp file; `update()` được gọi tay với `deltaTime` cụ thể,
nên test tiến trình xây dựng chạy 50 tick trong vài ms thay vì chờ 5 giây thật.

Phủ: `handleMoveUnits` lọc unit khác chủ + chặn quá `MAX_SELECTION`;
`handleAttackTarget` chặn target đồng minh + xoá waypoint cũ khi đổi lệnh;
`handleTrainUnit` trừ đúng giá và không trừ gì khi thiếu tài nguyên;
`handlePlaceBuilding` chặn overlap và ngoài map, không trừ tài nguyên khi bị chặn;
`update()` `MOVING → IDLE` khi tới đích, đi đúng `speed * deltaTime`, hoàn thành móng
đúng `buildTimeMs` với 1 dân, móng không có dân thì đứng yên; SIM-03 tower bắn unit địch
trong tầm, không bắn dân cùng chủ, không bắn khi còn là móng, và giãn đúng
`attackCooldownMs`.

Đã kiểm tra test có "răng": sửa tạm `collectOwnedUnits` bỏ check chủ và tower damage
xuống 1 → 3 test đỏ đúng chỗ, revert xong xanh lại.

**Chưa phủ:** dòng "Pathfinder tìm đường vòng" trong bảng dưới — `Pathfinder` chưa tồn tại,
để sang SIM-01. Client (Phaser) không test.

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
