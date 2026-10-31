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

> **DONE.**
> - Schema: `UnitState.previousActionState`, `patrolX`, `patrolY`. `previousActionState` is the
>   order parked when the unit breaks off to fight; empty means a plain `ATTACK_TARGET`, which
>   has nothing to return to. `patrolX/patrolY` hold the far end of the route, `targetX/targetY`
>   the end currently walked towards — they swap on every arrival.
> - `UnitActionState` thêm `'ATTACK_MOVE' | 'PATROL'`; `UnitBlueprint.aggroRadius` (tile):
>   VILLAGER `0`, mọi lính `6`. Dân vẫn attack-move được (theo yêu cầu AoE), nhưng không tự
>   lao vào địch nên tổ thợ mộc không bỏ cây chạy theo scout đi ngang.
> - `ATTACK_MOVE` / `PATROL` dùng chung `AttackMovePayload` và **chung** handler
>   `handleAttackMove(client, payload, mode)`: validate → lọc id (dedupe + đúng chủ) → xếp đội
>   hình bằng `computeFormationOffsets` như `handleMoveUnits`, nên đội giữ đội hình khi vừa đi
>   vừa đánh. `STOP`/move/attack/harvest đều reset `previousActionState` để một lệnh cũ không
>   hồi sinh sau khi đổi ý.
> - `update()`: trước mỗi bước đi, unit `ATTACK_MOVE`/`PATROL` có `aggroRadius > 0` quét
>   `findNearestEnemyUnit(unit, aggroRadius)` (chỉ unit — không auto-đánh công trình đi ngang);
>   thấy địch → lưu `previousActionState`, chuyển `ATTACKING` với target tạm.
> - `endAttackOrder(unit)` thay cho các nhánh `IDLE`/`resumeQueuedWaypoint` cũ ở **5 chỗ**
>   (target unit chết, target unit mất, building sập, building mất, và pre-check mỗi tick):
>   khôi phục `ATTACK_MOVE`/`PATROL` nếu có, còn lại mới rơi về queue/IDLE. Thiếu pre-check
>   thì unit bị xoá khỏi snapshot (bị người khác giết) sẽ đứng lại với target treo.
> - Đến đích: `ATTACK_MOVE` → `IDLE` (đúng AoE); `PATROL` → swap 2 đầu và đi ngược lại; route
>   có 2 đầu trùng nhau (< 0.15 tile) thì kết thúc thay vì ping-pong mỗi tick.
> - Client: `A` arm attack-move, `P` arm patrol (đúng kiểu 2 bước của AoE), `Ctrl + chuột
>   phải` = attack-move ngay. Đều gate theo: không modifier, không đang đặt nhà, có unit được
>   chọn. Cursor `crosshair` khi đã arm (`CursorMode 'order'`); click trái trên canvas = chốt
>   điểm, chuột phải/`Escape` = huỷ (Escape đi qua `clearSelection`). Click vào HUD panel thì
>   **không** chốt lệnh (pointerdown không tới canvas), lệnh vẫn armed — chấp nhận được.
> - `A`/`P` debounce 250 ms bằng `performance.now()` cùng lý do với `Delete`: Phaser
>   re-emit `keydown` khi giữ phím, một lần nhấn sẽ arm/gửi hàng chục lần.
> - Animation: `ATTACK_MOVE`/`PATROL` dùng `*_walk`.
>
> **Bug phát hiện khi test (đã sửa):** camera tự trôi lên-trên-trái ngay sau khi load. Nguyên
> nhân: `applyEdgeScroll` đọc `input.activePointer`, mà trước pointermove thật đầu tiên Phaser
> báo pointer ở `(0,0)` — nằm gọn trong band edge-scroll 24px, nên mỗi frame trừ `scrollX/Y`.
> Đo được scroll `(1480,7555)` → `(-5341,735)` chỉ sau ~10 s đứng yên, tức camera rời khỏi base
> trước khi người chơi chạm chuột. Sửa: cờ `hasPointerMoved` (set trong `handlePointerMove`),
> `applyEdgeScroll` bỏ qua khi chưa có pointermove thật. Đây là bug có sẵn từ BUG-01b, không
> phải do CMD-01.
>
> **Verify (socket probe thật, 2 account trên port 2568):**
> - `ATTACK_MOVE` dân 3 tile: `ATTACK_MOVE` → đi → `IDLE` tại `(111.87,35)` với target `(112,35)`.
> - `PATROL` dân 3 tile: `patrol=(106,38)`, `target=(109,38)` → tới đầu kia swap thành
>   `target=(106,38)`, `patrol=(109,38)`, về `x=106.03` vẫn `PATROL` → `STOP` → `IDLE`,
>   `target=(106.03,38)`.
> - Payload có id của account khác: dân B **không** đổi gì, dân A trong cùng payload vẫn nhận
>   lệnh (lọc theo owner, không phải reject cả lệnh).
> - Spearman thật (Barracks 102,35 → train 7 s) attack-move từ `(102,38)` tới base B `(190,173)`:
>   đi 62.2 s → `ATTACKING` với `previousActionState='ATTACK_MOVE'`, `entity=u_2338`; giết lần
>   lượt 3 dân B (62.2 s → 79.7 s → 88.2 s, mỗi lần về `ATTACK_MOVE` rồi aggro lại mục tiêu gần
>   nhất); sau mục tiêu cuối → `ATTACK_MOVE` → `IDLE` tại `(189.92,173.07)` đúng target
>   `(190,173)`. 0 `ERROR_NOTIFICATION`.
>
> **Verify (browser thật, 1264×569, account thật + observer socket đọc state):**
> - Box-select 3 dân → `A` → `pendingOrder=ATTACK_MOVE`, cursor `crosshair`; click trái
>   → 3 unit `ATTACK_MOVE` target `(142.7,105.7)/(143.3,105.7)/(142.7,106.3)` (đội hình quanh
>   ô click `(143,106)`).
> - `P` + click → 3 unit `PATROL` với `patrol` = vị trí đứng, `target` = ô click; sau ~2.5 s
>   swap (`target` quay về chỗ cũ, `patrol` = ô vừa tới), sau ~5 s đã đi ngược về `x≈142.6`,
>   vẫn `PATROL`.
> - `Ctrl + chuột phải` → 3 unit `ATTACK_MOVE` target `(139.7,104.7)`; chuột phải thường khi
>   chưa arm → `MOVING` target `(140.7,105.7)` (không hồi quy).
> - Chuột phải lúc đang arm → `pendingOrder=null`, cursor `default`, **không** gửi lệnh nào;
>   `Escape` → pending `null`, selection 0.
> - Camera sau reload: giữ `(1480,7555)` sau 9 s (trước fix: trôi tới `(-5341,735)`); rê chuột
>   sát mép trái → `scrollX 1480 → 610` (edge scroll vẫn chạy).
> - `tsc --noEmit` sạch client; server sạch sau `prisma generate` (trước đó lỗi implicit-any
>   của Prisma client chưa sinh, không liên quan diff này).
>
> **Chưa phủ:** aggro chỉ nhắm unit, không nhắm công trình (cố ý); hành vi "click HUD khi đang
> arm không huỷ lệnh" ghi backlog; chưa test patrol của lính có aggro thật trong browser (đã
> test bằng socket cho attack-move, patrol chỉ test với dân `aggroRadius = 0`).
>
> **Review pass (sửa sau khi đọc lại diff):**
> - `handleAttackMove` copy nguyên khối validate → dedupe → xếp đội hình → clamp của
>   `handleMoveUnits`. CMD-02 đã chốt helper dùng chung nhưng chưa làm. Tách
>   `collectOwnedUnits(client, unitIds)` và `assignFormationTargets(units, destX, destY)`; cả
>   `MOVE_UNITS`, `ATTACK_MOVE`, `PATROL` giờ đi qua đúng một đường.
> - Pre-check target chết gắn với `targetEntityId` khác rỗng, nên một unit `ATTACKING` mà mất
>   target id sẽ đi tiếp tới `targetX` cũ với `stopDist = attackRange` và đứng đó vĩnh viễn.
>   Tách `isAttackTargetAlive(unit)` coi "không có target" là target đã mất → đi chung nhánh
>   `endAttackOrder`.
> - Client: lệnh đã arm không thuộc về selection nào cả. Nếu toàn bộ unit được chọn chết (hoặc
>   selection bị thay bằng nhà), `pendingOrder` còn sống thì cú click sau bị nuốt mà không
>   gửi gì. `notifySelectionChange` giờ bỏ lệnh khi `selectedUnitIds` rỗng.
> - Client: nhánh commit lệnh đã arm chạy trước nhánh placement. `setBuildingMode` xoá selection
>   nên hiện tại không lọt, nhưng thêm `!this.buildingToPlace` để lần sau không phải nhớ.
>
> **Verify (sau review, server 2570 + browser 5173 trên code hiện tại):**
> - Socket 2 account: 1 unit + 1 id lặp + 1 unit của account B → chỉ unit A nhận lệnh, target
>   đúng `(57,168)`, B vẫn `IDLE`; 3 dân → khối `56.7/57.3 × 169.7/170.3`; `ATTACK_MOVE` 3 dân
>   ra đúng target đội hình rồi `IDLE`; `PATROL` swap `target 163.7 ↔ patrol 173.7`; `STOP` →
>   `IDLE/IDLE/IDLE`.
> - Fight thật: Barracks cạnh base B → train spearman → `ATTACK_MOVE` tới dân B gần nhất
>   (d = 6.40): aggro → `ATTACKING` với `previousActionState='ATTACK_MOVE'`, giết 3 dân B, quay
>   lại `ATTACK_MOVE` rồi `IDLE` tại `(68.10,139.92)` đúng target `(68,140)`, 0 lỗi.
> - Browser (1264×569): `A` + click → 3 unit `ATTACK_MOVE` đội hình `(54.7,165.7)/(55.3,165.7)/
>   (54.7,166.3)`, cursor `crosshair`; `clearSelection` và `setBuildingMode('HOUSE')` đều xoá
>   `pendingOrder` (sau đó click đặt House thật: wood 300 → 250, foundation xuất hiện, thoát
>   placement); chuột phải lúc arm → `pending=null`, cursor `default`, không gửi lệnh; chuột
>   phải thường → `MOVING`; `Ctrl + chuột phải` → `ATTACK_MOVE` đội hình.
> - `tsc --noEmit` sạch cả `apps/server` và `apps/client`.

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

