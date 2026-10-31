import React, { useEffect, useRef } from 'react';
import { Room } from '@colyseus/sdk';
import { MAP_GRID_HEIGHT, MAP_GRID_WIDTH, screenToGrid, TILE_HEIGHT, TILE_WIDTH } from '@chien-quoc/shared';
import { WorldScene } from '../game/scenes/WorldScene.js';

interface MinimapProps {
  room: Room | null;
  sceneRef?: React.RefObject<WorldScene | null>;
  onPanToGrid: (gx: number, gy: number) => void;
  /** CTL-07: right-click issues a move order to the grid cell under the cursor. */
  onCommandAtGrid: (gx: number, gy: number) => void;
}

export const Minimap: React.FC<MinimapProps> = ({ room, sceneRef, onPanToGrid, onCommandAtGrid }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;

    const render = () => {
      // AoE Terrain Grass Background (never pitch black)
      ctx.fillStyle = '#1e3f16';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Subtle diagonal terrain texture lines
      ctx.strokeStyle = 'rgba(46, 99, 36, 0.4)';
      ctx.lineWidth = 1;
      for (let i = -canvas.height; i < canvas.width; i += 16) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + canvas.height, canvas.height);
        ctx.stroke();
      }

      // Outer border
      ctx.strokeStyle = '#78350f';
      ctx.lineWidth = 2;
      ctx.strokeRect(0, 0, canvas.width, canvas.height);

      if (room && room.state) {
        const scaleX = canvas.width / MAP_GRID_WIDTH;
        const scaleY = canvas.height / MAP_GRID_HEIGHT;

        // 1. Draw AoE Dirt Road Network on Minimap
        ctx.strokeStyle = '#c3946a';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';

        // East-West Grand Highway
        ctx.beginPath();
        for (let gx = 0; gx < MAP_GRID_WIDTH; gx += 2) {
          const gy = 110 + 22 * Math.sin(gx * 0.045) + 9 * Math.cos(gx * 0.09) + 4 * Math.sin(gx * 0.16);
          if (gx === 0) ctx.moveTo(gx * scaleX, gy * scaleY);
          else ctx.lineTo(gx * scaleX, gy * scaleY);
        }
        ctx.stroke();

        // North-South Royal Silk Axis
        ctx.beginPath();
        for (let gy = 0; gy < MAP_GRID_HEIGHT; gy += 2) {
          const gx = 110 + 22 * Math.sin(gy * 0.045) + 9 * Math.cos(gy * 0.09) + 4 * Math.sin(gy * 0.16);
          if (gy === 0) ctx.moveTo(gx * scaleX, gy * scaleY);
          else ctx.lineTo(gx * scaleX, gy * scaleY);
        }
        ctx.stroke();

        // Diagonal Northwest - Southeast
        ctx.beginPath();
        for (let s = 10; s < 210; s += 2) {
          const meander = 12 * Math.sin(s * 0.07);
          const gx = s + meander / 2;
          const gy = s - meander / 2;
          if (s === 10) ctx.moveTo(gx * scaleX, gy * scaleY);
          else ctx.lineTo(gx * scaleX, gy * scaleY);
        }
        ctx.stroke();

        // Diagonal Northeast - Southwest
        ctx.beginPath();
        for (let s = 10; s < 210; s += 2) {
          const meander = 12 * Math.sin((s - (220 - s)) * 0.035);
          const gx = s;
          const gy = 220 - s + meander;
          if (s === 10) ctx.moveTo(gx * scaleX, gy * scaleY);
          else ctx.lineTo(gx * scaleX, gy * scaleY);
        }
        ctx.stroke();

        // 2. Draw Resource Nodes
        room.state.resourceNodes?.forEach((res: any) => {
          if (res.type === 'TREE') {
            ctx.fillStyle = '#166534';
            ctx.fillRect(res.gridX * scaleX, res.gridY * scaleY, 2, 2);
          } else if (res.type === 'GOLD_MINE') {
            ctx.fillStyle = '#facc15';
            ctx.fillRect(res.gridX * scaleX, res.gridY * scaleY, 2.5, 2.5);
          } else if (res.type === 'STONE_MINE') {
            ctx.fillStyle = '#cbd5e1';
            ctx.fillRect(res.gridX * scaleX, res.gridY * scaleY, 2.5, 2.5);
          } else {
            ctx.fillStyle = '#fb7185';
            ctx.fillRect(res.gridX * scaleX, res.gridY * scaleY, 2.5, 2.5);
          }
        });

        // 2. Draw Buildings
        const myOwnerId = sceneRef?.current?.myOwnerId ?? '';
        room.state.buildings?.forEach((b: any) => {
          const isMe = b.ownerId === myOwnerId;
          ctx.fillStyle = isMe ? '#38bdf8' : '#ef4444';
          const bw = Math.max(3.5, b.sizeX * scaleX);
          const bh = Math.max(3.5, b.sizeY * scaleY);
          ctx.fillRect(b.gridX * scaleX, b.gridY * scaleY, bw, bh);
        });

        // 3. Draw Units
        room.state.units?.forEach((u: any) => {
          const isMe = u.ownerId === myOwnerId;
          ctx.fillStyle = isMe ? '#4ade80' : '#f87171';
          ctx.fillRect(u.x * scaleX, u.y * scaleY, 2.5, 2.5);
        });

        // 4. Draw Camera Viewport Box (AoE white view rectangle)
        const scene = sceneRef?.current;
        if (scene && scene.cameras?.main) {
          const cam = scene.cameras.main;
          const centerGrid = screenToGrid(cam.scrollX + cam.width / 2, cam.scrollY + cam.height / 2);
          const viewWGrid = (cam.width / cam.zoom) / TILE_WIDTH;
          const viewHGrid = (cam.height / cam.zoom) / TILE_HEIGHT;

          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(
            (centerGrid.gridX - viewWGrid / 2) * scaleX,
            (centerGrid.gridY - viewHGrid / 2) * scaleY,
            Math.max(12, viewWGrid * scaleX),
            Math.max(8, viewHGrid * scaleY)
          );
        }
      }

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [room, sceneRef]);

  /**
   * Maps a minimap pointer event to fractional grid coordinates.
   *
   * Divides by the rendered rect, not the backing store: the canvas has a 1px
   * border, so `rect.width` (142) is the real pointer area while `canvas.width`
   * is 140. Using the backing store shifts every click ~1.4% toward the origin,
   * which at 220 cells is more than two grid cells of error.
   */
  const gridFromEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      gx: ((e.clientX - rect.left) / rect.width) * MAP_GRID_WIDTH,
      gy: ((e.clientY - rect.top) / rect.height) * MAP_GRID_HEIGHT
    };
  };

  const handleMinimapClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const grid = gridFromEvent(e);
    if (!grid) return;
    onPanToGrid(grid.gx, grid.gy);
  };

  /**
   * CTL-07: right-click orders the selection to that spot instead of panning.
   * The native context menu is suppressed so the order is the only effect.
   */
  const handleMinimapContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const grid = gridFromEvent(e);
    if (!grid) return;
    onCommandAtGrid(grid.gx, grid.gy);
  };

  return (
    <div className="aoe-panel p-2 rounded-lg pointer-events-auto flex flex-col items-center">
      <div className="font-medieval text-[10px] font-bold text-amber-400 mb-1 tracking-wider">
        BẢN ĐỒ THẾ GIỚI (220×220)
      </div>
      <canvas
        ref={canvasRef}
        width={140}
        height={140}
        onClick={handleMinimapClick}
        onContextMenu={handleMinimapContextMenu}
        className="rounded cursor-crosshair border border-amber-900/50 shadow-inner"
      />
    </div>
  );
};

