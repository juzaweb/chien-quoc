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
import { AuthScreen } from './components/AuthScreen.js';
import {
  AuthUser,
  clearStoredToken,
  fetchCurrentUser,
  getServerUrl,
  getStoredToken,
  isAuthRejection
} from './auth/api.js';
import { AlertCircle } from 'lucide-react';

export const App: React.FC = () => {
  const [room, setRoom] = useState<Room | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [isRestoringSession, setIsRestoringSession] = useState<boolean>(true);
  const [isJoining, setIsJoining] = useState<boolean>(false);
  const [isJoined, setIsJoined] = useState<boolean>(false);
  const playerName = authUser?.displayName ?? '';

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
  // Distinguishes an intentional logout from a dropped connection, so logging
  // out does not show a "lost connection" banner.
  const isLeavingRef = useRef<boolean>(false);

  const showNotification = (msg: string) => {
    setNotification(msg);
    setTimeout(() => {
      setNotification((curr) => (curr === msg ? null : curr));
    }, 3500);
  };

  // Restore a previous session on load so a refresh drops straight back in.
  useEffect(() => {
    let cancelled = false;

    fetchCurrentUser()
      .then((user) => {
        if (cancelled || !user) return;
        setAuthUser(user);
        // Session is still valid: go straight into the world.
        void connectToWorld();
      })
      .finally(() => {
        if (!cancelled) setIsRestoringSession(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectToWorld = async () => {
    const token = getStoredToken();
    if (!token) {
      setAuthUser(null);
      showNotification('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    setIsJoining(true);
    try {
      const client = new Client(getServerUrl());
      // Sent as `_authToken` on the room socket; `WorldRoom.onAuth` verifies it.
      client.auth.token = token;

      const joinedRoom = await client.joinOrCreate('world_room', {});

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

      joinedRoom.onLeave(() => {
        setIsConnected(false);
        setRoom(null);
        setIsJoined(false);
        if (isLeavingRef.current) {
          isLeavingRef.current = false;
          return;
        }
        showNotification('Mất kết nối với máy chủ.');
      });
    } catch (err: any) {
      console.error('Failed to connect to game server:', err);
      if (isAuthRejection(err)) {
        clearStoredToken();
        setAuthUser(null);
        showNotification('Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.');
      } else {
        showNotification(
          'Không thể kết nối đến máy chủ game. Hãy kiểm tra server đã chạy ở port 2567!'
        );
      }
    } finally {
      setIsJoining(false);
    }
  };

  const handleAuthenticated = (user: AuthUser) => {
    setAuthUser(user);
    void connectToWorld();
  };

  const handleLeaveGame = () => {
    // Only suppress the disconnect banner when a live room is being closed;
    // setting the flag with no room would swallow the next real disconnect.
    if (room) {
      isLeavingRef.current = true;
      room.leave();
    }
    clearStoredToken();
    setRoom(null);
    setIsJoined(false);
    setIsConnected(false);
    setSelectedEntity(null);
    setAuthUser(null);
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

  // CTL-07: right-click on the minimap is a move order, not a camera pan.
  const handleCommandAtGrid = (gx: number, gy: number) => {
    sceneRef.current?.commandMoveTo(gx, gy);
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 font-sans">
      {/* Phaser Canvas — mounted only once the player is in the world */}
      {isJoined && (
        <PhaserGame
          room={room}
          playerName={playerName}
          onSelectionChange={(entity) => setSelectedEntity(entity)}
          onPlacementCancelled={() => setActiveBuildingType(null)}
          gameRef={gameRef}
          sceneRef={sceneRef}
        />
      )}

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
          <Minimap room={room} sceneRef={sceneRef} onPanToGrid={handlePanToGrid} onCommandAtGrid={handleCommandAtGrid} />

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

      {/* Auth Gate: register / login before entering the world */}
      {!isJoined && !isRestoringSession && !isJoining && (
        <AuthScreen onAuthenticated={handleAuthenticated} />
      )}

      {/* Session restore / world connection spinner */}
      {(isRestoringSession || isJoining) && (
        <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-md flex items-center justify-center z-40 p-4">
          <div className="aoe-panel px-8 py-6 rounded-xl flex flex-col items-center gap-3 shadow-2xl border-2 border-amber-600">
            <div className="w-8 h-8 rounded-full border-2 border-amber-500 border-t-transparent animate-spin" />
            <span className="text-sm text-slate-300">
              {isRestoringSession ? 'Đang khôi phục phiên đăng nhập...' : 'Đang kết nối vào thế giới...'}
            </span>
          </div>
        </div>
      )}

      {/* Leave game */}
      {isJoined && (
        <button
          type="button"
          onClick={handleLeaveGame}
          className="absolute top-16 right-2 z-30 px-3 py-1.5 rounded bg-slate-900/90 border border-slate-700 text-[11px] text-slate-300 hover:border-amber-500 hover:text-amber-300 transition-colors cursor-pointer"
        >
          Đăng xuất
        </button>
      )}
    </div>
  );
};

