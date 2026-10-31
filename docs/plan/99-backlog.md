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
- **Click vào HUD khi đang arm `A`/`P` không huỷ lệnh** — pointerdown không tới canvas nên lệnh
  vẫn armed; người chơi phải click ra đất rồi chuột phải/Esc. Nên cho panel HUD gọi
  `cancelPendingOrder()` để khớp cảm giác "click ra ngoài là huỷ".

## Kỹ thuật

- **Client prediction** cho lệnh move (hiện chờ snapshot → cảm giác trễ ~50ms).
- **Snapshot diff / interpolation** mượt hơn — hiện `Phaser.Math.Linear(..., 0.25)` cố định,
  không phụ thuộc delta → tốc độ lerp thay đổi theo FPS.
- **Giới hạn 200 population** (`MAX_POPULATION_LIMIT` đã có trong shared, chưa enforce).
- **Unit collision** — lính hiện chồng lên nhau hoàn toàn.
- **Fog of war** — chưa có khái niệm tầm nhìn.
- **Hai hệ keybinding song song** — `WorldScene` bind qua Phaser keyboard (`S`,
  `Ctrl+1..9`) còn `App.tsx` bind `window` keydown (`Q/W/E/R/T`, `Esc`). Hệ `window`
  không chặn modifier nên `Ctrl+W` vừa đóng tab vừa kích hoạt Barracks. Gộp về một chỗ
  và thêm guard modifier + `event.repeat`.
- **Preview Shift không phản ánh `MAX_QUEUED_WAYPOINTS`** — quá 12 điểm thì server lặng lẽ
  bỏ nhưng client vẫn vẽ đường tới con trỏ, người chơi tưởng đã nhận. Cần hoặc gửi
  `ERROR_NOTIFICATION` (chỉ khi thực sự chạm trần), hoặc đổi màu/đứt nét phần preview.
- **Nhánh `!resource` của CMD-06 chưa có test thật** — dân đang đi tới node mà node bị
  **người khác** dọn sạch thì phải retarget (đã code), nhưng chưa dựng được kịch bản: dân
  spawn cùng cụm nên luôn tới node trước khi nó cạn (150 máu / 10 máu mỗi giây). Cần hai
  account cùng đứng cạnh một node mới tái hiện được.
- **Phaser re-emit `keydown-<KEY>` khi phím còn giữ** — đo được 18–40 emit cho một lần
  nhấn `Delete`, 2 emit cho `keydown-S`; `event.repeat` không bắt được vì event re-emit
  không phải DOM repeat. `bindCancelKey` đã tự debounce (`CANCEL_KEY_DEBOUNCE_MS`), nhưng
  các binding cũ (`S`, `.`, `Ctrl/1..9`, `H`) chưa có guard tương đương. Hiện chưa gây lỗi
  vì các lệnh đó idempotent (`STOP_UNITS`/select lại cùng unit thì kết quả như cũ), nhưng
  nên rà một lượt: thêm một helper dùng chung (timestamp debounce hoặc
  `Phaser.Input.Keyboard.JustDown` trên `Key` object) thay vì mỗi `bind*` tự xử lý.
- **Pathfinding không tự tính lại khi có vật cản mới** — path chỉ tính lúc ra lệnh; đặt nhà
  lên đường đi của một unit đang trên đường thì nó đi xuyên qua nhà đó cho tới đích. Cần
  kiểm tra ô kế tiếp mỗi tick và xin path mới khi bị chặn (hoặc dùng hàng đợi path có sẵn).
- **Path không lưu vào SQLite** — sau restart, unit đang `MOVING` được khôi phục với
  `targetX/targetY` cũ nhưng `pathX/pathY` rỗng nên đi thẳng. Chấp nhận được, nhưng nếu
  muốn đúng thì lưu thêm hoặc tính lại path lúc restore.
- **Chưa hiện tài nguyên đang mang trên client** — SIM-02 đã có `carryingAmount` /
  `carryingResourceType` trong schema nhưng HUD/đầu dân chưa vẽ icon; người chơi không biết
  dân đang mang gì cho tới khi tài nguyên nhảy số ở TC.
- **Chưa có Mill / Lumber Camp / Mining Camp** — `BuildingBlueprint.dropOffs` đã hỗ trợ
  nhưng hiện chỉ TOWN_CENTER nhận tài nguyên, nên mọi chuyến hàng đều đi về TC và kinh tế
  chậm hơn AoE ở các mỏ xa.
