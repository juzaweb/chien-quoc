import React, { useEffect, useRef } from 'react';
import { Room } from '@colyseus/sdk';
import { MAP_GRID_HEIGHT, MAP_GRID_WIDTH } from '@chien-quoc/shared';

interface MinimapProps {
  room: Room | null;
  onPanToGrid: (gx: number, gy: number) => void;
}

export const Minimap: React.FC<MinimapProps> = ({ room, onPanToGrid }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;

    const render = () => {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Grid outline
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.strokeRect(0, 0, canvas.width, canvas.height);

      if (room && room.state) {
        const scaleX = canvas.width / MAP_GRID_WIDTH;
        const scaleY = canvas.height / MAP_GRID_HEIGHT;

        // Draw Resource Nodes
        room.state.resourceNodes?.forEach((res: any) => {
          if (res.type === 'TREE') ctx.fillStyle = '#166534';
          else if (res.type === 'GOLD_MINE') ctx.fillStyle = '#eab308';
          else if (res.type === 'STONE_MINE') ctx.fillStyle = '#94a3b8';
          else ctx.fillStyle = '#ef4444';

          ctx.fillRect(res.gridX * scaleX, res.gridY * scaleY, 2, 2);
        });

        // Draw Buildings
        room.state.buildings?.forEach((b: any) => {
          const isMe = b.ownerId === room.sessionId;
          ctx.fillStyle = isMe ? '#38bdf8' : '#ef4444';
          ctx.fillRect(
            b.gridX * scaleX,
            b.gridY * scaleY,
            Math.max(3, b.sizeX * scaleX),
            Math.max(3, b.sizeY * scaleY)
          );
        });

        // Draw Units
        room.state.units?.forEach((u: any) => {
          const isMe = u.ownerId === room.sessionId;
          ctx.fillStyle = isMe ? '#22c55e' : '#f87171';
          ctx.fillRect(u.x * scaleX, u.y * scaleY, 2.5, 2.5);
        });
      }

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [room]);

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
        BẢN ĐỒ THẾ GIỚI
      </div>
      <canvas
        ref={canvasRef}
        width={130}
        height={130}
        onClick={handleMinimapClick}
        className="rounded cursor-crosshair border border-amber-900/50 shadow-inner"
      />
    </div>
  );
};

