# Phase 1 — Selection & Hotkey

Điều kiện vào phase: Phase 0 xong (hit-test đã thống nhất, hotkey không xung đột).

---

## CTL-01 — Control groups (`Ctrl+1..9`, `1..9`)

**Mục tiêu:** gán và gọi lại nhóm quân như AoE2.

**Hành vi chuẩn:**
- `Ctrl + 1..9` → gán selection hiện tại vào nhóm N (rỗng hoá nhóm nếu không chọn gì).
- `1..9` → chọn nhóm N. Bấm 2 lần trong ~300ms → center camera vào nhóm.
- Nhóm chỉ chứa **unit của mình**; unit chết thì tự loại khỏi nhóm.

**Triển khai (thuần client, không đổi protocol):**
1. Trong `WorldScene`: `private controlGroups: Map<number, Set<string>> = new Map();`
2. `groupControlGroup(n)` / `recallControlGroup(n)`.
3. Bind trong `create()` qua `this.input.keyboard.on('keydown-ONE', ...)`, có kiểm tra
   `event.ctrlKey`. **Không** dùng `keydown` toàn cục của `App.tsx` để tránh double-handle.
4. Trong `bindRoomEvents` → `cb.onRemove('units')`, xoá id khỏi mọi nhóm.
5. `recallControlGroup` phải gọi `clearSelection()` rồi bật ring cho từng unit.

**Lưu ý:** `1..9` không được xung đột với `Q/W/E/R/T` (Phase 0 đã tách).

**File:** `apps/client/src/game/scenes/WorldScene.ts`
**Cách kiểm:** chọn 3 dân → `Ctrl+1` → click đất trống → bấm `1` → 3 dân được chọn lại.

---

## CTL-02 — Shift / Ctrl / double-click trong selection

**Mục tiêu:** thao tác chọn nâng cao.

| Input | Hành vi |
| --- | --- |
| `Shift` + click | thêm/bớt unit khỏi selection hiện tại |
| `Shift` + kéo box | **thêm** vào selection (không xoá cũ) |
| `Ctrl` + click unit | chọn **toàn bộ unit cùng loại đang thấy trên màn hình** |
| Double-click unit | chọn toàn bộ unit cùng loại đang thấy trên màn hình |
| Click đất trống (không shift) | clear selection (đã đúng) |

**Triển khai:**
1. `performSingleClickSelection(pointer, additive = false, selectSameType = false)`.
2. `performBoxSelection(..., additive = false)`.
3. Helper `selectSameTypeInViewport(type: string)` — lọc theo `cameras.main.worldView`.
4. Phát hiện double-click: lưu `lastClickTime` + `lastClickUnitId`, ngưỡng 350ms.
5. `pointer.event.shiftKey` / `.ctrlKey` để lấy modifier.

**Lưu ý:** `MAX_SELECTION` (bug BUG-06 đã thêm hằng) phải áp dụng ở đây.

**File:** `apps/client/src/game/scenes/WorldScene.ts` (`handlePointerDown`, `handlePointerUp`, `perform*Selection`)

> **DONE.**
> - Modifier được chụp tại **pointerdown** (`pendingSelectionMods`), vì pointerup có thể
>   mất `shiftKey`/`ctrlKey`; `handlePointerUp` chỉ đọc lại giá trị đã chụp rồi reset.
> - `performSingleClickSelection(pointer, additive, selectSameType)`:
>   `Shift` → `toggleUnitSelection` (thêm/bớt); `Ctrl`/`Cmd` hoặc double-click cùng unit
>   trong 350ms → `selectUnitsOfTypeInViewport(type)`; click thường → như cũ.
> - `performBoxSelection(..., additive)`: `Shift` giữ selection cũ và chỉ **thêm**.
> - `selectUnitsOfTypeInViewport` lọc theo `cameras.main.worldView` (chỉ unit đang thấy),
>   đúng AoE2; dùng chung `getUnitBodyBox()` nên khớp hit-test với click và box.
> - `MAX_SELECTION` chặn ở cả box, same-type và shift-click; chọn quân thì
>   `clearBuildingAndResourceSelection()` (selection hỗn hợp building + quân vô nghĩa với command).
> - `Shift` + click vào đất trống / công trình / tài nguyên **không** xoá selection đang có
>   (trước đây một cú shift-click hụt là mất cả đội).
> - **Caveat macOS:** Phaser tự đổi `Ctrl + left click` thành chuột phải (`Pointer#down`,
>   `OS.macOS && event.ctrlKey` → `buttons = 2`). Vì vậy `handlePointerDown` đọc
>   `pointer.event.button === 0 && ctrlKey` để nhận diện left-click thật, và
>   `create()` gọi `this.input.mouse?.disableContextMenu()` cho context menu của trình duyệt
>   không bật lên. `Cmd + click` cũng được nhận (alias trên macOS).
> - Thêm `src/vite-env.d.ts` + hook dev-only `window.__worldScene` trong `PhaserGame.tsx`
>   để test bằng browser đọc được selection mà HUD không hiển thị.
>
> **Verify (browser thật, 1280×577, 3 dân):** click đơn → 1; shift+click → 2; shift+click lại
> → 1; shift+box → cộng dồn; box thường → thay thế; double-click → toàn bộ dân trong khung;
> `Ctrl+click` → như double-click; dời camera để 1 dân ra ngoài viewport → double-click chỉ
> lấy 2 dân còn trong khung. Regression: `Ctrl+1`/`1` vẫn gán–gọi nhóm, chuột phải vẫn ra
> lệnh move (`IDLE → MOVING`). `tsc --noEmit` sạch cho cả client và server.

