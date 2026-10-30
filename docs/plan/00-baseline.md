# Baseline — Hiện trạng thao tác trong game

Ghi lại hành vi **đang có** tại thời điểm lập plan, để các task sau so sánh.
Cập nhật file này mỗi khi một phase hoàn thành.

## File liên quan

| File | Vai trò |
| --- | --- |
| `apps/client/src/game/scenes/WorldScene.ts` | Toàn bộ input, selection, camera, render entity |
| `apps/client/src/App.tsx` | Hotkey cấp app (`Esc`, `Q/W/E/R/T`), gửi `TRAIN_UNIT` |
| `apps/client/src/components/Minimap.tsx` | Click trái để pan camera |
| `apps/client/src/components/EntityDetails.tsx` | Panel train unit, không có cancel |
| `apps/client/src/components/BuildMenu.tsx` | Nút chọn công trình |
| `packages/shared/src/types/index.ts` | `NetworkMessage`, payload types |
| `apps/server/src/rooms/WorldRoom.ts` | Authoritative tick, handlers |
| `apps/server/src/schema/UnitState.ts` | `actionState`, `targetEntityId`, `carrying*` (chưa dùng) |

## Thao tác hiện có

### Chuột

| Input | Hành vi hiện tại |
| --- | --- |
| Chuột trái click | `performSingleClickSelection` — chọn 1 unit → building → resource |
| Chuột trái kéo | `performBoxSelection`, chỉ chọn unit `ownerId === mySessionId` |
| Chuột phải | `handleRightClickCommand` — ưu tiên: unit địch → building địch → resource → ground |
| Chuột giữa kéo | *không có* |
| Wheel | zoom 0.4 – 2.2 |
| Chuột trái khi `buildingToPlace` | `commitBuildingPlacement` |
| Chuột phải khi `buildingToPlace` | `cancelBuildingPlacement` |

### Bàn phím

| Key | Hành vi |
| --- | --- |
| `WASD` / mũi tên | pan camera (`WorldScene.update`) — **WASD sẽ bị bỏ ở `BUG-01a`** |
| `Q` `W` `E` `R` `T` | chọn đặt công trình (`App.tsx`) |
| `Esc` | huỷ đặt nhà, hoặc clear selection |

### Command gửi lên server

| Message | Payload | Handler |
| --- | --- | --- |
| `PLACE_BUILDING` | `{ type, gridX, gridY }` | `handlePlaceBuilding` |
| `MOVE_UNITS` | `{ unitIds, targetGridX, targetGridY }` | `handleMoveUnits` |
| `TRAIN_UNIT` | `{ buildingId, unitType }` | `handleTrainUnit` |
| `ATTACK_TARGET` | `{ unitIds, targetEntityId, targetType }` | `handleAttackTarget` |
| `HARVEST_RESOURCE` | `{ unitIds, resourceNodeId }` | `handleHarvestResource` |

## Hành vi đã đúng chuẩn AoE (không sửa)

- Click chọn / kéo box chọn, ring xanh dưới chân, foundation viền khi chọn nhà.
- Chuột phải phân giải mục tiêu theo ngữ cảnh.
- Esc / chuột phải huỷ đặt công trình.
- Tắt context menu chuột phải.
- Minimap hiển thị tài nguyên, nhà, quân, khung camera.

## Khoảng trống so với AoE2

### Thiếu hoàn toàn
- Shift + chuột phải (queue waypoint), rally point, control group `Ctrl+1..9` / `1..9`.
- Shift-click / Ctrl-click / double-click trong selection.
- Stop (`S`), Attack-move, Patrol.
- Idle villager (`.`), idle military (`Ctrl+.`), về Town Center (`H`).
- Minimap chuột phải = ra lệnh di chuyển.
- Kéo camera bằng chuột giữa, edge scrolling.
- Formation, Alt giữ đội hình.
- Huỷ huấn luyện, huỷ móng nhà.
- Context cursor (kiếm / cuốc / khiên).
- Stance, garrison, deleter công trình.

### Có nhưng lệch chuẩn
- Nhà **tự xây** theo thời gian (5s), nông dân không tham gia.
- Dân khai thác cộng tài nguyên trực tiếp mỗi 1s, không mang về nhà.
- Lính đi thẳng A→B, không pathfinding, xuyên rừng/nhà.
- Offset di chuyển `(idx % 3) * 0.5` — dồn cục 3 cột, không phải đội hình.
- Toàn bộ animation walk/harvest dùng key `villager_*` cho mọi loại lính.