> **DONE.**
> - Thay offset 3 cột cứng bằng helper `computeFormationOffsets(count, spacing)`:
>   khối vuông `cols = ceil(sqrt(n))`, `rows = ceil(n / cols)`, mỗi ô lệch
>   `(col - (cols-1)/2) * spacing` / `(row - (rows-1)/2) * spacing` → trọng tâm đội
>   rơi đúng ô click. `FORMATION_SPACING = 0.6` tile.
> - Helper trả **offset** chứ không trả target đã clamp: việc clamp biên map và nhánh
>   queue/plain move thuộc `handleMoveUnits`, nên CMD-01 (`handleAttackMove`) chỉ cần
>   gọi cùng helper rồi dùng chung đoạn áp target.
> - `handleMoveUnits` giờ **validate trước, xếp đội hình sau**: gom unit hợp lệ
>   (đúng owner) vào một mảng rồi mới tính offset. Trước đây offset tính theo `idx`
>   của payload, nên id lạ/chết để lại lỗ trong đội hình (đội 3 lính gửi kèm 1 id sai
>   sẽ bị xếp thành khối 4 ô).
> - Khử id trùng bằng `Set`: payload lặp id từng đẩy 2 lệnh + 2 offset cho cùng một unit.
> - Nhánh `queue: true` dùng **cùng** offset (mỗi waypoint là một khối vuông riêng),
>   nên di chuyển Shift-queue vẫn giữ đội hình thay vì dồn một điểm.
>
> **Verify (socket probe thật, 3 dân):** `(100,100)` → `(99.70,99.70) (100.30,99.70) (99.70,100.30)`;
> payload lặp id `[u,u]` → đúng `(130.00,130.00)` (dedupe, không lệch 0.3);
> `(219,219)` → `218.70/219.00` (clamp biên); payload `[u_bogus, u]` → unit hợp lệ nhận
> đúng `(60.00,60.00)` thay vì bị đẩy sang ô thứ 2; queue 2 waypoint → active
> `(89.70,89.70)` + queued `(94.70,94.70)` cho từng unit. `tsc --noEmit` sạch.
>
> **Verify (browser thật, 1280×577):** chuột phải với 2 dân chọn → đúng 1 `MOVE_UNITS`
> `(162,95)`, server rải `161.70` / `162.30` cùng hàng; chọn 3 dân → khối 2×2 quanh
> `(163,95)` (`162.70/163.30` × `94.70/95.30`), 2 dân tới trước về `IDLE`, không có
> `ERROR_NOTIFICATION`, không lỗi console.

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