---

## CTL-03 — Lệnh Stop (phím `S`)

**Stop là gì (làm rõ):** nút Stop trong AoE2 **không phải** "dừng game" hay "pause".
Nó = **huỷ lệnh hiện tại của quân đang chọn và đứng yên tại chỗ**.

Ví dụ thực tế:
- Dân đang chặt cây → bấm `S` → dân đứng yên ngay giữa rừng (không quay về, không đi đâu).
- Lính đang đuổi địch → bấm `S` → lính đứng yên (dùng để rút lui có kiểm soát).
- Không có Stop thì cách duy nhất để ngừng là ra lệnh **move**, mà move thì **phải di chuyển**
  → không thể đứng yên tại chỗ.

Hoàn toàn độc lập với việc game online hay offline; đây là lệnh trong game.

**Protocol:**
```ts
// packages/shared/src/types/index.ts
export interface StopUnitsPayload { unitIds: string[]; }
// NetworkMessage.STOP_UNITS = 'STOP_UNITS'
```

**Server** — `handleStopUnits`: với mỗi unit thuộc client → `actionState = 'IDLE'`,
`targetEntityId = ''`, `targetEntityType = ''`, `targetX = unit.x`, `targetY = unit.y`,
xoá `attackTimers` / `harvestTimers` của unit đó, và (nếu đã có `CTL-05`) xoá luôn
`queueTargetX/Y` để Shift-queue cũng bị huỷ.

**Client** — bind `S` (không kèm Ctrl/Shift) trong `create()` → gửi `STOP_UNITS`
với `selectedUnitIds`.

**Điều kiện:** phím `S` chỉ trống sau khi `BUG-01a` đã bỏ WASD. Nếu làm CTL-03 trước BUG-01a,
tạm dùng `Delete` rồi đổi lại.

**File:** shared types, `WorldRoom.ts`, `WorldScene.ts`

