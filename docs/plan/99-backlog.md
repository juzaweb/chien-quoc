# Backlog — AoE features chưa nằm trong phase nào

Ghi lại để không quên. Chỉ bốc lên phase khi user quyết định.

## Điều khiển

- **Alt + chuột phải** — chưa có tác dụng: `MOVE_UNITS` hiện **luôn** xếp đội hình
  (`assignFormationTargets`), nên "giữ đội hình" là mặc định rồi. Cần chốt hướng:
  (a) Alt = đi thẳng tới đúng điểm click (bỏ giãn đội hình), hay (b) Alt = giữ đội hình
  đúng nghĩa AoE2, kéo theo việc bỏ xếp đội hình khỏi lệnh move thường.
- **Space** — nhảy tới sự kiện gần nhất (báo động, tấn công). Hiện client chỉ có banner
  notification tạm thời, chưa có event log để "sự kiện gần nhất" trỏ vào.
- **Xoay bản đồ** — AoE2 có `Ctrl+←/→`; hiện không có. Nặng: `isoMath` + terrain + hit-test
  đều giả định hướng cố định.
- **Double-click công trình** — chọn toàn bộ công trình cùng loại. Cần mở rộng model
  selection (hiện chỉ giữ một `selectedBuildingId`) và cả panel chi tiết.
- **Tab** — nhảy giữa các công trình đang chọn. Phụ thuộc mục double-click ở trên.

## Combat

- **Garrison** vào Town Center / Tower / Castle.
- **Attack ground** (công thành / pháo).
- **Damage type** (melee vs pierce vs cavalry bonus) — hiện chỉ có `attackPower` phẳng.
  Lưu ý: mô tả `SPEARMAN` trong `UNIT_BLUEPRINTS` đã hứa "excellent against cavalry"
  nhưng chưa có bonus nào; sửa một trong hai (thêm bonus, hoặc bỏ câu đó).
- **Nâng cấp (blacksmith, university)** — chưa có hệ thống upgrade.
- **Thế trận chỉ đổi được bằng `D`** — chưa có nút trong panel chi tiết, và chưa có
  chỉ báo trạng thái trên sprite (AoE2 vẽ shield nhỏ khi Stand Ground).
- **CMB-02/CMB-03 chưa có test tự động** — thanh máu ẩn khi đầy máu và vòng focus-fire
  là thuần render, chỉ kiểm được bằng mắt; muốn test thật cần harness hai account đứng
  cạnh nhau (một account đánh account kia).

## Kinh tế

- **Resource queued gathering** (Shift khi click resource).
- **Ruộng không lưu tiến độ** — `BuildingState.resourceAmount` chỉ nằm trong snapshot, chưa
  vào bảng `Building` của SQLite (thêm cột = migration Prisma). Hệ quả: restart giữa chừng
  thì ruộng đang gặt dở lại đầy 250 (`WorldRoom.initializeWorldPersistence` cố ý làm vậy để
  không có ruộng chết vĩnh viễn).
- **Gieo lại ruộng là tự động, không tắt được** — AoE2 có nút auto-reseed; hiện dân luôn
  trả 60 gỗ khi ruộng cạn nếu đủ tiền. Muốn tắt phải thêm cờ trên `PlayerState`.
- **Ruộng cạn chỉ đổi màu (tint)** — chưa có sprite `farm_fallow` riêng.

## UI / UX

- **Âm thanh phản hồi lệnh** ("Yes, sir!", tiếng kiếm, tiếng chặt cây).
- **Cursor asset AoE-style** (`attack.cur`, `harvest.cur`, ...).
- **Hotkey huấn luyện lính** — `Q/W/E/R/T` đã là menu xây dựng toàn cục, nên phím cho
  lính cần một lớp ngữ cảnh riêng (chọn nhà nào thì phím đổi nghĩa). Tooltip đã ghi cost
  và thời gian huấn luyện (UIX-02), chỉ còn thiếu phím.
- **Nhóm quân chứa cả công trình** — panel nhóm (UIX-03) hiện chỉ đếm unit; AoE2 cho
  gán TC/nhà vào nhóm. Cần mở rộng `controlGroups` sang id công trình + đổi cách recall
  (hiện `selection.clear()` rồi chỉ thêm unit).
- **Sắp xếp lại thứ tự nhóm** — panel chỉ hiển thị theo số 1..9, chưa kéo-thả được.

## Kỹ thuật

- **`WorldRoom.ts` đã 1035 dòng** — vượt ngưỡng soi ~1000. Phần restore/spawn (đọc `p.buildings`
  / `p.units` rồi dựng `Schema`) là khối liền mạch dễ tách nhất thành
  `rooms/worldBootstrap.ts`; đợt ECO-01 đã gỡ bớt phần trùng (nạp tài nguyên nguyên liệu
  sang `gatherables.ts`) nhưng file vẫn còn trên ngưỡng.
- **Client prediction** cho lệnh move (hiện chờ snapshot → cảm giác trễ ~50ms).
- **Snapshot diff / interpolation** mượt hơn — hiện `Phaser.Math.Linear(..., 0.25)` cố định,
  không phụ thuộc delta → tốc độ lerp thay đổi theo FPS.
- **Unit collision** — lính hiện chồng lên nhau hoàn toàn.
- **Fog of war** — chưa có khái niệm tầm nhìn.
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
  nên rà một lượt: helper dùng chung giờ đã có (`input/keyGuard.ts` → `guardKey`), mới chỉ
  dùng cho zoom `+`/`-` và bookmark `F2..F4`; các `bind*` còn lại vẫn tự giữ timestamp
  riêng (`lastCancelKeyAt`, `lastOrderKey`, `lastEscapeAt`) — gộp về `guardKey` khi có dịp
  sửa các binding đó, đừng thêm kiểu debounce thứ tư.
- **Path không lưu vào SQLite** — sau restart, unit đang `MOVING` được khôi phục với
  `targetX/targetY` cũ nhưng `pathX/pathY` rỗng nên đi thẳng. Chấp nhận được, nhưng nếu
  muốn đúng thì lưu thêm hoặc tính lại path lúc restore.
- ~~**Chưa có Mill / Lumber Camp / Mining Camp**~~ — đã xong: 3 blueprint 2x2 (100 gỗ,
  6 s, 600 HP), `dropOffs` lần lượt là `wood` / `food` / `gold,stone`, sprite PNG 256x220
  + hotkey `Y/U/I`. Kiểm chứng bằng 4 test trong `WorldRoom.test.ts` (chọn camp gần nhất,
  camp từ chối loại hàng không phụ trách).
- ~~**5 building gốc lệch style so với 3 camp**~~ — đã vẽ lại cả 5 bằng Canva theo đúng
  style của camp, giữ nguyên kích thước sheet (TC 576x440, barracks 400x320, farm 384x192,
  tower 160x360, house 256x220) nên `offsetY` không đổi. Nguồn matting + script dựng lại:
  `scripts/raw_downloads/m_*_mat.png` → `scripts/rebuild_buildings_canva.py`. Đã chỉnh
  `HP_BAR_Y` vì art mới không chạm mép trên sheet. Còn lệch nhẹ: bánh xe nước của `farm`
  vẽ nhỏ hơn tỉ lệ của `mill` — sửa được nếu thấy khó chịu trong game.
