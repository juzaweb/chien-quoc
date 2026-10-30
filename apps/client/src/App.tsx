import React, { useState, useEffect, useRef } from 'react';
import { Client, Room } from '@colyseus/sdk';
import { Callbacks } from '@colyseus/schema';
import * as Phaser from 'phaser';
import {
  BuildingType,
  INITIAL_PLAYER_RESOURCES,
  INITIAL_POPULATION_CAP,
  NetworkMessage,
  Resources,
  UnitType
} from '@chien-quoc/shared';
import { WorldScene, SelectedEntityData } from './game/scenes/WorldScene.js';
import { PhaserGame } from './game/PhaserGame.js';
import { HUD } from './components/HUD.js';
import { BuildMenu } from './components/BuildMenu.js';
import { EntityDetails } from './components/EntityDetails.js';
import { Minimap } from './components/Minimap.js';
import { Shield, Sparkles, Swords, AlertCircle } from 'lucide-react';

export const App: React.FC = () => {
  const [room, setRoom] = useState<Room | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [playerName, setPlayerName] = useState<string>(() => {
    return localStorage.getItem('cq_player_name') || '';
  });
  const [isJoined, setIsJoined] = useState<boolean>(false);

  // Player state
  const [playerColor, setPlayerColor] = useState<string>('#3b82f6');
  const [resources, setResources] = useState<Resources>(INITIAL_PLAYER_RESOURCES);
  const [population, setPopulation] = useState<number>(0);
  const [populationCap, setPopulationCap] = useState<number>(INITIAL_POPULATION_CAP);

  // Selection & Placement
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntityData | null>(null);
  const [activeBuildingType, setActiveBuildingType] = useState<BuildingType | null>(null);

  // Notifications
  const [notification, setNotification] = useState<string | null>(null);

  // References
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<WorldScene | null>(null);

  const showNotification = (msg: string) => {
    setNotification(msg);
    setTimeout(() => {
      setNotification((curr) => (curr === msg ? null : curr));
    }, 3500);
  };

  const handleJoinGame = async (nameToUse: string) => {
    try {
      const serverHost = window.location.hostname || 'localhost';
      const httpProtocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
      const serverUrl = `${httpProtocol}//${serverHost}:2567`;

      const client = new Client(serverUrl);
      const effectiveName = nameToUse || `Lord_${Math.floor(Math.random() * 900 + 100)}`;
      localStorage.setItem('cq_player_name', effectiveName);

      const joinedRoom = await client.joinOrCreate('world_room', {
        playerName: effectiveName
      });

      setRoom(joinedRoom);
      setIsConnected(true);
      setIsJoined(true);

      // Listen to room error messages
      joinedRoom.onMessage(NetworkMessage.ERROR_NOTIFICATION, (data: { message: string }) => {
        showNotification(data.message);
      });

      const cb = Callbacks.get(joinedRoom);

      // Listen to player state
      cb.onAdd('players', (p: any, sessionId: any) => {
        if (sessionId === joinedRoom.sessionId) {
          setPlayerName(p.name);
          setPlayerColor(p.color);
          setResources({ wood: p.wood, food: p.food, gold: p.gold, stone: p.stone });
          setPopulation(p.population);
          setPopulationCap(p.populationCap);

          cb.onChange(p, () => {
            setResources({ wood: p.wood, food: p.food, gold: p.gold, stone: p.stone });
            setPopulation(p.population);
            setPopulationCap(p.populationCap);
          });
        }
      });

      joinedRoom.onLeave((code) => {
        setIsConnected(false);
        showNotification('Mất kết nối với máy chủ.');
      });
    } catch (err: any) {
      console.error('Failed to connect to game server:', err);
      showNotification('Không thể kết nối đến máy chủ game. Hãy kiểm tra server đã chạy ở port 2567!');
    }
  };

  // Keyboard hotkeys
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isJoined) return;

      if (e.key === 'Escape') {
        if (activeBuildingType) {
          handleCancelBuilding();
        } else if (sceneRef.current) {
          sceneRef.current.clearSelection();
          setSelectedEntity(null);
        }
      } else if (e.key === 'q' || e.key === 'Q') {
        handleSelectBuilding('TOWN_CENTER');
      } else if (e.key === 'w' || e.key === 'W') {
        handleSelectBuilding('BARRACKS');
      } else if (e.key === 'e' || e.key === 'E') {
        handleSelectBuilding('HOUSE');
      } else if (e.key === 'r' || e.key === 'R') {
        handleSelectBuilding('FARM');
      } else if (e.key === 't' || e.key === 'T') {
        handleSelectBuilding('TOWER');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isJoined, activeBuildingType]);

  const handleSelectBuilding = (type: BuildingType) => {
    setActiveBuildingType(type);
    if (sceneRef.current) {
      sceneRef.current.setBuildingMode(type);
    }
  };

  const handleCancelBuilding = () => {
    setActiveBuildingType(null);
    if (sceneRef.current) {
      sceneRef.current.cancelBuildingPlacement();
    }
  };

  const handleTrainUnit = (buildingId: string, unitType: UnitType) => {
    if (room) {
      room.send(NetworkMessage.TRAIN_UNIT, {
        buildingId,
        unitType
      });
    }
  };

  const handlePanToGrid = (gx: number, gy: number) => {
    if (sceneRef.current) {
      sceneRef.current.panTo(gx, gy);
    }
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 font-sans">
      {/* Phaser Canvas */}
      <PhaserGame
        room={room}
        playerName={playerName}
        onSelectionChange={(entity) => setSelectedEntity(entity)}
        onPlacementCancelled={() => setActiveBuildingType(null)}
        gameRef={gameRef}
        sceneRef={sceneRef}
      />

      {/* Top HUD */}
      {isJoined && (
        <HUD
          playerName={playerName}
          playerColor={playerColor}
          wood={resources.wood}
          food={resources.food}
          gold={resources.gold}
          stone={resources.stone}
          population={population}
          populationCap={populationCap}
          isConnected={isConnected}
        />
      )}

      {/* Bottom RTS Dock Bar */}
      {isJoined && (
        <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between pointer-events-none select-none z-20 gap-3">
          {/* Left: Minimap */}
          <Minimap room={room} sceneRef={sceneRef} onPanToGrid={handlePanToGrid} />

          {/* Center: Selected Entity Info & Unit Training */}
          <EntityDetails
            entity={selectedEntity}
            playerResources={resources}
            onTrainUnit={handleTrainUnit}
          />

          {/* Right: Building Construction Dock */}
          <BuildMenu
            playerResources={resources}
            activeBuildingType={activeBuildingType}
            onSelectBuilding={handleSelectBuilding}
            onCancelBuilding={handleCancelBuilding}
          />
        </div>
      )}

      {/* In-game Notification Banner */}
      {notification && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-red-950/90 border border-red-500/80 text-red-200 px-4 py-2 rounded shadow-2xl backdrop-blur-md flex items-center gap-2 z-50 text-sm animate-bounce">
          <AlertCircle size={16} className="text-red-400" />
          <span>{notification}</span>
        </div>
      )}

      {/* Lobby Join Modal */}
      {!isJoined && (
        <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="aoe-panel w-full max-w-md p-6 rounded-xl flex flex-col items-center text-center shadow-2xl border-2 border-amber-600">
            <div className="p-3 rounded-full bg-amber-950/60 border border-amber-600/50 mb-3 text-amber-400">
              <Swords size={36} />
            </div>

            <h1 className="font-medieval text-2xl font-bold text-amber-300 tracking-wider mb-1">
              CHIẾN QUỐC MMO RTS
            </h1>
            <p className="text-xs text-slate-300 mb-6 max-w-xs">
              Trò chơi chiến thuật thời gian thực 2.5D Isometric. Xây dựng đế chế, khai khoáng và thống nhất thiên hạ!
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleJoinGame(playerName);
              }}
              className="w-full space-y-4"
            >
              <div className="text-left">
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Tên Lãnh Chúa / Đế Quốc:
                </label>
                <input
                  type="text"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder="Nhập tên của bạn (vd: Đại Việt)"
                  className="w-full px-3 py-2 rounded bg-slate-900 border border-amber-800 text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:border-amber-400"
                  autoFocus
                />
              </div>

              <button
                type="submit"
                className="w-full py-2.5 rounded bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-slate-950 font-bold tracking-wider text-sm uppercase shadow-lg transition-all border border-amber-400 cursor-pointer"
              >
                Gia Nhập Thế Giới
              </button>
            </form>

            <div className="mt-6 text-[11px] text-slate-400 space-y-1">
              <div>Phím <span className="text-amber-400 font-mono">WASD / Phím mũi tên</span> để di chuyển camera</div>
              <div>Cuộn <span className="text-amber-400 font-mono">Chuột</span> để phóng to/thu nhỏ</div>
              <div><span className="text-amber-400 font-mono">Chuột trái</span> chọn / quét quân, <span className="text-amber-400 font-mono">Chuột phải</span> điều quân & khai thác</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