> **DONE.**
> - Protocol: `StopUnitsPayload { unitIds: string[] }` + `NetworkMessage.STOP_UNITS`
>   trong shared; import/validate như mọi handler khác.
> - Server `handleStopUnits`: chặn quá `MAX_SELECTION`, chỉ nhận unit của chính
>   client; set `actionState = 'IDLE'`, xoá `targetEntityId`/`targetEntityType`,
>   `targetX/targetY = unit.x/unit.y` (nên nhánh movement trong `update()` không còn
>   gì để đi tiếp).
>   **Không xoá `attackTimers`/`harvestTimers`**: đó là state của unit, không phải
>   state của lệnh. Xoá `atk_<id>` sẽ reset cooldown vũ khí, cho phép spam
>   stop + attack để đánh mỗi tick thay vì mỗi cooldown; giữ `harv_<id>` thì tiến độ
>   hái dở được bảo toàn.
>   Không đụng `queueTargetX/Y` vì `CTL-05` chưa làm.
> - Client `bindStopKey` (`keydown-S`): bỏ qua `event.repeat` (giữ phím không spam
>   lệnh), bỏ qua khi có `Ctrl/Cmd/Shift/Alt` (Ctrl/Cmd+S
>   là Save của trình duyệt), bỏ qua khi đang ở chế độ đặt công trình
>   (`buildingToPlace`) hoặc không có quân nào được chọn; ngược lại `preventDefault()`
>   rồi gửi `STOP_UNITS` với `selectedUnitIds`. Mỗi unit được vẽ vòng vàng tại chỗ
>   để lệnh có phản hồi thị giác kể cả khi unit vốn đã đứng yên.
> - Hint trong `AuthScreen.tsx` thêm dòng `S` dừng quân.
>
> **Verify (browser thật, account test, 3 dân, zoom 1):**
> - Move → `MOVING`, S → cả 3 `IDLE`, `targetX === x` (dừng giữa đường, không chạy
>   nốt tới đích), toạ độ đóng băng qua 3s.
> - Harvest (berry bush, food 450 → 510 trong lúc đang hái) → S → `IDLE`,
>   `targetEntityId = ''`, food và `remainingAmount` của node đứng yên 3s.
> - Attack (gửi `ATTACK_TARGET` trực tiếp vào unit địch) → `ATTACKING` → S →
>   `IDLE`, `targetEntityId`/`targetEntityType` rỗng, `targetX === x`.
> - `Shift+S` và `Alt+S` **không** dừng quân (`MOVING` giữ nguyên), `S` thường mới
>   dừng. `Ctrl+S` cũng bị bỏ qua. Một lần nhấn = đúng 1 `STOP_UNITS` (đã đếm qua
>   `room.send`); `autoRepeat` không gửi gì.
> - Probe socket trực tiếp vào Colyseus: `MOVING` → `STOP_UNITS` → `IDLE`, toạ độ
>   đứng yên sau 900ms, `targetX === x`; payload 121 id bị từ chối qua
>   `ERROR_NOTIFICATION` nhưng room vẫn sống (cùng giới hạn `MAX_SELECTION`).
> - Regression: `W` vẫn mở Barracks, `S` khi đang đặt nhà không làm gì, `Esc` huỷ
>   đặt nhà, `Ctrl+1`/`1` gán–gọi nhóm vẫn đúng. `tsc --noEmit` sạch client + server.
>
> **Lưu ý test:** phím gửi bằng `KeyboardEvent` trên `window` phải chờ ≥1 frame —
> Phaser xử lý keyboard qua queue trong game loop, đọc state ngay sau `dispatchEvent`
> sẽ thấy giá trị cũ. Nếu sửa `WorldScene.ts` khi game đang chạy, HMR để lại listener
> keyboard của scene cũ và một lần nhấn sẽ gửi lệnh nhiều lần — reload trang trước khi
> đếm, đừng kết luận là bug khi chưa reload.

---

## CTL-04 — Idle cycle + về Town Center

**Mục tiêu:**
- `.` → nhảy tới nông dân idle kế tiếp, center camera.
- `Ctrl + .` → nhảy tới lính idle kế tiếp.
- `H` → center camera về Town Center của mình.

**Triển khai (thuần client):**
1. `private idleCursor: number = 0;` để xoay vòng, tránh nhảy mãi 1 unit.
2. Lọc `state.units` theo `ownerId === mySessionId && actionState === 'IDLE'`,
   chia 2 nhóm theo `type === 'VILLAGER'`.
3. `panTo(unit.x, unit.y)` + `clearSelection()` + chọn unit đó.
4. `H`: tìm `TOWN_CENTER` của mình (đã có logic tương tự trong `centerOnOwnBaseIfNeeded`).

**File:** `apps/client/src/game/scenes/WorldScene.ts`, bind trong `create()`