> **DONE.**
> - `resolveCursorMode(worldPoint)` mirror đúng thứ tự nhánh của `handleRightClickCommand`
>   (placement → attack → harvest → move) và dùng **chung** hit-test helper, nên con trỏ
>   không thể hứa một lệnh mà click sẽ không gửi.
> - Tách `findUnitAt` / `findBuildingAt` / `findResourceAt` khỏi `handleRightClickCommand`
>   (trước đây 3 vòng lặp hit-test nằm inline). `ownerFilter` nhận session id hoặc literal
>   `'enemy'`, so sánh gom vào `ownerMatches` — tránh hai chỗ tự cài lại điều kiện owner.
> - `CursorMode` = `default | attack | harvest | build-ok | build-blocked`, map sang CSS
>   `default` / `crosshair` / `copy` / `copy` / `not-allowed`.
> - Chỉ ghi CSS khi mode **thực sự đổi** (`appliedCursorCss` cache) — `handlePointerMove`
>   chạy mỗi lần rê chuột, set cursor vô điều kiện là ~60 lần/giây ghi vào DOM.
> - `refreshCursor()` gọi từ 3 nơi ngoài `handlePointerMove`: `notifySelectionChange`
>   (đổi selection dưới con trỏ đứng yên — box-select, hotkey; lưu ý hàm này
>   `return` sớm khi không có callback React nên phải refresh **trước** guard đó),
>   `cancelBuildingPlacement` (thoát placement khi chuột không di chuyển), và cuối
>   `handlePointerMove`. Vị trí chuột cuối lưu ở `lastPointerWorld`.
> - Bỏ qua refresh khi `isDragSelecting`: đang kéo hộp chọn mà đổi cursor theo unit
>   chạy qua bên dưới sẽ nhấp nháy vô nghĩa.
> - Harvest chỉ hiện khi **toàn bộ** selection là villager (`selectionIsAllVillagers`);
>   unit id đã despawn tính là "không phải villager" để giữ hướng an toàn.
>
> **Verify (browser thật, 1280×577, camera căn về TC):**
> 1. không chọn gì, rê lên TC của mình → `default`;
> 2. chọn 3 dân, rê lên cây → `copy`;
> 3. vẫn 3 dân, rê ra đất trống → `default`;
> 4. tạm đổi `mySessionId` để TC mình thành "địch", rê lên TC → `crosshair`;
> 5. khôi phục owner, rê lại TC → `default`;
> 6. selection có thêm 1 id không phải villager, rê lên cây → `default` (gate đúng);
> 7. `setBuildingMode('HOUSE')`: trên footprint TC → `not-allowed`, ô trống → `copy`,
>    `cancelBuildingPlacement()` khi chuột đứng yên → về `default`;
> 8. 6 lần rê liên tiếp trong cùng mode → **0** lần gọi `setDefaultCursor` thêm (cache đúng);
> 9. chuột đứng trên cây lúc chưa chọn (cursor `default`), chọn 2 dân **không di chuột**
>    → `copy` (refresh từ `notifySelectionChange`);
> 10. kéo hộp chọn qua cây → cursor giữ nguyên, không nhấp nháy.
>
> **Regression (refactor hit-test):** chuột phải cây → `HARVEST_RESOURCE`, đất trống →
> `MOVE_UNITS (63,189)`, TC của mình → `MOVE_UNITS` (không attack), TC khi owner bị đổi
> thành địch → `ATTACK_TARGET {targetType:'building'}`. 2 canvas, không overlay lỗi,
> không lỗi console/runtime trong suốt lượt test. `tsc --noEmit` sạch.

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

