import React, { useEffect, useRef } from 'react';
import { Room } from '@colyseus/sdk';
import { MAP_GRID_HEIGHT, MAP_GRID_WIDTH, screenToGrid, TILE_HEIGHT, TILE_WIDTH } from '@chien-quoc/shared';
import { WorldScene } from '../game/scenes/WorldScene.js';

interface MinimapProps {
  room: Room | null;
  sceneRef?: React.RefObject<WorldScene | null>;
  onPanToGrid: (gx: number, gy: number) => void;
}

export const Minimap: React.FC<MinimapProps> = ({ room, sceneRef, onPanToGrid }) => {
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

        // 1. Draw Resource Nodes
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
        room.state.buildings?.forEach((b: any) => {
          const isMe = b.ownerId === room.sessionId;
          ctx.fillStyle = isMe ? '#38bdf8' : '#ef4444';
          const bw = Math.max(3.5, b.sizeX * scaleX);
          const bh = Math.max(3.5, b.sizeY * scaleY);
          ctx.fillRect(b.gridX * scaleX, b.gridY * scaleY, bw, bh);
        });

        // 3. Draw Units
        room.state.units?.forEach((u: any) => {
          const isMe = u.ownerId === room.sessionId;
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

  const handleMinimapClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const gx = (clickX / canvas.width) * MAP_GRID_WIDTH;
    const gy = (clickY / canvas.height) * MAP_GRID_HEIGHT;

    onPanToGrid(gx, gy);
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
        className="rounded cursor-crosshair border border-amber-900/50 shadow-inner"
      />
    </div>
  );
};

