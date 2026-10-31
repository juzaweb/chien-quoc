import {
  MAP_GRID_HEIGHT,
  MAP_GRID_WIDTH,
  RoadSplinePoint,
  getAllRoadSplinePoints,
  gridToScreen,
  screenToGrid
} from '@chien-quoc/shared';
import type * as Phaser from 'phaser';

/**
 * Grass tiles and dirt-road stamps, drawn from pools.
 *
 * The map is 220x220 tiles and Phaser has no batching that makes hundreds of
 * thousands of images cheap, so the visible window is rendered from a fixed pool
 * that is repositioned (not recreated) whenever the camera moves far enough.
 */
export class TerrainLayer {
  private tilePool: Phaser.GameObjects.Image[] = [];
  private roadStampPool: Phaser.GameObjects.Image[] = [];
  private allRoadPoints: RoadSplinePoint[] = [];
  private lastViewportX = -999999;
  private lastViewportY = -999999;
  private lastViewportZoom = -1;

  constructor(private readonly scene: Phaser.Scene) {}

  /** Pre-allocates the pools and caches the road spline. Call once, from create(). */
  create() {
    this.tilePool = [];
    for (let i = 0; i < 6000; i++) {
      const tile = this.scene.add.image(0, 0, 'tile_grass');
      tile.setDepth(-100000);
      tile.setVisible(false);
      this.tilePool.push(tile);
    }

    this.allRoadPoints = getAllRoadSplinePoints();

    this.roadStampPool = [];
    for (let i = 0; i < 700; i++) {
      const stamp = this.scene.add.image(0, 0, 'road_stamp_1');
      stamp.setDepth(-99990);
      stamp.setVisible(false);
      this.roadStampPool.push(stamp);
    }
  }

  /** Repositions the pool for the current viewport. Cheap no-op when idle. */
  render() {
    const cam = this.scene.cameras.main;
    const view = cam.worldView;

    // Only recalculate when camera has moved more than 16px or zoom changed
    if (
      Math.abs(view.x - this.lastViewportX) < 16 &&
      Math.abs(view.y - this.lastViewportY) < 16 &&
      Math.abs(cam.zoom - this.lastViewportZoom) < 0.01
    ) {
      return;
    }

    this.lastViewportX = view.x;
    this.lastViewportY = view.y;
    this.lastViewportZoom = cam.zoom;

    // Expand margin to prevent edge pop-in during fast scrolling
    const margin = 160;
    const left = view.left - margin;
    const right = view.right + margin;
    const top = view.top - margin;
    const bottom = view.bottom + margin;

    const cTopLeft = screenToGrid(left, top);
    const cTopRight = screenToGrid(right, top);
    const cBottomLeft = screenToGrid(left, bottom);
    const cBottomRight = screenToGrid(right, bottom);

    const minGx = Math.max(0, Math.min(cTopLeft.gridX, cTopRight.gridX, cBottomLeft.gridX, cBottomRight.gridX) - 3);
    const maxGx = Math.min(MAP_GRID_WIDTH - 1, Math.max(cTopLeft.gridX, cTopRight.gridX, cBottomLeft.gridX, cBottomRight.gridX) + 3);
    const minGy = Math.max(0, Math.min(cTopLeft.gridY, cTopRight.gridY, cBottomLeft.gridY, cBottomRight.gridY) - 3);
    const maxGy = Math.min(MAP_GRID_HEIGHT - 1, Math.max(cTopLeft.gridY, cTopRight.gridY, cBottomLeft.gridY, cBottomRight.gridY) + 3);

    let poolIdx = 0;

    for (let gy = minGy; gy <= maxGy; gy++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        const screenPos = gridToScreen(gx, gy);

        if (
          screenPos.x >= left &&
          screenPos.x <= right &&
          screenPos.y >= top &&
          screenPos.y <= bottom
        ) {
          // Dynamically allocate from pool, expanding on demand if screen is large or zoomed out
          let tile = this.tilePool[poolIdx];
          if (!tile) {
            tile = this.scene.add.image(0, 0, 'tile_grass');
            tile.setDepth(-100000);
            this.tilePool.push(tile);
          }
          poolIdx++;

          // Natural AoE 2 meadow grass - 100% continuous, zero diamond stair-steps
          const variant = ((gx * 7 + gy * 13) % 3) + 1;
          const texKey = this.scene.textures.exists(`tile_grass_${variant}`)
            ? `tile_grass_${variant}`
            : 'tile_grass';
          if (tile.texture.key !== texKey) {
            tile.setTexture(texKey);
          }

          tile.setPosition(screenPos.x, screenPos.y);
          tile.setVisible(true);
          tile.clearTint();
        }
      }
    }

    // Hide remaining unused tiles
    const totalPooled = this.tilePool.length;
    while (poolIdx < totalPooled) {
      this.tilePool[poolIdx++].setVisible(false);
    }

    // Render continuous organic AoE dirt roads over seamless grass (zero diamond stair-steps)
    let roadPoolIdx = 0;
    const roadMargin = 140;
    const rLeft = left - roadMargin;
    const rRight = right + roadMargin;
    const rTop = top - roadMargin;
    const rBottom = bottom + roadMargin;

    const roadPointsLen = this.allRoadPoints.length;
    for (let i = 0; i < roadPointsLen; i++) {
      const rp = this.allRoadPoints[i];
      if (rp.x >= rLeft && rp.x <= rRight && rp.y >= rTop && rp.y <= rBottom) {
        let stamp = this.roadStampPool[roadPoolIdx];
        if (!stamp) {
          stamp = this.scene.add.image(0, 0, 'road_stamp');
          stamp.setDepth(-99990);
          this.roadStampPool.push(stamp);
        }
        roadPoolIdx++;

        const stampKey = `road_stamp_${rp.variant}`;
        if (stamp.texture.key !== stampKey && this.scene.textures.exists(stampKey)) {
          stamp.setTexture(stampKey);
        }
        stamp.setPosition(rp.x, rp.y);
        stamp.setVisible(true);
      }
    }

    // Hide remaining unused road stamps
    const totalRoadPooled = this.roadStampPool.length;
    while (roadPoolIdx < totalRoadPooled) {
      this.roadStampPool[roadPoolIdx++].setVisible(false);
    }
  }
}
