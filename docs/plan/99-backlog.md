# Backlog — AoE features chưa nằm trong phase nào

Ghi lại để không quên. Chỉ bốc lên phase khi user quyết định.

## Điều khiển

- **Kéo camera bằng chuột giữa** (middle-drag pan). — *edge scroll đã chuyển sang `BUG-01b`*
- **Alt + chuột phải** — giữ đội hình khi di chuyển.
- **Bookmark camera** (`Ctrl+F2..F4` lưu, `F2..F4` gọi) — AoE2 hotkey mặc định.
- **Space** — nhảy tới sự kiện gần nhất (báo động, tấn công).
- **Xoay bản đồ** — AoE2 có `Ctrl+←/→`; hiện không có.
- **Zoom bằng phím** `+` / `-`.
- **Kéo chọn chỉ lính / chỉ dân** — AoE2 không có, nhưng nhiều RTS hiện đại có.
- **Double-click công trình** — chọn toàn bộ công trình cùng loại.
- **Tab** — nhảy giữa các công trình đang chọn.

## Combat

- **Stance**: Aggressive / Defensive / Stand Ground / No Attack.
- **Garrison** vào Town Center / Tower / Castle.
- **Attack ground** (công thành / pháo).
- **Focus fire indicator** — hiện mục tiêu đang bị đánh.
- **Health bar chỉ hiện khi bị thương** (AoE2 mặc định tắt, bật khi damaged).
- **Damage type** (melee vs pierce vs cavalry bonus) — hiện chỉ có `attackPower` phẳng.
- **Nâng cấp (blacksmith, university)** — chưa có hệ thống upgrade.

## Kinh tế

- **Lumber Camp / Mining Camp / Mill** — chưa có trong `BUILDING_BLUEPRINTS`.
- **Farm tự cạn và cần reseed** — hiện `FARM` không sinh food gì cả (chỉ tăng pop? không,
  `populationProvided: 0`).
- **Nhà ở (House) đúng chuẩn** — hiện `populationProvided: 5` nhưng `POPULATION_PER_HOUSE = 5`
  chỉ là hằng số chết, không dùng.
- **Idle villager indicator** ở góc HUD.
- **Resource queued gathering** (Shift khi click resource).

## UI / UX

- **Nút Cancel trong panel train** (đã tách ra CMD-04a nếu ưu tiên).
- **Tooltip AoE-style** với hotkey, cost, thời gian huấn luyện.
- **Âm thanh phản hồi lệnh** ("Yes, sir!", tiếng kiếm, tiếng chặt cây).
- **Cursor asset AoE-style** (`attack.cur`, `harvest.cur`, ...).
- **Bảng đội hình / nhóm quân** bên phải HUD.
- **Idle / total population tách riêng** trong HUD.

## Kỹ thuật

- **Client prediction** cho lệnh move (hiện chờ snapshot → cảm giác trễ ~50ms).
- **Snapshot diff / interpolation** mượt hơn — hiện `Phaser.Math.Linear(..., 0.25)` cố định,
  không phụ thuộc delta → tốc độ lerp thay đổi theo FPS.
- **Giới hạn 200 population** (`MAX_POPULATION_LIMIT` đã có trong shared, chưa enforce).
- **Unit collision** — lính hiện chồng lên nhau hoàn toàn.
- **Fog of war** — chưa có khái niệm tầm nhìn.
- **Timer rò rỉ cho unit đã chết** — `attackTimers`/`harvestTimers` không được xoá khi
  unit bị xoá khỏi `state.units` (chết hoặc rời), nên key `atk_<id>`/`harv_<id>` nằm lại
  vĩnh viễn. Dọn ở nhánh chết trong `processUnitCombat` hoặc ở `updatePlayerPopulation`.
- **Hai hệ keybinding song song** — `WorldScene` bind qua Phaser keyboard (`S`,
  `Ctrl+1..9`) còn `App.tsx` bind `window` keydown (`Q/W/E/R/T`, `Esc`). Hệ `window`
  không chặn modifier nên `Ctrl+W` vừa đóng tab vừa kích hoạt Barracks. Gộp về một chỗ
  và thêm guard modifier + `event.repeat`.
