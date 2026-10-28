import React, { useEffect, useRef } from 'react';
import * as Phaser from 'phaser';
import { Room } from '@colyseus/sdk';
import { WorldScene, SelectedEntityData } from './scenes/WorldScene.js';
import { BuildingType } from '@chien-quoc/shared';

interface PhaserGameProps {
  room: Room | null;
  onSelectionChange: (entity: SelectedEntityData | null) => void;
  onPlacementCancelled: () => void;
  gameRef: React.MutableRefObject<Phaser.Game | null>;
  sceneRef: React.MutableRefObject<WorldScene | null>;
}

export const PhaserGame: React.FC<PhaserGameProps> = ({
  room,
  onSelectionChange,
  onPlacementCancelled,
  gameRef,
  sceneRef
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: '#0a0f1d',
      pixelArt: true,
      roundPixels: true,
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH
      },
      scene: [WorldScene]
    };

    const game = new Phaser.Game(config);
    gameRef.current = game;

    game.events.once('ready', () => {
      const scene = game.scene.getScene('WorldScene') as WorldScene;
      sceneRef.current = scene;
      scene.onSelectionChange = onSelectionChange;
      scene.onPlacementCancelled = onPlacementCancelled;

      if (room) {
        scene.setRoom(room);
      }
    });

    const handleResize = () => {
      if (gameRef.current) {
        gameRef.current.scale.resize(window.innerWidth, window.innerHeight);
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      sceneRef.current = null;
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }
    };
  }, []);

  // Update room when room is connected or changed
  useEffect(() => {
    if (sceneRef.current && room) {
      sceneRef.current.setRoom(room);
    }
  }, [room]);

  return <div ref={containerRef} className="absolute inset-0 w-full h-full overflow-hidden" />;
};