> **DONE.**
> - **04a** `CANCEL_TRAIN` + `CancelTrainPayload { buildingId }`. Server lấy unit ở
>   **đầu queue** (`trainingQueue[0]`) làm nguồn sự thật cho giá hoàn, nên client không
>   thể chọn hoàn cái gì. Hoàn 100%, `trainingProgressMs = 0` — giữ lại thời gian đã
>   trôi sẽ cho phép huỷ-rồi-xếp-lại để unit kế tiếp xong sớm hơn thời gian training.
> - **04b** `CANCEL_BUILDING` + `CancelBuildingPayload { buildingId }`. Chỉ nhận
>   `!isConstructed` (nhà đã xong bị từ chối: đây là "huỷ xây", không phải demolish).
>   Hoàn 100% khi `constructionProgress < 10`, còn lại 50%; mỗi tài nguyên `Math.floor`
>   riêng nên hoàn một phần không bao giờ làm tròn lên thành tài nguyên miễn phí.
> - `refundResources(player, cost, ratio)` là helper dùng chung cho cả hai nhánh —
>   trước đây mỗi chỗ tự cộng trừ 4 field một lần, thêm một nguồn hoàn tiền nữa là
>   đủ để lệch nhau.
> - Client: nút ✕ cạnh "Đang chờ: N" trong `EntityDetails` (04a); panel hiện
>   "Đang xây dựng N%" + nút "Huỷ công trình (Delete)" khi chọn móng của mình (04b,
>   dùng `SelectedEntityData.isConstructed/constructionProgress` mới thêm).
> - Phím `Delete` bind trong `WorldScene.bindCancelKey` → `cancelSelectedFoundation()`,
>   chỉ gửi khi không chọn unit nào, không ở placement mode, là móng **của mình**;
>   nhà đã xong thì phím im lặng thay vì gửi lệnh mà server chắc chắn từ chối.
> - Xoá building khỏi `state.buildings` là đủ: population chỉ đếm building đã xong,
>   và unit đang đi tới/đánh móng tự bắt nhánh "target gone" ở tick sau.
>
> **Bug phát hiện khi test phím (đã sửa):** Phaser **re-emit `keydown-<KEY>` mỗi frame**
> khi phím còn giữ xuống — đo được 18–40 lần emit cho một lần nhấn `Delete`
> (`event.repeat` không bắt được, vì event re-emit không phải DOM repeat). Hậu quả:
> một cú nhấn gửi hàng chục `CANCEL_BUILDING`, mỗi cái thừa bị server trả lỗi. Sửa bằng
> debounce theo `performance.now()` (`CANCEL_KEY_DEBOUNCE_MS = 250`), vì guard kiểu cũ
> (`event.repeat`) chỉ đúng với event do DOM phát.
>
> **Chưa phủ:** các binding cũ (`S`, `.`, `1..9`) cũng có thể bị nhân đôi bởi cùng cơ chế
> (đo `keydown-S` = 2 emit/lần nhấn); đều là lệnh idempotent nên chưa gây lỗi, ghi vào
> backlog để rà lại một lượt.
>
> **Verify (socket probe thật, 2 account):** train villager −50 food → `CANCEL_TRAIN`
> → queue 0, `progress = 0`, food về đúng 300 (hoàn 100%); queue 2 unit, chờ 2.47 s
> (progress 2469 ms) → huỷ unit đầu → unit còn lại spawn sau **5149 ms** kể từ lúc huỷ
> (đúng 5 s, không phải phần còn lại của unit bị huỷ). Lỗi: queue rỗng → "Nothing is
> being trained here", id lạ → "Building no longer exists", building người khác →
> "Not your building" và queue của chủ nhân **không đổi**. Móng mới (progress 5.1%):
> huỷ → hoàn đủ 50 wood. Móng ở 36.4%: huỷ → hoàn 25 wood (`floor(50 * 0.5)`). TC đã
> xong → "Cannot cancel a completed building", TC còn nguyên; móng của account khác →
> "Not your building", móng còn nguyên. Unit đang đi tới móng bị huỷ → móng mất, unit
> còn sống và về `IDLE`.
>
> **Verify (browser thật, 1280×577):** UI train villager → panel hiện "Đang chờ: 1",
> bấm ✕ → food 250 → 300, queue 0, dòng "Đang chờ" biến mất. Đặt House → panel hiện
> "Đang xây dựng 12% | 90/450 HP" + nút "Huỷ công trình (Delete)", bấm nút → building và
> sprite biến mất, wood 150 → 175 (hoàn 50% ở 12.6%), selection về null, panel về
> placeholder. Giữ `Delete` ~450 ms trên móng 6.3% → **đúng 1** `CANCEL_BUILDING`, wood
> 50 → 100 (hoàn đủ), móng + sprite biến mất. `Delete` trên TC đã xong → **0** message,
> TC nguyên vẹn. `tsc --noEmit` sạch cả client và server, shared đã rebuild.
>
> **Pitfall test:** móng tự hoàn thành sau 5 s (rate demo), nên mọi thao tác
> "đặt → chọn → huỷ" phải nằm trong một nhịp < 5 s; nếu không panel đã chuyển sang nhà
> hoàn chỉnh và không còn nút huỷ. CDP `Input.dispatchMouseEvent` trong phiên này treo
> liên tục (daemon timeout) sau vài chục lần dispatch — dùng `js()` set selection +
> `Input.dispatchKeyEvent` để test phím, còn click UI thật đã phủ ở bước trước.
>
> **Review pass (sửa sau khi đọc lại diff):**
> - `keydown-DELETE` **không bao giờ chạy trên macOS**: phím in chữ "delete" trên bàn phím
>   Mac là `BACKSPACE`, `DELETE` chỉ có khi bấm `fn + delete`. Bind cả hai (`handleKey`
>   dùng chung) — trước fix, phím quảng cáo trong help screen là phím chết trên chính
>   máy dev.
> - Đoạn kiểm tra "building tồn tại + đúng chủ" bị copy 3 lần (`CANCEL_TRAIN`,
>   `CANCEL_BUILDING`, `SET_RALLY_POINT`) → gom vào `requireOwnedBuilding(client, id)`
>   trả `BuildingState | null` và tự gửi lỗi. Thêm lệnh mới không thể quên một trong hai
>   bước kiểm tra.
> - `handleCancelTrain` tra blueprint **trước** `shift()`: bản cũ shift rồi mới tra, nên
>   một entry không đọc được sẽ biến mất mà không hoàn tiền và không báo gì.
> - `refundResources` clamp `ratio` ở 1 (`Math.min(1, ratio)`) — hoàn tiền không được phép
>   sinh tài nguyên, kể cả khi caller sau này truyền số lớn hơn 1.
>
> **Verify (sau review):** socket probe 2 account — train rồi huỷ: food 250 → 300, queue 0,
> progress 0; lỗi `Nothing is being trained here` / `Building no longer exists` /
> `Not your building`; móng 4.1% → hoàn đủ 50 wood, móng 30.7% → hoàn 25; `CANCEL_BUILDING`
> trên TC xong → `Cannot cancel a completed building`; móng của account khác vẫn còn sau khi
> bị từ chối (`Not your building`); `SET_RALLY_POINT` qua helper mới vẫn set được
> `rallyX/rallyY = 100` và vẫn từ chối House / building lạ / building người khác; train bình
> thường vẫn xong sau 5 s. Browser (1280×577): đặt House rồi chọn, nhấn **Backspace** →
> đúng 1 `CANCEL_BUILDING`, building + sprite biến mất, selection về null, wood 250 → 300
> (hoàn đủ ở 8.1%); nhấn phím **Delete** (keyCode 46) → 1 message; bắn 4 `keyDown` liên tiếp
> không `keyUp` (mô phỏng re-emit) → vẫn đúng 1 message (debounce giữ); Backspace trên TC đã
> hoàn chỉnh → 0 message, TC nguyên; Backspace khi đang chọn unit → 0 message. 2 canvas,
> không overlay lỗi, không lỗi console. `tsc --noEmit` sạch client + server.