> **DONE.**
> - `cycleToIdleUnit('villager' | 'military')`: lọc `ownerId === mySessionId &&
>   actionState === 'IDLE'`, tách theo `type === 'VILLAGER'`; danh sách được
>   `sort()` để thứ tự vòng lặp ổn định bất kể thứ tự snapshot.
> - **Khác plan:** không dùng `idleCursor: number`. Dùng
>   `idleCycleAnchor: { villager, military }` lưu **id** của unit vừa nhảy tới.
>   Lý do: danh sách được tính lại mỗi lần nhấn (unit chuyển sang MOVING/HARVESTING,
>   roster đổi), nên một index cũ sẽ trỏ sang unit khác hoặc ra ngoài mảng; neo
>   theo id thì `indexOf` tự tìm lại đúng vị trí, không thấy thì bắt đầu từ đầu.
>   Hai category có neo riêng nên `.` và `Ctrl + .` không giành nhau con trỏ.
> - Không có unit nào thoả → **không làm gì**, giữ nguyên selection hiện tại
>   (không clear trắng cho vô nghĩa), không pan camera.
> - `focusUnit`: `clearSelection()` → `addUnitToSelection()` →
>   `notifySelectionChange()` → pan camera 350ms tới vị trí sprite (fallback
>   `gridToScreen(unit.x, unit.y)` nếu sprite chưa dựng) + vòng cyan phản hồi.
> - Bind `keydown-PERIOD` (`KeyCodes.PERIOD = 190`): bỏ qua `event.repeat`, bỏ qua
>   `Cmd/Shift/Alt` (Shift+. là `>`), bỏ qua khi `buildingToPlace`; `Ctrl` → military,
>   còn lại → villager.
> - `H` (`keydown-H`): tách `findOwnTownCenter()` ra khỏi `centerOnOwnBaseIfNeeded()`
>   để dùng chung, pan tới tâm TC (ô giữa công trình). Bỏ qua `Ctrl/Cmd/Alt`
>   (Ctrl+H là History, Cmd+H là Hide trên macOS).
> - Hint trong `AuthScreen.tsx` thêm dòng `.` / `Ctrl + .` / `H`.
>
> **Verify (browser thật, account test mới, 3 dân idle, zoom 1):**
> - `.` × 4 → lần lượt `u_2355 → u_2356 → u_2354 → u_2355` (wrap đúng vòng 3 unit,
>   không kẹt 1 unit); mỗi lần `cameras.main.midPoint` trùng khít sprite unit
>   (offset 0,0) và HUD hiện `VILLAGER (1)`.
> - `Ctrl + .` khi chưa có lính → không đổi selection, `idleCycleAnchor.military`
>   vẫn `null`. Sau khi đổi tạm 2 dân thành `SOLDIER`/`SPEARMAN` (chỉ trong state
>   client) thì `Ctrl + .` nhảy giữa đúng 2 unit đó, `.` vẫn đi vòng dân riêng.
> - `Shift + .`, `Cmd + .`, `Alt + .` và `event.repeat: true` → không đổi selection.
> - `H` → camera về đúng Town Center (lệch 32px theo trục dọc so với origin sprite,
>   đúng phần anchor của công trình 4×4); `Ctrl+H`, `Cmd+H` → camera không nhúc nhích.
> - Đang đặt nhà (`setBuildingMode('HOUSE')`) → `.` không chọn quân, `buildingToPlace`
>   vẫn là `HOUSE`.
> - `tsc --noEmit` client sạch; 1 canvas game + 1 minimap, không lỗi console.

---

## CTL-05 — Shift + chuột phải: queue lệnh

**Mục tiêu:** thao tác đặc trưng nhất của AoE — xếp nhiều waypoint.

**Thiết kế dữ liệu:** thêm vào `UnitState` (breaking, cần reset DB):
```ts
@type(['number']) queueTargetX = new ArraySchema<number>();
@type(['number']) queueTargetY = new ArraySchema<number>();
```

> Cân nhắc: có thể giữ queue **thuần client** (mảng `Map<unitId, {x,y}[]>`) và gửi từng
> bước khi unit tới đích. Cách này **không đổi schema**, nhưng phức tạp vì client phải
> phát hiện "đã tới đích" từ snapshot. Plan khuyến nghị **làm ở server**.

**Server:**
- `handleMoveUnits` nhận thêm field tuỳ chọn `queue?: boolean`.
- Nếu `queue` → push vào cuối mảng thay vì ghi đè `targetX/targetY`.
- Trong `update()`, khi `actionState` chuyển `MOVING → IDLE` và mảng queue còn phần tử →
  shift ra và set target mới.

**Client:**
- `handleRightClickCommand(pointer, queue: boolean)` truyền `pointer.event.shiftKey`.
- Vẽ **đường nối các waypoint** (graphics mờ) khi đang giữ Shift.

**File:** `packages/shared/src/types/index.ts`, `apps/server/src/schema/UnitState.ts`,
`apps/server/src/rooms/WorldRoom.ts`, `apps/client/src/game/scenes/WorldScene.ts`

