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
