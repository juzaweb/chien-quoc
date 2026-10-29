import * as Phaser from 'phaser';

/**
 * Procedurally generates 2D isometric pixel assets on game scene boot.
 * Guarantees zero missing asset errors (no 404s) and instant game readiness.
 */
export function generateProceduralTextures(scene: Phaser.Scene) {
  if (scene.textures.exists('tile_grass')) return;

  // 1. Isometric Grass Tile (128x64 - AoE 2 Definitive Edition standard)
  createCanvasTexture(scene, 'tile_grass', 128, 64, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(64, 1);
    ctx.lineTo(127, 32);
    ctx.lineTo(64, 63);
    ctx.lineTo(1, 32);
    ctx.closePath();

    ctx.fillStyle = '#417a26';
    ctx.fill();

    // Subtle grass blade variations
    ctx.strokeStyle = '#4d8f2d';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Light highlights on top edges
    ctx.beginPath();
    ctx.moveTo(64, 1);
    ctx.lineTo(127, 32);
    ctx.strokeStyle = 'rgba(134, 239, 172, 0.25)';
    ctx.stroke();

    // Subtle dark shadows on bottom edges
    ctx.beginPath();
    ctx.moveTo(127, 32);
    ctx.lineTo(64, 63);
    ctx.lineTo(1, 32);
    ctx.strokeStyle = 'rgba(20, 83, 45, 0.4)';
    ctx.stroke();
  });

  // 2. Isometric Grid Highlight Tile (128x64)
  createCanvasTexture(scene, 'tile_highlight', 128, 64, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(64, 2);
    ctx.lineTo(126, 32);
    ctx.lineTo(64, 62);
    ctx.lineTo(2, 32);
    ctx.closePath();

    ctx.fillStyle = 'rgba(250, 204, 21, 0.2)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#facc15';
    ctx.stroke();
  });

  // 3. Tree Resource (64x72)
  createCanvasTexture(scene, 'res_tree', 64, 72, (ctx) => {
    // Trunk
    ctx.fillStyle = '#5c2d11';
    ctx.fillRect(28, 48, 8, 18);

    // Tree shadow
    ctx.beginPath();
    ctx.ellipse(32, 66, 16, 6, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();

    // Leaf canopy layers (oak/pine style)
    const drawLeafLayer = (cx: number, cy: number, r: number, color: string) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };

    drawLeafLayer(32, 42, 18, '#14532d');
    drawLeafLayer(24, 36, 14, '#15803d');
    drawLeafLayer(40, 36, 14, '#166534');
    drawLeafLayer(32, 26, 16, '#15803d');
    drawLeafLayer(32, 18, 12, '#22c55e');
  });

  // 4. Gold Mine (48x40)
  createCanvasTexture(scene, 'res_gold', 48, 40, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(24, 32, 20, 8, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    // Golden boulders
    ctx.fillStyle = '#b45309';
    ctx.beginPath();
    ctx.arc(18, 24, 12, 0, Math.PI * 2);
    ctx.arc(30, 22, 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(20, 22, 10, 0, Math.PI * 2);
    ctx.arc(28, 20, 11, 0, Math.PI * 2);
    ctx.fill();

    // Sparkles
    ctx.fillStyle = '#fef08a';
    ctx.fillRect(16, 18, 4, 4);
    ctx.fillRect(28, 14, 5, 5);
    ctx.fillRect(24, 25, 3, 3);
  });

  // 5. Stone Mine (48x40)
  createCanvasTexture(scene, 'res_stone', 48, 40, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(24, 32, 20, 8, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    // Granite boulders
    ctx.fillStyle = '#334155';
    ctx.beginPath();
    ctx.arc(16, 24, 12, 0, Math.PI * 2);
    ctx.arc(32, 22, 13, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#64748b';
    ctx.beginPath();
    ctx.arc(18, 22, 10, 0, Math.PI * 2);
    ctx.arc(30, 20, 10, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(20, 18, 4, 4);
    ctx.fillRect(28, 16, 4, 4);
  });

  // 6. Berry Bush (40x36)
  createCanvasTexture(scene, 'res_berry', 40, 36, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(20, 28, 16, 6, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();

    ctx.fillStyle = '#166534';
    ctx.beginPath();
    ctx.arc(16, 20, 10, 0, Math.PI * 2);
    ctx.arc(24, 18, 11, 0, Math.PI * 2);
    ctx.fill();

    // Berries
    ctx.fillStyle = '#ef4444';
    [
      [14, 18], [22, 14], [26, 20], [18, 23], [20, 12]
    ].forEach(([bx, by]) => {
      ctx.beginPath();
      ctx.arc(bx, by, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  // 7. Town Center (192x130)
  createCanvasTexture(scene, 'b_town_center', 192, 130, (ctx) => {
    // Castle base shadow
    ctx.beginPath();
    ctx.ellipse(96, 115, 80, 15, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fill();

    // Main Stone Keep
    ctx.fillStyle = '#475569';
    ctx.fillRect(48, 55, 96, 55);

    // Stone brick lines
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    for (let y = 60; y < 110; y += 10) {
      ctx.beginPath();
      ctx.moveTo(48, y);
      ctx.lineTo(144, y);
      ctx.stroke();
    }

    // Great Tiled Roof
    ctx.beginPath();
    ctx.moveTo(96, 18);
    ctx.lineTo(152, 55);
    ctx.lineTo(40, 55);
    ctx.closePath();
    ctx.fillStyle = '#991b1b';
    ctx.fill();
    ctx.strokeStyle = '#7f1d1d';
    ctx.stroke();

    // Arched Gate
    ctx.beginPath();
    ctx.arc(96, 95, 14, Math.PI, 0);
    ctx.lineTo(110, 110);
    ctx.lineTo(82, 110);
    ctx.closePath();
    ctx.fillStyle = '#0f172a';
    ctx.fill();

    // Towers & Flags
    ctx.fillStyle = '#334155';
    ctx.fillRect(40, 40, 18, 50);
    ctx.fillRect(134, 40, 18, 50);

    // Tower battlements / roofs
    ctx.fillStyle = '#b91c1c';
    ctx.beginPath();
    ctx.moveTo(49, 26);
    ctx.lineTo(60, 40);
    ctx.lineTo(38, 40);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(143, 26);
    ctx.lineTo(154, 40);
    ctx.lineTo(132, 40);
    ctx.closePath();
    ctx.fill();

    // Golden Banner flag
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(96, 6);
    ctx.lineTo(114, 12);
    ctx.lineTo(96, 18);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#d97706';
    ctx.beginPath();
    ctx.moveTo(96, 4);
    ctx.lineTo(96, 20);
    ctx.stroke();
  });

  // 8. Barracks (128x96)
  createCanvasTexture(scene, 'b_barracks', 128, 96, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(64, 82, 54, 12, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    // Wooden-stone training hall
    ctx.fillStyle = '#334155';
    ctx.fillRect(32, 42, 64, 40);

    // Slanted Roof
    ctx.beginPath();
    ctx.moveTo(64, 18);
    ctx.lineTo(102, 42);
    ctx.lineTo(26, 42);
    ctx.closePath();
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.strokeStyle = '#475569';
    ctx.stroke();

    // Double Door
    ctx.fillStyle = '#78350f';
    ctx.fillRect(56, 58, 16, 24);

    // Crossed training swords icon on roof
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(56, 26);
    ctx.lineTo(72, 38);
    ctx.moveTo(72, 26);
    ctx.lineTo(56, 38);
    ctx.stroke();
  });

  // 9. House (64x64)
  createCanvasTexture(scene, 'b_house', 64, 64, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(32, 56, 24, 6, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();

    // Timber walls
    ctx.fillStyle = '#78350f';
    ctx.fillRect(16, 30, 32, 26);

    // Straw roof
    ctx.beginPath();
    ctx.moveTo(32, 10);
    ctx.lineTo(52, 30);
    ctx.lineTo(12, 30);
    ctx.closePath();
    ctx.fillStyle = '#d97706';
    ctx.fill();

    // Door and window
    ctx.fillStyle = '#451a03';
    ctx.fillRect(28, 42, 8, 14);
    ctx.fillStyle = '#fef08a';
    ctx.fillRect(18, 36, 6, 6);
  });

  // 10. Farm (128x64)
  createCanvasTexture(scene, 'b_farm', 128, 64, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(64, 2);
    ctx.lineTo(126, 32);
    ctx.lineTo(64, 62);
    ctx.lineTo(2, 32);
    ctx.closePath();
    ctx.fillStyle = '#713f12';
    ctx.fill();

    // Furrows of wheat crops
    ctx.strokeStyle = '#eab308';
    ctx.lineWidth = 2;
    for (let offset = -40; offset <= 40; offset += 10) {
      ctx.beginPath();
      ctx.moveTo(64 + offset, 16);
      ctx.lineTo(64 + offset + 20, 48);
      ctx.stroke();
    }

    // Fence border
    ctx.strokeStyle = '#a16207';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // 11. Watch Tower (64x100)
  createCanvasTexture(scene, 'b_tower', 64, 100, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(32, 92, 18, 6, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    // Tall stone column
    ctx.fillStyle = '#475569';
    ctx.fillRect(22, 32, 20, 60);

    // Archery windows
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(30, 45, 4, 10);
    ctx.fillRect(30, 65, 4, 10);

    // Parapet & Roof
    ctx.fillStyle = '#334155';
    ctx.fillRect(18, 24, 28, 10);

    ctx.beginPath();
    ctx.moveTo(32, 6);
    ctx.lineTo(48, 24);
    ctx.lineTo(16, 24);
    ctx.closePath();
    ctx.fillStyle = '#b91c1c';
    ctx.fill();
  });

  // 12. Villager Unit (24x32)
  createCanvasTexture(scene, 'unit_VILLAGER', 24, 32, (ctx) => {
    // Shadow
    ctx.beginPath();
    ctx.ellipse(12, 28, 8, 3, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    // Head
    ctx.fillStyle = '#fbcfe8';
    ctx.beginPath();
    ctx.arc(12, 8, 5, 0, Math.PI * 2);
    ctx.fill();

    // Hat
    ctx.fillStyle = '#92400e';
    ctx.fillRect(7, 4, 10, 3);

    // Tunic Body
    ctx.fillStyle = '#2563eb';
    ctx.fillRect(8, 13, 8, 11);

    // Tool (pickaxe/hammer)
    ctx.fillStyle = '#94a3b8';
    ctx.fillRect(18, 10, 2, 14);
    ctx.fillRect(16, 9, 6, 3);
  });

  // 13. Spearman Unit (26x36)
  createCanvasTexture(scene, 'unit_SPEARMAN', 26, 36, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(13, 32, 8, 3, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    // Head with Iron Helmet
    ctx.fillStyle = '#64748b';
    ctx.beginPath();
    ctx.arc(13, 8, 5, 0, Math.PI * 2);
    ctx.fill();

    // Armored Body
    ctx.fillStyle = '#1e3a8a';
    ctx.fillRect(9, 13, 8, 12);

    // Round Shield
    ctx.fillStyle = '#d97706';
    ctx.beginPath();
    ctx.arc(6, 18, 5, 0, Math.PI * 2);
    ctx.fill();

    // Long Spear
    ctx.strokeStyle = '#78350f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(19, 32);
    ctx.lineTo(19, 4);
    ctx.stroke();

    // Spear tip
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(19, 1);
    ctx.lineTo(21, 5);
    ctx.lineTo(17, 5);
    ctx.closePath();
    ctx.fill();
  });

  // 14. Archer Unit (24x34)
  createCanvasTexture(scene, 'unit_ARCHER', 24, 34, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(12, 30, 8, 3, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    // Green feathered cap
    ctx.fillStyle = '#15803d';
    ctx.beginPath();
    ctx.arc(12, 7, 5, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.fillStyle = '#166534';
    ctx.fillRect(8, 12, 8, 11);

    // Bow
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(18, 18, 8, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  });

  // 15. Cavalry Unit (40x40)
  createCanvasTexture(scene, 'unit_CAVALRY', 40, 40, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(20, 36, 16, 4, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    // Horse Body
    ctx.fillStyle = '#78350f';
    ctx.beginPath();
    ctx.ellipse(20, 26, 14, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    // Horse Head
    ctx.beginPath();
    ctx.arc(32, 18, 6, 0, Math.PI * 2);
    ctx.fill();

    // Rider
    ctx.fillStyle = '#1e3a8a';
    ctx.fillRect(16, 10, 8, 12);
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.arc(20, 8, 4, 0, Math.PI * 2);
    ctx.fill();

    // Lance
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(14, 22);
    ctx.lineTo(38, 6);
    ctx.stroke();
  });
}

function createCanvasTexture(
  scene: Phaser.Scene,
  key: string,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void
) {
  if (scene.textures.exists(key)) return;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    draw(ctx);
    scene.textures.addCanvas(key, canvas);
  }
}

