# Phase 4 — Kinh tế (Economy)

Phase 3 đóng ở `SIM-04`; tài liệu này là đợt tiếp theo, bốc từ `99-backlog.md` mục **Kinh tế**.
Không mở lại `04-simulation.md`, mỗi phase một file.

---

## ECO-01 — Farm là nguồn thức ăn, cạn thì gieo lại — DONE

**Vấn đề gốc:** `BUILDING_BLUEPRINTS.FARM` chỉ là một khối trang trí. Nó không có
`dropOffs`, không sinh tài nguyên, và cũng không cho dân đứng vào khai thác — xây farm
xong coi như mất 60 gỗ.

**Hành vi mới:**
- `BuildingBlueprint.gatheredResource` + `gatherCapacity`: FARM khai báo `'food'` / **250**.
  Farm **là nguồn**, không phải drop-off (quyết định #4 ở `README.md`).
- `BuildingState.resourceAmount` / `resourceCapacity` (replicated) giữ lượng thức ăn còn lại.
  Móng nhà = 0; xây xong mới đầy 250. (Schema thêm 2 field số → **không cần reset DB**:
  restore tự set lại, xem mục "chưa làm" bên dưới.)
- Lệnh khai thác dùng lại `HARVEST_RESOURCE` với `buildingId` thay vì `resourceNodeId`
  (không thêm message mới). Server kiểm chủ sở hữu / đã xong / còn thức ăn rồi mới nhận.
- Dân đi tới **vành ngoài footprint** (`approachPointOutsideFootprint`, 0.5 tile) và gặt
  từ mép ruộng (`distanceToFootprint ≤ 1.5`), không đứng giữa luống.
- Mang 10 thức ăn về TC như mọi loại khác; xong chuyến quay lại **đúng ruộng cũ**
  (`targetEntityType = 'farm'`).
- Ruộng cạn → **tự gieo lại** bằng đúng giá xây farm (60 gỗ), dân làm tiếp không cần lệnh
  mới. Không đủ gỗ thì dân trả nốt hàng đang mang rồi tìm ruộng/mỏ thức ăn khác trong
  bán kính 10, không có thì đứng. Ruộng bị phá giữa chừng cũng đi đúng đường đó (trả hàng
  nếu đang mang, rồi retarget) thay vì đứng im.
- Client: ruộng cạn bị **nhuộm nâu** (`setTint(0x9a7b52)`), panel chi tiết hiện
  "Trữ lượng còn lại: x / 250", con trỏ đổi sang `copy` khi trỏ vào ruộng của mình,
  chuột phải vào ruộng = lệnh khai thác khi **cả nhóm đều là dân** (`isAllVillagers`,
  cùng luật với lệnh xây) — nên con trỏ và cú click luôn nói cùng một chuyện.

**Đo (server + client thật, 1 account, CDP):** đặt farm cạnh TC (`wood 300 → 240`);
3 dân xây xong sau **10 s** → `resourceAmount 0 → 250`; chuột phải qua đúng
`CommandController.handleRightClick` phát ra
`HARVEST_RESOURCE { buildingId: 'b_3051' }`; 1 dân gặt **300 → 390 thức ăn trong 33 s**
(≈2.7 food/s gồm cả đi về), ruộng 250 → 160; 3 dân gặt cạn ruộng →
`wood 240 → 180`, `resourceAmount 0 → 250` (gieo lại tại chỗ), dân vẫn `HARVESTING`.

**Test tự động:** 9 test `farm gathering (ECO-01)` — gặt vào túi chứ không cộng thẳng,
trả hàng ở TC rồi quay lại ruộng, gieo lại khi cạn và đủ gỗ, cạn mà không đủ gỗ thì mang
hàng về rồi rời ruộng, **ruộng bị phá khi đang mang hàng thì trả hàng**, **ruộng bị phá
khi tay không thì về IDLE**, từ chối lệnh vào ruộng rỗng, từ chối ruộng của người khác,
farm xây xong mới đầy 250.

**Chưa làm (backlog):** `resourceAmount` không lưu vào SQLite nên sau restart ruộng đang
dùng dở lại đầy 250; gieo lại là tự động, chưa tắt được; chưa có sprite riêng cho ruộng
cạn (chỉ tint).

---

## ECO-02 — Chỉ báo dân nhàn rỗi trên HUD — DONE

`WorldScene` quét unit mỗi **250 ms**, đếm dân của mình đang `IDLE` (đang đi/đang gặt/
đang xây đều không tính), chỉ callback khi con số **đổi** → HUD không re-render 4 lần/giây.
HUD hiện số cạnh dân số; bấm vào = nhảy tới dân nhàn rỗi kế tiếp (đúng như phím `.`).

**Đo:** 3 dân spawn → HUD `3`; một dân nhận lệnh gặt → `2` sau ≤250 ms.

---

## ECO-03 — Hằng số nhà ở hết chết — DONE

`BUILDING_BLUEPRINTS.HOUSE.populationProvided` đổi từ số `5` viết tay sang
`POPULATION_PER_HOUSE`, nên chỗ hứa trong tooltip và chỗ cộng vào `populationCap` không
thể lệch nhau nữa.

---

## Chưa làm (còn ở `99-backlog.md`)

- **Lumber Camp / Mining Camp / Mill** — thiếu asset; `dropOffs` mới chỉ TOWN_CENTER được dùng.
- **Resource queued gathering** (Shift khi click resource).