**Cách kiểm:** chọn 1 dân → `Shift + chuột phải` vào 3 điểm → dân đi lần lượt qua 3 điểm.

> **DONE.**
> - Schema `UnitState`: `queueTargetX` / `queueTargetY` kiểu `@type(['number'])`
>   (`ArraySchema<number>`). Hai mảng song song vì Colyseus không replicate mảng
>   object nếu không có Schema riêng cho từng waypoint. Queue là state tạm, **không**
>   thêm cột DB — `savePlayerEmpire` vẫn ghi từng field cố định nên không cần reset DB.
> - Protocol: `MoveUnitsPayload.queue?: boolean` (**không** thêm message mới). Chỉ
>   đúng `true` mới xếp hàng; mọi giá trị khác coi như lệnh move thường, để payload
>   méo không thể lén ghi state.
> - Hằng số `MAX_QUEUED_WAYPOINTS = 12`: chặn spam shift-click làm queue phình vô hạn
>   (mỗi waypoint là state replicate suốt đời unit).
> - Server `handleMoveUnits`: nhánh `queue` push điểm vào cuối mảng (kèm offset đội
>   hình như move thường); nếu unit đang `IDLE` thì gọi `advanceQueuedWaypoint` ngay
>   — unit không có lệnh nào đang chạy thì không có gì để "xếp sau". Nhánh thường
>   `clear()` cả hai mảng rồi mới ghi `targetX/Y`.
> - `advanceQueuedWaypoint(unit)`: pop đầu mảng → set `targetX/Y`, `MOVING`, xoá
>   `targetEntity*`; trả `false` khi queue rỗng. Nếu độ dài hai mảng lệch nhau (chỉ
>   xảy ra khi snapshot hỏng) thì vứt cả queue thay vì áp nửa vời.
> - `resumeQueuedWaypoint(unit)`: dùng ở **mọi chỗ một lệnh kết thúc** — về đích
>   (`MOVING` → hết đường), mất target unit/building, target đổi chủ, unit/building
>   bị hạ, resource cạn hoặc biến mất. Trước khi có helper này, waypoint xếp trong
>   lúc đang harvest bị kẹt vĩnh viễn (không nhánh nào tiêu thụ). Hành vi thành:
>   "xếp lệnh di chuyển vào lúc đang hái → hái xong thì đi".
> - Queue bị **xoá** ở: lệnh move thường, `ATTACK_TARGET`, `HARVEST_RESOURCE`,
>   `STOP_UNITS` — mọi lệnh mới thay thế cả đường đi cũ. `STOP` mà để lại queue thì
>   unit sẽ tự chạy tiếp sau khi dừng, tức là stop vô hiệu.
> - Client: `handleRightClickCommand(pointer, queue)` nhận `pointer.event.shiftKey`
>   (truyền từ `handlePointerDown`, cùng chỗ với `ctrlLeftClick`). Chỉ nhánh
>   **ground** gửi `queue: true`; click vào unit/building/resource địch hay resource
>   vẫn ra lệnh thường (server không có queue cho attack/harvest, nửa vời còn tệ hơn).
> - `updateWaypointPreview()`: graphics depth `999995`, chỉ vẽ khi `shiftKey.isDown`
>   (đọc từ `Key` của Phaser, không phải event, nên hiện trước cả khi click), bỏ qua
>   khi đang đặt công trình hoặc không chọn quân. Đường: vị trí unit → target đang
>   chạy → từng waypoint trong queue → con trỏ; mỗi waypoint đã chốt có vòng tròn.
> - Hint trong `AuthScreen.tsx` thêm dòng `Shift + Chuột phải`.
>
> **Verify (probe socket + browser thật):**
> - Probe: 3 lệnh `queue:true` → unit đi đúng thứ tự `193,33 → 193,39 → 187,39`,
>   queue co dần `[2] → [1] → []`, hết đường thì `IDLE`.
> - Probe: move thường giữa chừng → queue về 0 và target đổi ngay; `STOP_UNITS` →
>   `IDLE`, queue rỗng, `targetX === x`; 20 lệnh queue liên tiếp → kẹp đúng 12;
>   queue vào unit của người khác → không đổi gì (`foreign unit untouched true`).
> - Probe: đang `HARVESTING` (node 200 gỗ) → xếp 1 waypoint → queue = 1 và unit vẫn
>   hái; node cạn sau ~23s → tự chuyển `MOVING` tới waypoint đó, queue = 0.
> - Browser: 3 lần `Shift + chuột phải` → đúng 3 `MOVE_UNITS` với `queue:true`,
>   `window.__worldScene.waypointGraphics.commandBuffer.length = 38` khi giữ Shift và
>   về 0 khi nhả Shift; unit đi qua cả 3 điểm rồi `IDLE`.
> - Browser: `Shift + chuột trái` vẫn cộng quân (`[u_2378] → [u_2378, u_2379]`),
>   queue nhiều unit một lần vẫn tách offset đội hình (`67 / 67.5`).
> - Browser regression: `Ctrl + click` chọn cùng loại ra đủ 3 dân, `S` → cả 3 `IDLE`
>   và `STOP_UNITS` đúng 1 lần; chuột phải thường giữa chừng → `q: []`, payload
>   không có field `queue`; đang đặt nhà → preview rỗng và chuột phải chỉ huỷ đặt
>   nhà, không gửi lệnh nào. `tsc --noEmit` sạch client + server, không lỗi console.
>
> **Lưu ý test:** toạ độ unit trên màn hình phải tính lại **sau** khi camera dừng —
> `cam.centerOn` chỉ có hiệu lực ở frame sau, và rê chuột sát mép màn hình sẽ kích
> hoạt edge scroll làm camera trôi, khiến click rơi ra ngoài canvas (unit "không
> phản hồi" giả). Đọc `cam.worldView` ngay trước khi dispatch chuột.

---

## CTL-06 — Rally point

**Mục tiêu:** đặt điểm tập kết cho công trình; lính mới ra tự đi tới đó.

**Schema mới trên `BuildingState`:**
```ts
@type('number') rallyX: number = -1;
@type('number') rallyY: number = -1;
```
(`-1` = chưa đặt)

**Protocol:** `NetworkMessage.SET_RALLY_POINT`, payload `{ buildingId, gridX, gridY }`.

**Server:**
- `handleSetRallyPoint`: kiểm tra building thuộc client, gán `rallyX/rallyY`.
- `spawnTrainedUnit`: sau khi set `actionState = 'IDLE'`, nếu building có rally hợp lệ →
  gán `targetX/targetY = rally` và `actionState = 'MOVING'`.

**Client — phân giải chuột phải mới:**
- Nếu **chỉ chọn 1 công trình của mình** (không chọn quân) và chuột phải → `SET_RALLY_POINT`.
- Vẽ cờ rally (graphics nhỏ) trên mặt đất + đường nối tới công trình.

**Thứ tự ưu tiên mới của `handleRightClickCommand`:**
1. Có quân đang chọn → như cũ (unit địch → building địch → resource → ground)
2. Không có quân, có building của mình đang chọn → `SET_RALLY_POINT`

**File:** shared types, `BuildingState.ts`, `WorldRoom.ts`, `WorldScene.ts`

> **DONE.**
> - `BuildingState` có `rallyX`/`rallyY` (`-1` = chưa đặt). Không cần reset DB: đây là state
>   runtime, `savePlayerEmpire` không ghi hai field này.
> - `handleSetRallyPoint`: từ chối building không tồn tại/không phải của mình (`Not your
>   building`) và toạ độ ngoài bản đồ hoặc không phải số (`Invalid rally point`). Chặn ở
>   server vì client gửi thẳng toạ độ từ con trỏ; một rally ngoài map sẽ nhốt mọi lính mới
>   trong `MOVING` vĩnh viễn.
> - `spawnTrainedUnit` đổi chữ ký sang `(building, unitType)` để tự đọc rally. Rally trùng
>   đúng ô spawn thì unit ra `IDLE` luôn — không đặt `MOVING` tới chính nó rồi bị tick sau
>   trả về `IDLE`, vì cờ và preview sẽ nháy một frame.
> - Client: `handleRightClickCommand` rẽ nhánh **trước** khi kiểm tra `selectedUnitIds`:
>   không chọn quân mà có `selectedBuildingId` → `SET_RALLY_POINT`. Click ngoài bản đồ bị
>   bỏ tại client để misclick không tốn round-trip.
> - `updateRallyMarkers()`: một lớp Graphics depth `999990`, vẽ cờ + đường nối cho mọi
>   building của mình có rally. Chỉ vẽ lại khi *signature* (danh sách `id:rallyX,rallyY`)
>   đổi — patch rally từ client khác vẫn được bắt mà không phải theo dõi từng patch, và
>   frame không đổi thì không tốn lệnh vẽ nào (đo được 0 lệnh `clear()` trong 1 giây khi
>   đứng yên).
> - Hint trong `AuthScreen.tsx` thêm dòng chọn công trình + chuột phải.
>
> **Verify (probe socket + browser thật):**
> - Probe: building người khác → `Not your building`, rally giữ `(-1,-1)`; `99999/-5`,
>   `'abc'/null` → `Invalid rally point`; building không tồn tại → `Building no longer
>   exists`; rally vẫn `(-1,-1)` trong mọi trường hợp.
> - Probe: rally = ô spawn → lính mới `IDLE` tại `(71,176)`, target trùng vị trí. Rally
>   `(77,178)` → lính mới `MOVING` tại `(73.14,176.71)`, sau 4s `IDLE` ở `(76.91,177.97)`.
> - Browser: chọn Town Center rồi chuột phải → đúng 1 `SET_RALLY_POINT` với
>   `{buildingId:'b_2426', gridX:183, gridY:41}`, state nhận `rally (183,41)`, lớp cờ có
>   138 lệnh vẽ.
> - Browser: bỏ chọn hết rồi chuột phải → **không** gửi gì. Chọn 1 dân rồi chuột phải →
>   `MOVE_UNITS` (không phải rally), rally không đổi, dân sang `MOVING`.
> - `tsc --noEmit` sạch client + server, 1 canvas game.
>
> **Lưu ý test:** toạ độ click phải nằm trên canvas **và** không bị panel HUD che —
> `elementFromPoint` trả về `CANVAS` mới chắc. Chuột phải qua CDP cần cả `button:'right'`
> và `buttons:2`; thiếu `buttons` thì `mousedown` vẫn tới nhưng Phaser không thấy
> `rightButtonDown()`. Camera có thể bị `centerOn`/edge scroll làm trôi giữa các lần đọc,
> nên tính toạ độ màn hình ngay trước khi dispatch.
>
> **Review (5 trục) — đã sửa:**
> - **Required (correctness):** rally đặt được lên *mọi* công trình, kể cả House/Farm không
>   train được gì → cờ hiện ra nhưng lính mới không bao giờ đi. Thêm `canTrainUnitsAt()` vào
>   shared, dùng ở cả hai phía: server trả `This building cannot train units`, client bỏ lệnh
>   trước khi gửi (không tốn round-trip, không có toast vô nghĩa).
> - **Required (architecture):** hai chỗ kiểm quyền sở hữu building mới viết lại
>   `ownerId !== mySessionId`, trong khi scene đã có `isOwnBuilding()` (có fallback theo
>   `myPlayerName`, cần cho trường hợp reconnect). Đổi sang dùng helper.
> - **Required (performance):** `updateRallyMarkers()` dựng lại toàn bộ lớp cờ mỗi frame
>   trong `update()` (~5 lệnh vẽ × số công trình × 60fps). Thêm chữ ký và bỏ qua frame
>   không đổi.
> - **Nit:** prop `onCommandAtGrid` của `Minimap` khai báo optional nhưng chỉ có đúng một
>   caller luôn truyền → bỏ `?` và xoá nhánh `if (!onCommandAtGrid)`.
> - **FYI (→ backlog):** preview Shift không phản ánh `MAX_QUEUED_WAYPOINTS`; quá 12 điểm
>   server lặng lẽ bỏ nhưng client vẫn vẽ đường tới con trỏ.

---

## CTL-07 — Minimap: chuột phải ra lệnh di chuyển

**Mục tiêu:** chuột trái = pan camera (đã có), **chuột phải = ra lệnh move** cho quân đang chọn.

**Triển khai:**
1. `Minimap.tsx` thêm prop `onCommandAtGrid?: (gx, gy) => void`.
2. `onContextMenu` (preventDefault) → gọi `onCommandAtGrid`.
3. `App.tsx` → `sceneRef.current.commandMoveTo(gx, gy)`.
4. `WorldScene.commandMoveTo` gửi `MOVE_UNITS` giống hệt `handleRightClickCommand` nhánh 4.

**Lưu ý:** toạ độ minimap đang dùng `(clickX / canvas.width) * MAP_GRID_WIDTH`, tức là
bỏ qua tỉ lệ `220/220` — đúng vì minimap vuông. Giữ nguyên.

**File:** `Minimap.tsx`, `App.tsx`, `WorldScene.ts`

> **DONE.**
> - `Minimap.tsx`: prop `onCommandAtGrid?`, `onContextMenu` → `preventDefault()` rồi mới gọi
>   callback (không chặn menu thì Chrome mở menu ngay trên minimap và nuốt luôn lệnh).
>   Phần tính toạ độ được tách ra `gridFromEvent` để click trái và chuột phải không lệch nhau.
> - **Sửa luôn lỗi chia sai mẫu số:** code cũ chia cho `canvas.width` (140 = backing store)
>   trong khi `getBoundingClientRect().width` là 142 vì canvas có `border: 1px`. Mỗi click bị
>   kéo ~1.4% về gốc, ở thang 220 ô là hơn 2 ô. Đổi sang chia `rect.width`/`rect.height`; sai
>   số còn lại chỉ do trình duyệt làm tròn `clientX/clientY` về số nguyên (≤1.6 ô ở góc xa).
> - `App.tsx`: `handleCommandAtGrid` → `sceneRef.current?.commandMoveTo(gx, gy)`.
> - `WorldScene.commandMoveTo(gridX, gridY)` (public): gửi `MOVE_UNITS` đúng như nhánh ground
>   của `handleRightClickCommand` (cùng payload, không có `queue` vì minimap không có Shift).
>   Bỏ qua khi `buildingToPlace` (đang đặt nhà) và khi `selectedUnitIds` rỗng — chỉ chọn công
>   trình rồi chuột phải minimap **không** được biến thành lệnh move, và cũng không phải lệnh
>   rally (rally chỉ đặt trong thế giới).
> - Toạ độ được `Math.round` + kẹp `0..MAP_GRID-1` ở client dù server cũng kẹp: click sát mép
>   minimap rơi đúng `220` sẽ ra preview ngoài bản đồ nếu chỉ dựa vào server.
> - Hint `AuthScreen.tsx` thêm dòng chuột phải minimap.
> - **Review:** prop `onCommandAtGrid` bỏ optional (chỉ một caller, luôn truyền) nên nhánh
>   `if (!onCommandAtGrid) return;` biến mất; sau thay đổi chạy lại kiểm tra thật: chọn 1 dân
>   rồi chuột phải minimap → 1 `MOVE_UNITS {targetGridX:107, targetGridY:93}`, unit `MOVING`
>   khớp.
>
> **Verify (browser thật, account test mới, 3 dân + Town Center, zoom 1):**
> - Chọn 1 dân, chuột phải minimap ô (150,120) → đúng 1 `MOVE_UNITS`
>   `{unitIds:[u_…], targetGridX:149, targetGridY:119}`, unit sang `MOVING` với `targetX/Y` khớp.
> - Box-select 2 dân rồi chuột phải minimap → 1 `MOVE_UNITS` chứa **cả 2** id, server áp offset
>   đội hình (`107` / `107.5`).
> - Không chọn gì → không gửi gì. Chỉ chọn Town Center → không gửi gì, `rally` vẫn `-1,-1`
>   (không bị biến thành lệnh rally). Đang ở chế độ đặt nhà (`setBuildingMode('HOUSE')`) →
>   không gửi gì.
> - Click trái minimap: camera `midPoint` đổi, **0** message → pan vẫn nguyên.
> - Góc dưới-phải minimap → `217,218` (trong map). Gọi thẳng `commandMoveTo(220, 250)` →
>   `219,219`; `commandMoveTo(-4, -9)` → `0,0`.
> - `preventDefault` xác nhận qua `event.defaultPrevented === true`. 2 canvas (game + minimap),
>   HUD `ONLINE`, không overlay lỗi Vite. `tsc --noEmit` sạch client + server.
>
> **Lưu ý test:** `new MouseEvent('contextmenu', …)` phải có `button: 2` **và** `buttons: 2`, và
> phải dispatch trên chính canvas minimap (`querySelectorAll('canvas')[1]`) — thiếu
> `cancelable: true` thì `preventDefault` không có tác dụng nên không kiểm được menu. Toạ độ
> `clientX/clientY` bị làm tròn về số nguyên, nên đừng assert đúng tuyệt đối ô đích; assert
> lệch ≤2 ô hoặc gọi thẳng `commandMoveTo` để kiểm kẹp biên.