---

## CMD-05 — Nông dân xây nhà (thay vì tự mọc)

> **ĐÃ CHỐT: LÀM.** Thay đổi gameplay có chủ đích, đưa kinh tế về đúng chuẩn AoE.

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
**Breaking:** thêm `builderUnitIds` vào schema → reset `apps/server/database/dev.db`.

**File:** shared types, `BuildingState.ts`, `UnitState.ts`, `WorldRoom.ts`, `WorldScene.ts`

> **DONE.**
> - Schema: `BuildingState.builderUnitIds` (danh sách dân đang xây). **Không phải nguồn sự thật**:
>   mỗi tick `sumBuildPower()` dựng lại từ state của chính unit, loại ai đã bị lệnh khác kéo đi,
>   đã chết, đã ra khỏi tầm — nhờ vậy không có đường nào để roster cũ "hồi sinh" một dân đã đi.
> - shared: `UnitActionState` thêm `'BUILDING'`; `UnitBlueprint.buildPower` (dân `1`, lính `0` —
>   dùng `buildPower` chứ không tái dùng `canHarvest`, để "hái được" và "xây được" là hai khái
>   niệm riêng); `BuildTargetPayload { unitIds, buildingId }`; `NetworkMessage.BUILD_TARGET`.
> - `PLACE_BUILDING`: móng bắt đầu `hp = 1` (trước là 20% maxHp). Móng gần như không phòng thủ,
>   đúng AoE; dựng xong mới nhảy lên `maxHp`.
> - `update()` nhánh construction: `progress += deltaTime * 100 * ΣbuildPower / buildTimeMs`.
>   Không có dân → `buildPower = 0` → progress đứng yên (trước đây tự xong sau 5 s bất kể gì).
>   Xong 100%: `isConstructed = true`, `hp = maxHp`, `clear()` roster.
> - `handleBuildTarget`: `requireOwnedBuilding` (dùng lại của CMD-04) → chặn nhà đã xong →
>   `collectOwnedUnits` (dùng lại CMD-02) → lọc `buildPower > 0`. Client chỉ gửi "dân nào, nhà nào";
>   quyền sở hữu và danh sách dân hợp lệ đều resolve ở server.
> - `getBuildApproachPoint`: chiếu unit lên vành ngoài footprint theo tia từ tâm nhà, nên mỗi dân
>   nhận một điểm riêng quanh móng thay vì cả tổ dồn một ô; unit đứng đúng tâm (móng có thể bị
>   đặt trùm lên dân) thì rải theo góc.
> - `distanceToFootprint` (khoảng cách tới **hình chữ nhật**, `0` khi ở trong) + `processUnitBuilding`:
>   vào tầm `BUILD_RANGE` thì ghi danh; móng bị huỷ/xong/đổi chủ thì `resumeQueuedWaypoint` →
>   `IDLE` (hoặc waypoint Shift còn lại).
> - Client: chuột phải **móng của mình** + selection toàn villager → `BUILD_TARGET`, ưu tiên ngay
>   sau nhánh đánh công trình địch; `findOwnFoundationAt()` tái dùng `findBuildingAt(..., mySessionId)`
>   nên con trỏ và lệnh không thể lệch nhau. `CursorMode 'construction'` → CSS `copy`.
>   Anim `BUILDING` dùng lại `villager_harvest` (không có sheet `villager_build`).
> - **Pitfall (bắt được khi test):** `BUILD_APPROACH_DISTANCE` để `1.0` thì điểm tiếp cận ở **góc
>   chéo** cách footprint `hypot(1,1) = 1.414`, cộng sai số dừng 0.15 → `1.56 > BUILD_RANGE 1.5`.
>   Dân đứng ở góc bị đá ra khỏi roster rồi không vào lại được. Đo được: 3 dân chỉ ra `22%/s`
>   thay vì `30%/s`. Hạ còn `0.5` → worst case `0.86`, đo lại đúng `30.13%/s`.
> - **Không cần reset `dev.db`:** `builderUnitIds` không nằm trong bảng SQLite nào (`DatabaseService`
>   chỉ map các cột cũ), nên móng đang dở sau restart vẫn được khôi phục và chờ dân. Khác với
>   ghi chú "breaking" ban đầu trong task.
> - **Chưa phủ:** chưa có nút "huỷ dân khỏi công trình" riêng (dùng `STOP`/lệnh mới); chưa test
>   hai account cùng xây một móng (không thể — móng phải cùng chủ).
>
> **Verify (socket probe thật, port 2571, 2 account):**
> - Đặt Barracks → `hp=1/1200`, `progress=0`, `crew=[]`; đứng yên 3 s → vẫn `0.00` (không còn tự xây).
> - 1 dân: `BUILDING`, roster `[u]`, đo `10.18 %/s` (đúng `100/10000ms`). Thêm 2 dân → roster 3,
>   đo `30.13 %/s`. `STOP` một dân → roster còn 2 **ngay tick sau**, progress vẫn chạy (~22%/s)
>   tới khi nhà xong thì roster về 0 và cả 3 `IDLE`, `hp=1200/1200`.
> - Xây bằng 3 dân từ đặt móng tới hoàn thành: **4.6 s** (3.33 s lý thuyết + ~1.3 s đi bộ).
> - Dân có `buildPower = 0` (SPEARMAN) → `Only villagers can build`, dân lính vẫn `IDLE`, móng
>   `p=0`. Payload trộn `[spearman, villager x3]` → **không** lỗi, chỉ 3 dân vào `BUILDING`.
> - Móng của account khác → `Not your building`, móng B vẫn `p=0`, dân A vẫn `IDLE`.
> - Nhà đã xong → `Building is already finished`, không đổi gì.
> - Huỷ móng khi dân đang đi tới (`CANCEL_BUILDING`) → dân về `IDLE`, `targetEntityId=''`.
> - Dân đang xây bị `MOVE_UNITS` → rời roster ngay, progress dừng lại (1.24 → 2.40 rồi đứng).
>
> **Verify (browser thật, 1264×569, account mới + observer socket):**
> - Đặt House: wood `300 → 250`, móng `hp=1/450`, `p=0`, `crew=[]`.
> - Quét chọn 3 dân, rê lên móng → cursor `copy` (`construction`).
> - Chuột phải móng → 3 dân `BUILDING` (`ent=b_2614`), roster tăng dần `[u1] → [u1,u3] → [u1,u3,u2]`
>   khi từng dân vào tầm; progress `0 → 7.4 → 20.1 → 32.5 → 42.3 → 54.8 → 72.4 → 91.4 → 100`
>   (2 dân ≈ `+12%/300ms`, 3 dân ≈ `+19%/300ms`), xong `hp=450/450`, cả 3 về `IDLE`.
> - `tsc --noEmit` sạch `packages/shared`, `apps/server`, `apps/client`.
>
> **Review pass (5 trục, sau khi hoàn thành):**
> - Tách domain construction ra `apps/server/src/rooms/construction.ts` (`distanceToFootprint`,
>   `isWithinBuildRange`, `getBuildApproachPoint`, `syncBuilders`) — `WorldRoom.ts` từ 1904 → 1817
>   dòng, logic xây không còn nằm lẫn trong room. `syncBuilders` thay tên `sumBuildPower` vì hàm
>   **có** prune roster chứ không chỉ cộng; prune được ghi rõ trong docstring như một phần contract.
> - Docstring `resolveCursorMode` (client) đã cũ (thiếu nhánh build-site) → cập nhật.
> - Probe lại toàn bộ trên code sau tách: 21/21 PASS — `hp=1/1200`, đứng yên 2 s vẫn `p=0`,
>   1 dân `10.00%/s` (đúng `100/10000ms` của Barracks), 3 dân `31.9%/s` và roster giữ nguyên 3
>   (không còn flicker), `MOVE_UNITS` một dân → crew 2 sau 200 ms, gán lại → crew 3 sau 100 ms,
>   xong thì `hp=1200/1200`, roster 0, cả 3 `IDLE`; `STOP` → crew 0, progress đứng; account khác
>   → `Not your building`, crew không đổi.
> - **Còn mở (cần chủ dự án quyết):** `WorldScene.ts` đang 2388 dòng — nên tách nhóm input/lệnh
>   chuột phải ra module riêng trước khi thêm CMD tiếp theo; `builderUnitIds` được sync về client
>   nhưng chưa HUD nào đọc (có thể chuyển thành roster server-private hoặc hiển thị số dân xây).
>   Client chỉ gửi `BUILD_TARGET` khi selection **toàn** villager (đúng spec), server thì chấp nhận
>   selection trộn và tự lọc — chưa mở ở client.

---

## CMD-06 — Auto-retarget cho dân khai thác

**Hiện trạng:** `processUnitHarvest` khi node cạn → `actionState = 'IDLE'` và đứng im.
Trong AoE, dân tự tìm node gần nhất cùng loại.

**Hướng sửa:** trong `processUnitHarvest`, khi `resource.remainingAmount <= 0` (hoặc
`resource` bị xoá), gọi `findNearestResource(unit, resourceType, radius = 10)`;
nếu tìm được → gán `targetEntityId` mới và giữ `actionState = 'HARVESTING'`;
nếu không → `IDLE`.

**File:** `apps/server/src/rooms/WorldRoom.ts`

> **DONE.**
> - `findNearestResource(unit, resourceType, radius)` + `retargetHarvest(unit)`; bán kính
>   `HARVEST_RETARGET_RADIUS = 10` tile. Cận trên nên là **tile**, không phải px: 10 tile
>   đủ bắc qua khoảng trống giữa hai cụm cây liền kề, mà không cho dân đi xuyên nửa bản đồ.
> - Gọi ở **hai** chỗ: node vừa cạn (`remainingAmount <= 0`, xoá node rồi retarget) và nhánh
>   `!resource` (node đã bị người khác dọn sạch trong lúc dân đang đi tới). Nhánh thứ hai
>   trước đây là `IDLE` im lặng.
> - Không có `ResourceType` trong payload lẫn `UnitState`, nên loại tài nguyên đang khai thác
>   lưu ở `harvestTypeByUnit` (transient `Map<unitId, type>`). Set lúc `handleHarvestResource`,
>   xoá khi `STOP_UNITS` / unit chết; **re-seed** từ node còn sống trong `processUnitHarvest`
>   để đơn hàng khôi phục sau restart vẫn retarget được. Không đụng schema, không cần reset DB.
> - Queue thắng retarget: `retargetHarvest` trả `false` khi `queueTargetX.length > 0`, nên
>   lệnh Shift đã xếp vẫn được `resumeQueuedWaypoint` chạy tiếp thay vì bị lệnh tự động đè.
> - Node `remainingAmount <= 0` bị loại khỏi tìm kiếm: có một tick node còn sót lại sau lần
>   thu cuối trước khi `delete`, chọn nó sẽ đẩy dân vào node rỗng.
>
> **Verify (socket probe thật):** dân `u_2557` hái `res_2554 food@125,78 amt=150` → cạn sau
> ~15.3 s → tự chuyển `res_2556` (d=1.41, cùng loại, gần nhất) → cạn sau ~15.2 s → chuyển
> `res_2555` (d=2.00) → cạn → `IDLE` vì node food gần nhất còn lại ở d=16.16 > 10 (đúng cận
> trên). Vị trí dân tiến dần 124.78,78.00 → 124.97,78.68 → 125.41,78.53 nên đây là đi bộ thật,
> không phải đổi id suông.
> Ba dân cùng đánh một node (`res_2577 amt=150`): node cạn ở +6.3 s, cả ba cùng retarget sang
> `res_2575`, không dân nào về `IDLE`, không `ERROR_NOTIFICATION`.
>
> **Verify (browser thật):** dân `u_2589` hái `res_2586@168,133` (amt 150→0), client hiển thị
> `targetEntityId` đổi sang `res_2588`, sprite dời 2234,9629 → 2182,9660 và vẫn `HARVESTING`
> với `visible=true`; node biến khỏi `resourceNodes`. Reload lại → 2 canvas, scene sống, 1282
> node, không overlay lỗi. `tsc --noEmit` sạch (server; client không đổi).
>
> **Chưa phủ:** nhánh `!resource` (node bị **người khác** dọn sạch khi dân đang đi tới) mới
> được review code + typecheck, chưa dựng được kịch bản thật: dân spawn cùng cụm nên luôn tới
> node trước khi nó cạn, và node chỉ cạn ở 10 máu/giây. Muốn test phải có hai account cùng đứng
> cạnh một node — để backlog.

---

## Thứ tự làm

`CMD-02` (nhỏ, độc lập) → `CMD-03` → `CMD-06` → `CMD-04` → `CMD-01` → `CMD-05`
(CMD-05 cần xác nhận user trước và nên làm sau cùng vì chạm gameplay).
