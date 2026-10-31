import { Room, Client, ServerError, ErrorCode } from '@colyseus/core';
import { DatabaseService } from '../services/DatabaseService.js';
import { AuthService } from '../services/AuthService.js';
import {
  BUILDING_BLUEPRINTS,
  BuildingBlueprint,
  BuildingType,
  INITIAL_POPULATION_CAP,
  MAP_GRID_HEIGHT,
  MAP_GRID_WIDTH,
  MAX_QUEUED_WAYPOINTS,
  MAX_SELECTION,
  NetworkMessage,
  POPULATION_PER_HOUSE,
  PlaceBuildingPayload,
  Resources,
  MoveUnitsPayload,
  TrainUnitPayload,
  AttackTargetPayload,
  AttackMovePayload,
  BuildTargetPayload,
  HarvestResourcePayload,
  StopUnitsPayload,
  SetRallyPointPayload,
  CancelTrainPayload,
  CancelBuildingPayload,
  SERVER_TICK_RATE,
  UNIT_BLUEPRINTS,
  UnitBlueprint,
  UnitType,
  canTrainUnitsAt,
  isDirtRoadTile
} from '@chien-quoc/shared';
import { WorldState } from '../schema/WorldState.js';
import { PlayerState } from '../schema/PlayerState.js';
import { BuildingState } from '../schema/BuildingState.js';
import { UnitState } from '../schema/UnitState.js';
import { ResourceNodeState } from '../schema/ResourceNodeState.js';
import { getBuildApproachPoint, isWithinBuildRange, syncBuilders } from './construction.js';

const PLAYER_COLORS = [
  '#3b82f6', // Blue
  '#ef4444', // Red
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#8b5cf6', // Purple
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#84cc16'  // Lime
];

/** Distance between formation cells, in tiles. Wide enough to keep rings apart. */
const FORMATION_SPACING = 0.6;

/**
 * Search radius, in tiles, for the next resource node of the same type once a
 * villager empties its current one (CMD-06). Ten tiles covers the gap between
 * neighbouring forest patches without letting a villager cross the whole map.
 */
const HARVEST_RETARGET_RADIUS = 10;

/**
 * CMD-04b refund rule. AoE returns everything for a foundation that was only
 * just placed and less once work has gone into it. These two constants keep the
 * agreed numbers in one place instead of inline in the handler.
 */
const CANCEL_BUILDING_FULL_REFUND_BELOW = 10; // construction progress %
const CANCEL_BUILDING_PARTIAL_REFUND_RATIO = 0.5;

/**
 * Lays a squad out as a centred square block around its destination.
 *
 * A previous 3-column layout turned a 60-unit army into a 3x20 column, which
 * reads as a queue rather than a formation. The block is
 * `ceil(sqrt(count))` cells wide, so the group's centre of mass lands on the
 * clicked tile regardless of squad size.
 *
 * @param count Number of units to place. `0` yields an empty list.
 * @param spacing Cell distance in tiles.
 */
function computeFormationOffsets(count: number, spacing: number): Array<{ x: number; y: number }> {
  if (count <= 0) return [];

  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / cols);
  const offsets: Array<{ x: number; y: number }> = [];

  for (let idx = 0; idx < count; idx++) {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    offsets.push({
      x: (col - (cols - 1) / 2) * spacing,
      y: (row - (rows - 1) / 2) * spacing
    });
  }

  return offsets;
}

/**
 * Identity resolved by {@link WorldRoom.onAuth} and carried to `onJoin` as
 * `client.auth`. It holds the verified account, never client-supplied options.
 */
interface WorldRoomAuth {
  userId: string;
  username: string;
  displayName: string;
}

export class WorldRoom extends Room<{ state: WorldState }> {
  private nextEntityId: number = 1000;
  private attackTimers: Map<string, number> = new Map();
  private harvestTimers: Map<string, number> = new Map();
  /**
   * Last resource type a villager was ordered to gather, keyed by unit id.
   * Transient on purpose: after a server restart the map is empty, so
   * `processUnitHarvest` re-seeds it from the live node instead of dying.
   */
  private harvestTypeByUnit: Map<string, string> = new Map();
  private readyPromise: Promise<void> | null = null;
  private worldRestoreError: Error | null = null;

  onCreate(options: any) {
    this.setState(new WorldState());

    // Keep a reference so onJoin can wait until the persisted world is restored.
    // Without this, a client could join while state.buildings is still empty and
    // spawn a duplicate randomly-positioned base.
    this.readyPromise = this.initializeWorldPersistence();

    // Setup network message listeners
    this.onMessage(NetworkMessage.PLACE_BUILDING, (client, message: PlaceBuildingPayload) => {
      this.handlePlaceBuilding(client, message);
    });

    this.onMessage(NetworkMessage.MOVE_UNITS, (client, message: MoveUnitsPayload) => {
      this.handleMoveUnits(client, message);
    });

    this.onMessage(NetworkMessage.TRAIN_UNIT, (client, message: TrainUnitPayload) => {
      this.handleTrainUnit(client, message);
    });

    this.onMessage(NetworkMessage.ATTACK_TARGET, (client, message: AttackTargetPayload) => {
      this.handleAttackTarget(client, message);
    });

    this.onMessage(NetworkMessage.ATTACK_MOVE, (client, message: AttackMovePayload) => {
      this.handleAttackMove(client, message, 'ATTACK_MOVE');
    });

    this.onMessage(NetworkMessage.PATROL, (client, message: AttackMovePayload) => {
      this.handleAttackMove(client, message, 'PATROL');
    });

    this.onMessage(NetworkMessage.BUILD_TARGET, (client, message: BuildTargetPayload) => {
      this.handleBuildTarget(client, message);
    });

    this.onMessage(NetworkMessage.HARVEST_RESOURCE, (client, message: HarvestResourcePayload) => {
      this.handleHarvestResource(client, message);
    });

    this.onMessage(NetworkMessage.STOP_UNITS, (client, message: StopUnitsPayload) => {
      this.handleStopUnits(client, message);
    });

    this.onMessage(NetworkMessage.SET_RALLY_POINT, (client, message: SetRallyPointPayload) => {
      this.handleSetRallyPoint(client, message);
    });

    this.onMessage(NetworkMessage.CANCEL_TRAIN, (client, message: CancelTrainPayload) => {
      this.handleCancelTrain(client, message);
    });

    this.onMessage(NetworkMessage.CANCEL_BUILDING, (client, message: CancelBuildingPayload) => {
      this.handleCancelBuilding(client, message);
    });

    // Run authoritative tick loop
    this.setSimulationInterval((deltaTime) => this.update(deltaTime), 1000 / SERVER_TICK_RATE);

    // Auto-save world state to SQLite every 30 seconds
    this.clock.setInterval(() => {
      DatabaseService.saveFullWorldState(this.state);
    }, 30000);

    console.log('[WorldRoom] Room created with SQLite persistence.');
  }

  private async initializeWorldPersistence() {
    try {
      // 1. Load resources from SQLite (regenerate if old snapshot is from small 60x60 map)
      const savedResources = await DatabaseService.loadResources();
      let maxStoredCoord = 0;
      for (const res of savedResources || []) {
        maxStoredCoord = Math.max(maxStoredCoord, res.gridX, res.gridY);
      }
      const isOutdatedMap = !savedResources || savedResources.length < 500 || maxStoredCoord < 100;

      if (!isOutdatedMap && savedResources.length > 0) {
        for (const res of savedResources) {
          const node = new ResourceNodeState();
          node.id = res.id;
          node.type = res.type;
          node.resourceType = res.resourceType;
          node.gridX = res.gridX;
          node.gridY = res.gridY;
          node.remainingAmount = res.remainingAmount;
          node.maxAmount = res.maxAmount;
          this.state.resourceNodes.set(res.id, node);
        }
        console.log(`📦 [WorldRoom] Restored ${savedResources.length} resource nodes from database.`);
      } else {
        console.log(`🗺️ [WorldRoom] Regenerating fresh resource clusters across entire 220x220 world map...`);
        await DatabaseService.clearAllResources();
        this.generateWorldResources();
        const resArray: ResourceNodeState[] = [];
        this.state.resourceNodes.forEach((node: ResourceNodeState) => resArray.push(node));
        await DatabaseService.saveAllResources(resArray);
        console.log(`✨ [WorldRoom] Saved ${resArray.length} fresh resource clusters to database.`);
      }

      // 2. Restore all saved player empires from SQLite
      const savedPlayers = await DatabaseService.loadAllWorldEntities();
      for (const p of savedPlayers) {
        for (const b of p.buildings) {
          const building = new BuildingState();
          building.id = b.id;
          building.ownerId = p.name;
          building.type = b.type;
          building.gridX = b.gridX;
          building.gridY = b.gridY;
          building.sizeX = b.sizeX;
          building.sizeY = b.sizeY;
          building.hp = b.hp;
          building.maxHp = b.maxHp;
          building.isConstructed = b.isConstructed;
          building.constructionProgress = b.constructionProgress;
          this.state.buildings.set(b.id, building);
        }

        for (const u of p.units) {
          const unit = new UnitState();
          unit.id = u.id;
          unit.ownerId = p.name;
          unit.type = u.type;
          unit.x = u.x;
          unit.y = u.y;
          unit.targetX = u.x;
          unit.targetY = u.y;
          unit.speed = u.speed;
          unit.hp = u.hp;
          unit.maxHp = u.maxHp;
          unit.actionState = u.actionState;
          this.state.units.set(u.id, unit);
        }
      }
      if (savedPlayers.length > 0) {
        console.log(`🏰 [WorldRoom] Restored bases for ${savedPlayers.length} empires from database.`);
      }

      // Keep generated entity ids unique across restarts (avoid overwriting persisted rows)
      this.state.resourceNodes.forEach((n) => this.bumpEntityId(n.id));
      this.state.buildings.forEach((b) => this.bumpEntityId(b.id));
      this.state.units.forEach((u) => this.bumpEntityId(u.id));
    } catch (err) {
      // Record instead of rethrowing: a rejected readyPromise would surface as an
      // unhandled rejection. onJoin aborts the join when this is set.
      console.error('❌ [WorldRoom] Failed to initialize persistence:', err);
      this.worldRestoreError = err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Advances nextEntityId past any persisted id (`b_1234`, `u_1234`, `res_1234`).
   */
  private bumpEntityId(id: string) {
    const match = /(\d+)$/.exec(id);
    if (!match) return;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > this.nextEntityId) {
      this.nextEntityId = value;
    }
  }

  /**
   * Deterministic 32-bit hash so the same player name always yields the same spawn area.
   */
  private hashPlayerName(name: string): number {
    let hash = 2166136261;
    for (let i = 0; i < name.length; i++) {
      hash ^= name.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /**
   * Checks whether a footprint fits inside the playable area and does not overlap
   * dirt roads or existing buildings. Resource nodes are handled separately so a
   * returning player can still claim their deterministic spot.
   */
  private isFootprintFree(gx: number, gy: number, sizeX: number, sizeY: number): boolean {
    const margin = 6;
    if (gx < margin || gy < margin) return false;
    if (gx + sizeX > MAP_GRID_WIDTH - margin || gy + sizeY > MAP_GRID_HEIGHT - margin) return false;

    for (let x = gx; x < gx + sizeX; x++) {
      for (let y = gy; y < gy + sizeY; y++) {
        if (isDirtRoadTile(x, y)) return false;
      }
    }

    let clear = true;
    this.state.buildings.forEach((b: BuildingState) => {
      if (!clear) return;
      const overlapX = gx < b.gridX + b.sizeX && gx + sizeX > b.gridX;
      const overlapY = gy < b.gridY + b.sizeY && gy + sizeY > b.gridY;
      if (overlapX && overlapY) clear = false;
    });

    return clear;
  }

  /**
   * Counts resource nodes sitting inside the footprint (they would be buried
   * underneath the Town Center).
   */
  private countResourcesInFootprint(gx: number, gy: number, sizeX: number, sizeY: number): number {
    let count = 0;
    this.state.resourceNodes.forEach((res: ResourceNodeState) => {
      if (
        res.gridX >= gx &&
        res.gridX < gx + sizeX &&
        res.gridY >= gy &&
        res.gridY < gy + sizeY
      ) {
        count++;
      }
    });
    return count;
  }

  private isSpawnAreaClear(gx: number, gy: number, sizeX: number, sizeY: number): boolean {
    return this.isFootprintFree(gx, gy, sizeX, sizeY) && this.countResourcesInFootprint(gx, gy, sizeX, sizeY) === 0;
  }

  /**
   * Prevents stacking duplicate resource nodes when a base is respawned on the
   * exact same deterministic spot.
   */
  private hasResourceAt(gx: number, gy: number): boolean {
    let found = false;
    this.state.resourceNodes.forEach((res: ResourceNodeState) => {
      if (!found && res.gridX === gx && res.gridY === gy) {
        found = true;
      }
    });
    return found;
  }

  /**
   * Deterministic fallback spawn: spiral outward from the map center until a clear
   * footprint is found. Never random, so retries are stable.
   */
  private findSpawnNearCenter(sizeX: number, sizeY: number): { x: number; y: number } {
    const centerX = Math.floor(MAP_GRID_WIDTH / 2);
    const centerY = Math.floor(MAP_GRID_HEIGHT / 2);

    for (let radius = 8; radius < Math.max(MAP_GRID_WIDTH, MAP_GRID_HEIGHT); radius += 4) {
      for (let i = 0; i < radius * 8; i++) {
        const angle = (i / (radius * 8)) * Math.PI * 2;
        const gx = Math.round(centerX + Math.cos(angle) * radius) - Math.floor(sizeX / 2);
        const gy = Math.round(centerY + Math.sin(angle) * radius) - Math.floor(sizeY / 2);

        if (this.isSpawnAreaClear(gx, gy, sizeX, sizeY)) {
          return { x: gx, y: gy };
        }
      }
    }

    // Ultimate fallback: keep the previous behaviour so the player is never base-less
    return {
      x: Math.floor(MAP_GRID_WIDTH / 2) - Math.floor(sizeX / 2),
      y: Math.floor(MAP_GRID_HEIGHT / 2) - Math.floor(sizeY / 2)
    };
  }

  private generateWorldResources() {
    // Generate expansive natural AoE-style resource clusters for 220x220 Large Map
    const occupiedTiles = new Set<string>();

    const spawnNode = (type: string, res: 'wood' | 'food' | 'gold' | 'stone', gx: number, gy: number, amount: number) => {
      if (gx < 5 || gx >= MAP_GRID_WIDTH - 5 || gy < 5 || gy >= MAP_GRID_HEIGHT - 5) return;
      const key = `${gx},${gy}`;
      if (occupiedTiles.has(key)) return;

      occupiedTiles.add(key);
      const id = `res_${++this.nextEntityId}`;
      const node = new ResourceNodeState();
      node.id = id;
      node.type = type;
      node.resourceType = res;
      node.gridX = gx;
      node.gridY = gy;
      node.remainingAmount = amount;
      node.maxAmount = amount;
      this.state.resourceNodes.set(id, node);
    };

    // 1. Forest Groves (85 dense forest clusters, 12-16 trees each)
    for (let c = 0; c < 85; c++) {
      const cx = Math.floor(8 + Math.random() * (MAP_GRID_WIDTH - 16));
      const cy = Math.floor(8 + Math.random() * (MAP_GRID_HEIGHT - 16));
      const treeCount = 12 + Math.floor(Math.random() * 5);
      for (let t = 0; t < treeCount; t++) {
        const dx = Math.floor(Math.random() * 5) - 2;
        const dy = Math.floor(Math.random() * 5) - 2;
        spawnNode('TREE', 'wood', cx + dx, cy + dy, 200);
      }
    }

    // 2. Gold Veins (40 clusters, 3-5 gold nodes each)
    for (let c = 0; c < 40; c++) {
      const cx = Math.floor(10 + Math.random() * (MAP_GRID_WIDTH - 20));
      const cy = Math.floor(10 + Math.random() * (MAP_GRID_HEIGHT - 20));
      const nodeCount = 3 + Math.floor(Math.random() * 3);
      for (let n = 0; n < nodeCount; n++) {
        const dx = Math.floor(Math.random() * 3) - 1;
        const dy = Math.floor(Math.random() * 3) - 1;
        spawnNode('GOLD_MINE', 'gold', cx + dx, cy + dy, 800);
      }
    }

    // 3. Stone Quarries (32 clusters, 3-4 stone nodes each)
    for (let c = 0; c < 32; c++) {
      const cx = Math.floor(10 + Math.random() * (MAP_GRID_WIDTH - 20));
      const cy = Math.floor(10 + Math.random() * (MAP_GRID_HEIGHT - 20));
      const nodeCount = 3 + Math.floor(Math.random() * 2);
      for (let n = 0; n < nodeCount; n++) {
        const dx = Math.floor(Math.random() * 3) - 1;
        const dy = Math.floor(Math.random() * 3) - 1;
        spawnNode('STONE_MINE', 'stone', cx + dx, cy + dy, 600);
      }
    }

    // 4. Berry Groves (40 patches, 4-6 bushes each)
    for (let c = 0; c < 40; c++) {
      const cx = Math.floor(10 + Math.random() * (MAP_GRID_WIDTH - 20));
      const cy = Math.floor(10 + Math.random() * (MAP_GRID_HEIGHT - 20));
      const bushCount = 4 + Math.floor(Math.random() * 3);
      for (let b = 0; b < bushCount; b++) {
        const dx = Math.floor(Math.random() * 3) - 1;
        const dy = Math.floor(Math.random() * 3) - 1;
        spawnNode('BERRY_BUSH', 'food', cx + dx, cy + dy, 150);
      }
    }
  }

  /**
   * Rejects anonymous connections before a seat is reserved.
   *
   * This must be `static`: `matchMaker` only calls the static hook during
   * matchmaking (see `callOnAuth` in `@colyseus/core`). An instance method is
   * skipped there, which would let an unauthenticated caller reserve seats via
   * `POST /matchmake/joinOrCreate/world_room`. The returned object becomes
   * `client.auth`, so `onJoin` can trust the identity it receives.
   *
   * @param token Bearer token forwarded from the matchmaking request headers.
   */
  static async onAuth(token: string | undefined): Promise<WorldRoomAuth> {
    const payload = AuthService.verifyToken(token);
    if (!payload) {
      // AUTH_FAILED (525) is the canonical matchmaking code; the client checks
      // the code, not the message, to decide whether to clear the stored token.
      throw new ServerError(ErrorCode.AUTH_FAILED, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
    }

    return {
      userId: payload.id,
      username: payload.username,
      displayName: payload.displayName
    };
  }

  async onJoin(client: Client, options: any) {
    // `onAuth` runs before every join and rejects anything without a verified
    // token, so the account name is the only ownership key. There is deliberately
    // no fallback to `options.playerName`: a client-supplied name would let a
    // player join as somebody else's empire.
    const authUser = client.auth as Partial<WorldRoomAuth> | undefined;
    if (!authUser?.displayName) {
      throw new Error('Cannot join without an authenticated account.');
    }
    const playerName = authUser.displayName;

    try {
      // Wait for the world snapshot to be fully restored before touching state.
      // Otherwise state.buildings is empty and we would spawn a duplicate base.
      if (this.readyPromise) {
        await this.readyPromise;
      }
      if (this.worldRestoreError) {
        // Abort instead of falling through to "no empire found" and spawning a
        // duplicate starter base on top of the (still persisted) saved empire.
        throw new Error(`World restore failed: ${this.worldRestoreError.message}`);
      }

      // Check if player profile already exists in Database
      const savedProfile = await DatabaseService.loadPlayerProfile(playerName);

      const player = new PlayerState();
      player.id = client.sessionId;
      player.name = playerName;

      if (savedProfile) {
        player.color = savedProfile.color;
        player.wood = savedProfile.wood;
        player.food = savedProfile.food;
        player.gold = savedProfile.gold;
        player.stone = savedProfile.stone;
        player.population = savedProfile.population;
        player.populationCap = savedProfile.populationCap;
        player.isOnline = true;

        this.state.players.set(client.sessionId, player);

        // Re-assign ownership of their structures and troops to active sessionId
        let ownedBCount = 0;
        this.state.buildings.forEach((b: BuildingState) => {
          if (b.ownerId === playerName || b.ownerId === savedProfile.id) {
            b.ownerId = client.sessionId;
            ownedBCount++;
          }
        });

        let ownedUCount = 0;
        this.state.units.forEach((u: UnitState) => {
          if (u.ownerId === playerName || u.ownerId === savedProfile.id) {
            u.ownerId = client.sessionId;
            ownedUCount++;
          }
        });

        // If returning empire has no structures or units left, spawn starter base
        if (ownedBCount === 0 && ownedUCount === 0) {
          console.log(`[WorldRoom] Player ${playerName} has no remaining units/buildings. Spawning starter base.`);
          this.spawnInitialBase(client.sessionId);
        }

        this.updatePlayerPopulation(client.sessionId);
        console.log(`🏰 [WorldRoom] Welcome back Emperor ${playerName}! Empire restored from SQLite.`);
      } else {
        const playerIndex = this.state.players.size % PLAYER_COLORS.length;
        player.color = PLAYER_COLORS[playerIndex];

        this.state.players.set(client.sessionId, player);
        console.log(`⚔️ [WorldRoom] New Emperor ${player.name} (${client.sessionId}) joined.`);

        // Spawn initial base: Town Center + 3 starting Villagers
        this.spawnInitialBase(client.sessionId);

        // Persist new empire immediately to DB
        const ownedB: BuildingState[] = [];
        this.state.buildings.forEach((b: BuildingState) => {
          if (b.ownerId === client.sessionId) ownedB.push(b);
        });
        const ownedU: UnitState[] = [];
        this.state.units.forEach((u: UnitState) => {
          if (u.ownerId === client.sessionId) ownedU.push(u);
        });

        await DatabaseService.savePlayerEmpire(player, ownedB, ownedU);
      }
    } catch (err) {
      console.error(`❌ [WorldRoom] Error joining player ${playerName}:`, err);
    }
  }

  private spawnInitialBase(sessionId: string) {
    const player = this.state.players.get(sessionId);
    if (!player) return;

    const tcBlueprint = BUILDING_BLUEPRINTS.TOWN_CENTER;

    // Deterministic spawn: same player name always resolves to the same area,
    // so re-joining never shuffles the empire around the map.
    const baseHash = this.hashPlayerName(player.name);
    const candidateCount = 512;
    let spawnX = -1;
    let spawnY = -1;

    for (let attempt = 0; attempt < candidateCount; attempt++) {
      // Golden-ratio stride keeps consecutive players far apart
      const seedX = (baseHash + Math.imul(attempt, 0x9e3779b1)) >>> 0;
      const seedY = ((baseHash >>> 16) + Math.imul(attempt, 0x85ebca6b)) >>> 0;

      const usableX = MAP_GRID_WIDTH - 40;
      const usableY = MAP_GRID_HEIGHT - 40;
      const candidateX = 20 + (seedX % usableX);
      const candidateY = 20 + (seedY % usableY);

      if (this.isSpawnAreaClear(candidateX, candidateY, tcBlueprint.sizeX, tcBlueprint.sizeY)) {
        spawnX = candidateX;
        spawnY = candidateY;
        break;
      }
    }

    // Fallback: spiral scan from map center if every hashed candidate was blocked
    if (spawnX < 0) {
      const centered = this.findSpawnNearCenter(tcBlueprint.sizeX, tcBlueprint.sizeY);
      spawnX = centered.x;
      spawnY = centered.y;
    }

    // Create Town Center
    const tcId = `b_${++this.nextEntityId}`;
    const townCenter = new BuildingState();
    townCenter.id = tcId;
    townCenter.ownerId = sessionId;
    townCenter.type = 'TOWN_CENTER';
    townCenter.gridX = spawnX;
    townCenter.gridY = spawnY;
    townCenter.sizeX = tcBlueprint.sizeX;
    townCenter.sizeY = tcBlueprint.sizeY;
    townCenter.hp = tcBlueprint.maxHp;
    townCenter.maxHp = tcBlueprint.maxHp;
    townCenter.isConstructed = true;
    townCenter.constructionProgress = 100;

    this.state.buildings.set(tcId, townCenter);

    // Spawn starter trees near Town Center (AoE starter woodline)
    const starterTreeOffsets = [
      { dx: -2, dy: -1 },
      { dx: -2, dy: 0 },
      { dx: -1, dy: -2 },
      { dx: 0, dy: -2 }
    ];
    starterTreeOffsets.forEach((off) => {
      const gridX = spawnX + off.dx;
      const gridY = spawnY + off.dy;
      if (this.hasResourceAt(gridX, gridY)) return;

      const id = `res_${++this.nextEntityId}`;
      const node = new ResourceNodeState();
      node.id = id;
      node.type = 'TREE';
      node.resourceType = 'wood';
      node.gridX = gridX;
      node.gridY = gridY;
      node.remainingAmount = 200;
      node.maxAmount = 200;
      this.state.resourceNodes.set(id, node);
    });

    // Spawn starter berry bushes near Town Center (AoE starter forage food)
    const starterBerryOffsets = [
      { dx: 5, dy: 1 },
      { dx: 6, dy: 1 },
      { dx: 5, dy: 2 }
    ];
    starterBerryOffsets.forEach((off) => {
      const gridX = spawnX + off.dx;
      const gridY = spawnY + off.dy;
      if (this.hasResourceAt(gridX, gridY)) return;

      const id = `res_${++this.nextEntityId}`;
      const node = new ResourceNodeState();
      node.id = id;
      node.type = 'BERRY_BUSH';
      node.resourceType = 'food';
      node.gridX = gridX;
      node.gridY = gridY;
      node.remainingAmount = 150;
      node.maxAmount = 150;
      this.state.resourceNodes.set(id, node);
    });

    // Spawn 3 starter villagers outside 4x4 Town Center
    const villagerOffsets = [
      { dx: 4, dy: 1 },
      { dx: 1, dy: 4 },
      { dx: 4, dy: 2 }
    ];

    villagerOffsets.forEach((off, idx) => {
      const vId = `u_${++this.nextEntityId}`;
      const villager = new UnitState();
      villager.id = vId;
      villager.ownerId = sessionId;
      villager.type = 'VILLAGER';
      villager.x = spawnX + off.dx;
      villager.y = spawnY + off.dy;
      villager.targetX = villager.x;
      villager.targetY = villager.y;
      villager.speed = UNIT_BLUEPRINTS.VILLAGER.speed;
      villager.hp = UNIT_BLUEPRINTS.VILLAGER.maxHp;
      villager.maxHp = UNIT_BLUEPRINTS.VILLAGER.maxHp;
      villager.actionState = 'IDLE';

      this.state.units.set(vId, villager);
    });

    this.updatePlayerPopulation(sessionId);
  }

  private handlePlaceBuilding(client: Client, payload: PlaceBuildingPayload) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const blueprint = BUILDING_BLUEPRINTS[payload.type];
    if (!blueprint) {
      client.send(NetworkMessage.ERROR_NOTIFICATION, { message: 'Invalid building type' });
      return;
    }

    // Check resource sufficiency
    if (
      player.wood < blueprint.cost.wood ||
      player.food < blueprint.cost.food ||
      player.gold < blueprint.cost.gold ||
      player.stone < blueprint.cost.stone
    ) {
      client.send(NetworkMessage.ERROR_NOTIFICATION, { message: 'Insufficient resources to construct building' });
      return;
    }

    // Check bounds
    const endX = payload.gridX + blueprint.sizeX;
    const endY = payload.gridY + blueprint.sizeY;
    if (payload.gridX < 0 || endX > MAP_GRID_WIDTH || payload.gridY < 0 || endY > MAP_GRID_HEIGHT) {
      client.send(NetworkMessage.ERROR_NOTIFICATION, { message: 'Cannot build outside map bounds' });
      return;
    }

    // Check tile occupancy collisions with other buildings and resource nodes
    let isColliding = false;
    this.state.buildings.forEach((b: BuildingState) => {
      const bEndX = b.gridX + b.sizeX;
      const bEndY = b.gridY + b.sizeY;
      const overlapX = payload.gridX < bEndX && endX > b.gridX;
      const overlapY = payload.gridY < bEndY && endY > b.gridY;
      if (overlapX && overlapY) {
        isColliding = true;
      }
    });

    this.state.resourceNodes.forEach((res: ResourceNodeState) => {
      if (res.gridX >= payload.gridX && res.gridX < endX && res.gridY >= payload.gridY && res.gridY < endY) {
        isColliding = true;
      }
    });

    if (isColliding) {
      client.send(NetworkMessage.ERROR_NOTIFICATION, { message: 'Placement obstructed by existing structure or resource' });
      return;
    }

    // Deduct resources
    player.wood -= blueprint.cost.wood;
    player.food -= blueprint.cost.food;
    player.gold -= blueprint.cost.gold;
    player.stone -= blueprint.cost.stone;

    // Create building
    const buildingId = `b_${++this.nextEntityId}`;
    const building = new BuildingState();
    building.id = buildingId;
    building.ownerId = client.sessionId;
    building.type = payload.type;
    building.gridX = payload.gridX;
    building.gridY = payload.gridY;
    building.sizeX = blueprint.sizeX;
    building.sizeY = blueprint.sizeY;
    building.hp = 1; // CMD-05: a foundation is nearly defenceless until it is finished
    building.maxHp = blueprint.maxHp;
    building.isConstructed = false;
    building.constructionProgress = 0;

    this.state.buildings.set(buildingId, building);
    this.updatePlayerPopulation(client.sessionId);
  }

  /**
   * Keeps only the units this client actually owns, at most one entry per id.
   *
   * A repeated id would otherwise receive two orders and two formation cells,
   * so the same unit would be counted twice in the block.
   */
  private collectOwnedUnits(client: Client, unitIds: string[]): UnitState[] {
    const owned: UnitState[] = [];
    const seen = new Set<string>();

    unitIds.forEach((uId) => {
      if (seen.has(uId)) return;
      seen.add(uId);

      const unit = this.state.units.get(uId);
      if (unit && unit.ownerId === client.sessionId) owned.push(unit);
    });

    return owned;
  }

  /**
   * Lays `units` out as a centred block around one grid destination (CMD-02) and
   * clamps every cell to the map. Shared by every group order so a squad keeps
   * its shape whether it walks or attack-moves.
   *
   * @returns One destination per input unit, in the same order.
   */
  private assignFormationTargets(
    units: UnitState[],
    destX: number,
    destY: number
  ): Array<{ x: number; y: number }> {
    const offsets = computeFormationOffsets(units.length, FORMATION_SPACING);
    return units.map((_, idx) => ({
      x: Math.max(0, Math.min(MAP_GRID_WIDTH - 1, destX + offsets[idx].x)),
      y: Math.max(0, Math.min(MAP_GRID_HEIGHT - 1, destY + offsets[idx].y))
    }));
  }

  private handleMoveUnits(client: Client, payload: MoveUnitsPayload) {
    if (!payload.unitIds || payload.unitIds.length === 0) return;
    if (payload.unitIds.length > MAX_SELECTION) {
      this.rejectCommand(client, 'Too many units in one command');
      return;
    }
    if (!Number.isFinite(payload.targetGridX) || !Number.isFinite(payload.targetGridY)) {
      this.rejectCommand(client, 'Invalid move target');
      return;
    }

    // Shift+right click appends; a plain move replaces the whole order. Anything
    // that is not literally `true` is treated as a direct move, so a malformed
    // payload can never sneak extra state into a unit.
    const queueWaypoint = payload.queue === true;

    // Validate first, then spread the surviving units over one formation. Doing
    // it in a single pass would size the block off the payload length, so ids
    // that are foreign or stale would leave holes in the shape.
    const ownedUnits = this.collectOwnedUnits(client, payload.unitIds);
    const targets = this.assignFormationTargets(ownedUnits, payload.targetGridX, payload.targetGridY);

    ownedUnits.forEach((unit, idx) => {
      const { x: targetX, y: targetY } = targets[idx];

      if (queueWaypoint) {
        if (unit.queueTargetX.length >= MAX_QUEUED_WAYPOINTS) return;
        unit.queueTargetX.push(targetX);
        unit.queueTargetY.push(targetY);
        // A unit with no order in flight has nothing to finish, so the point
        // it just asked for becomes the active order immediately.
        if (unit.actionState === 'IDLE') {
          this.advanceQueuedWaypoint(unit);
        }
        return;
      }

      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      unit.targetX = targetX;
      unit.targetY = targetY;
      unit.actionState = 'MOVING';
      unit.targetEntityId = '';
      unit.targetEntityType = '';
      unit.previousActionState = '';
    });
  }

  /**
   * Pops the next queued waypoint into the unit's active movement order.
   *
   * The two arrays are always written together, so a length mismatch can only
   * come from a corrupted snapshot; when it happens the queue is dropped rather
   * than half-applied.
   *
   * @returns true when a waypoint was consumed and the unit is now MOVING.
   */
  private advanceQueuedWaypoint(unit: UnitState): boolean {
    if (unit.queueTargetX.length !== unit.queueTargetY.length) {
      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      return false;
    }
    if (unit.queueTargetX.length === 0) return false;

    const nextX = unit.queueTargetX.shift();
    const nextY = unit.queueTargetY.shift();
    if (typeof nextX !== 'number' || typeof nextY !== 'number') {
      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      return false;
    }

    unit.targetX = nextX;
    unit.targetY = nextY;
    unit.targetEntityId = '';
    unit.targetEntityType = '';
    unit.actionState = 'MOVING';
    return true;
  }

  /**
   * Ends the unit's current order and starts the next queued waypoint, if any.
   *
   * Called wherever an order finishes or becomes invalid (arrival, target gone,
   * resource depleted). Without it a Shift-queued path would be stranded: the
   * waypoints would sit in the snapshot and never run, because nothing else ever
   * consumes them.
   */
  private resumeQueuedWaypoint(unit: UnitState) {
    unit.targetEntityId = '';
    unit.targetEntityType = '';
    unit.previousActionState = '';
    if (!this.advanceQueuedWaypoint(unit)) {
      unit.actionState = 'IDLE';
    }
  }

  /**
   * Ends a fight (CMD-01).
   *
   * The unit remembers what it was doing before it engaged in
   * `previousActionState`: an attack-move keeps walking to its destination, a
   * patrol keeps walking its route. Anything else falls back to the queued
   * waypoints, exactly like a finished plain attack.
   */
  private endAttackOrder(unit: UnitState) {
    const resume = unit.previousActionState;
    unit.previousActionState = '';

    if (resume === 'ATTACK_MOVE' || resume === 'PATROL') {
      unit.targetEntityId = '';
      unit.targetEntityType = '';
      unit.actionState = resume;
      return;
    }

    this.resumeQueuedWaypoint(unit);
  }

  /**
   * Whether the unit's attack target still exists in the snapshot. A unit with no
   * target at all counts as gone, so an `ATTACKING` state can never survive
   * without something to hit.
   */
  private isAttackTargetAlive(unit: UnitState): boolean {
    if (!unit.targetEntityId) return false;
    if (unit.targetEntityType === 'unit') return this.state.units.has(unit.targetEntityId);
    if (unit.targetEntityType === 'building') return this.state.buildings.has(unit.targetEntityId);
    return false;
  }

  /**
   * Closest enemy unit within `radius` tiles, or null. Buildings are deliberately
   * excluded: an attack-moving squad should engage soldiers, not stop to batter
   * a wall it walks past.
   */
  private findNearestEnemyUnit(unit: UnitState, radius: number): UnitState | null {
    let nearest: UnitState | null = null;
    let nearestDist = radius;

    this.state.units.forEach((other: UnitState) => {
      if (other.ownerId === unit.ownerId) return;
      const dist = Math.hypot(other.x - unit.x, other.y - unit.y);
      if (dist <= nearestDist) {
        nearest = other;
        nearestDist = dist;
      }
    });

    return nearest;
  }

  private handleTrainUnit(client: Client, payload: TrainUnitPayload) {
    const player = this.state.players.get(client.sessionId);
    const building = this.state.buildings.get(payload.buildingId);
    if (!player || !building || building.ownerId !== client.sessionId) return;

    const blueprint = BUILDING_BLUEPRINTS[building.type as BuildingType];
    if (!blueprint || !blueprint.trainableUnits.includes(payload.unitType)) {
      client.send(NetworkMessage.ERROR_NOTIFICATION, { message: 'Unit cannot be trained at this structure' });
      return;
    }

    const unitBlueprint = UNIT_BLUEPRINTS[payload.unitType];
    if (!unitBlueprint) return;

    // Population limit check
    if (player.population >= player.populationCap) {
      client.send(NetworkMessage.ERROR_NOTIFICATION, { message: 'Population limit reached. Build more Houses!' });
      return;
    }

    // Resource check
    if (
      player.wood < unitBlueprint.cost.wood ||
      player.food < unitBlueprint.cost.food ||
      player.gold < unitBlueprint.cost.gold ||
      player.stone < unitBlueprint.cost.stone
    ) {
      client.send(NetworkMessage.ERROR_NOTIFICATION, { message: 'Insufficient resources to train unit' });
      return;
    }

    // Deduct resources
    player.wood -= unitBlueprint.cost.wood;
    player.food -= unitBlueprint.cost.food;
    player.gold -= unitBlueprint.cost.gold;
    player.stone -= unitBlueprint.cost.stone;

    // Add to training queue
    building.trainingQueue.push(payload.unitType);
  }

  /**
   * CMD-04a: drops the unit at the head of a building's training queue.
   *
   * The queue is the source of truth for what was being trained, so the refund
   * amount never comes from the client: only the head is cancelled and only its
   * own blueprint price is returned. Cancelling refunds in full — nothing has
   * been produced yet, the player only loses the elapsed time.
   */
  private handleCancelTrain(client: Client, payload: CancelTrainPayload) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const building = this.requireOwnedBuilding(client, payload.buildingId);
    if (!building) return;

    if (building.trainingQueue.length === 0) {
      this.rejectCommand(client, 'Nothing is being trained here');
      return;
    }

    // Resolve the price before touching the queue: an unreadable entry must not
    // disappear without a refund, which is what a shift-then-lookup would do.
    const unitType = building.trainingQueue[0] as UnitType;
    const blueprint = UNIT_BLUEPRINTS[unitType];
    if (!blueprint) {
      this.rejectCommand(client, 'Unknown unit in training queue');
      return;
    }

    building.trainingQueue.shift();
    // The elapsed time belonged to the cancelled unit. Keeping it would let the
    // player cancel and re-queue to finish the next unit for free.
    building.trainingProgressMs = 0;
    this.refundResources(player, blueprint.cost, 1);
  }

  /**
   * CMD-04b: removes a foundation that was placed but never finished.
   *
   * Completed buildings are rejected: this is a "cancel the build", not a
   * demolish command, and silently deleting a finished Town Center on a
   * misclicked hotkey would be unrecoverable.
   */
  private handleCancelBuilding(client: Client, payload: CancelBuildingPayload) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const building = this.requireOwnedBuilding(client, payload.buildingId);
    if (!building) return;

    if (building.isConstructed) {
      this.rejectCommand(client, 'Cannot cancel a completed building');
      return;
    }

    const blueprint = BUILDING_BLUEPRINTS[building.type as BuildingType];
    if (blueprint) {
      // A foundation that has barely been worked on returns everything; once
      // real progress went in, the player eats half the cost.
      const ratio =
        building.constructionProgress < CANCEL_BUILDING_FULL_REFUND_BELOW
          ? 1
          : CANCEL_BUILDING_PARTIAL_REFUND_RATIO;
      this.refundResources(player, blueprint.cost, ratio);
    }

    // Units walking to or attacking the foundation resolve the missing target
    // on their next tick, so nothing has to be repointed here.
    this.state.buildings.delete(building.id);
  }

  /**
   * Credits a fraction of a blueprint cost back to a player.
   *
   * Each resource is floored separately so a partial refund can never round up
   * into free material. `ratio` is clamped at 1: a refund must never mint
   * resources, whatever a future caller passes.
   */
  private refundResources(player: PlayerState, cost: Resources, ratio: number) {
    if (!(ratio > 0)) return;

    const share = Math.min(1, ratio);
    player.wood += Math.floor(cost.wood * share);
    player.food += Math.floor(cost.food * share);
    player.gold += Math.floor(cost.gold * share);
    player.stone += Math.floor(cost.stone * share);
  }

  /**
   * Resolves a building the client is allowed to command, or rejects the command.
   *
   * Cancelling training, cancelling a foundation and setting a rally point all
   * open with the same existence + ownership checks. Keeping them in one place
   * means a new command cannot forget one and quietly accept a foreign id.
   */
  private requireOwnedBuilding(client: Client, buildingId: string): BuildingState | null {
    if (!buildingId) return null;

    const building = this.state.buildings.get(buildingId);
    if (!building) {
      this.rejectCommand(client, 'Building no longer exists');
      return null;
    }
    if (building.ownerId !== client.sessionId) {
      this.rejectCommand(client, 'Not your building');
      return null;
    }
    return building;
  }

  private handleAttackTarget(client: Client, payload: AttackTargetPayload) {
    if (!payload.unitIds || payload.unitIds.length === 0) return;
    if (payload.unitIds.length > MAX_SELECTION) {
      this.rejectCommand(client, 'Too many units in one command');
      return;
    }

    // The client chooses targetEntityId/targetType freely, so resolve the target
    // from authoritative state and reject anything that is missing or friendly.
    // Without this a client can order units to attack an ally or itself.
    const target =
      payload.targetType === 'unit'
        ? this.state.units.get(payload.targetEntityId)
        : payload.targetType === 'building'
          ? this.state.buildings.get(payload.targetEntityId)
          : undefined;

    if (!target) {
      this.rejectCommand(client, 'Target no longer exists');
      return;
    }
    if (target.ownerId === client.sessionId) {
      this.rejectCommand(client, 'Cannot attack your own units or buildings');
      return;
    }

    payload.unitIds.forEach((uId) => {
      const unit = this.state.units.get(uId);
      if (unit && unit.ownerId === client.sessionId) {
        // A new order replaces any queued path; leaving waypoints behind would
        // make the unit resume an old route after the attack finishes.
        unit.queueTargetX.clear();
        unit.queueTargetY.clear();
        // A plain attack has nothing to return to (CMD-01).
        unit.previousActionState = '';
        unit.targetEntityId = payload.targetEntityId;
        unit.targetEntityType = payload.targetType;
        unit.actionState = 'ATTACKING';
      }
    });
  }

  /**
   * CMD-01: issues ATTACK_MOVE or PATROL to a grid point.
   *
   * Both orders reuse the formation layout of a plain move, so a squad keeps its
   * shape while walking. PATROL also keeps each unit's current position as the
   * other end of the route; the endpoints swap on every arrival (see `update`).
   *
   * The unit types are mixed freely: villagers may attack-move too, they just
   * never auto-engage (`aggroRadius = 0`), which keeps a wood-cutting crew from
   * charging a passing scout.
   */
  private handleAttackMove(client: Client, payload: AttackMovePayload, mode: 'ATTACK_MOVE' | 'PATROL') {
    if (!payload?.unitIds || payload.unitIds.length === 0) return;
    if (payload.unitIds.length > MAX_SELECTION) {
      this.rejectCommand(client, 'Too many units in one command');
      return;
    }
    if (!Number.isFinite(payload.targetGridX) || !Number.isFinite(payload.targetGridY)) {
      this.rejectCommand(client, 'Invalid move target');
      return;
    }

    // Same validate-then-spread order as `handleMoveUnits`: a foreign or repeated
    // id must not leave a hole in the block.
    const ownedUnits = this.collectOwnedUnits(client, payload.unitIds);
    const targets = this.assignFormationTargets(ownedUnits, payload.targetGridX, payload.targetGridY);

    ownedUnits.forEach((unit, idx) => {
      const { x: targetX, y: targetY } = targets[idx];

      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      unit.targetEntityId = '';
      unit.targetEntityType = '';
      unit.previousActionState = '';
      unit.targetX = targetX;
      unit.targetY = targetY;

      if (mode === 'PATROL') {
        // The route starts where the unit stands, so it walks back here once it
        // reaches the clicked point.
        unit.patrolX = unit.x;
        unit.patrolY = unit.y;
      }

      unit.actionState = mode;
    });
  }

  /**
   * CMD-05: sends villagers to work on one of the player's own foundations.
   *
   * The client only says "these units, that building"; the server resolves both
   * against authoritative state, so a foreign foundation is rejected instead of
   * being built for its owner, and non-builders are dropped from the crew rather
   * than being dragged to the site.
   *
   * Each builder is sent to its own point on the ring just outside the footprint
   * (see `getBuildApproachPoint`), which is what stops a three-villager crew from
   * stacking on one tile.
   */
  private handleBuildTarget(client: Client, payload: BuildTargetPayload) {
    if (!payload?.unitIds || payload.unitIds.length === 0) return;
    if (payload.unitIds.length > MAX_SELECTION) {
      this.rejectCommand(client, 'Too many units in one command');
      return;
    }

    const building = this.requireOwnedBuilding(client, payload.buildingId);
    if (!building) return;
    if (building.isConstructed) {
      this.rejectCommand(client, 'Building is already finished');
      return;
    }
    if (!BUILDING_BLUEPRINTS[building.type as BuildingType]) {
      this.rejectCommand(client, 'Unknown building type');
      return;
    }

    const builders = this.collectOwnedUnits(client, payload.unitIds).filter(
      (unit) => (UNIT_BLUEPRINTS[unit.type as UnitType]?.buildPower ?? 0) > 0
    );
    if (builders.length === 0) {
      this.rejectCommand(client, 'Only villagers can build');
      return;
    }

    builders.forEach((unit, idx) => {
      const approach = getBuildApproachPoint(unit, building, idx, builders.length);

      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      unit.targetEntityId = building.id;
      unit.targetEntityType = 'building';
      unit.previousActionState = '';
      unit.targetX = approach.x;
      unit.targetY = approach.y;
      unit.actionState = 'BUILDING';
      // Leaving a woodline for a build site must not leave a stale retarget type
      // behind, or a later depleted node would pull the villager back to it.
      this.harvestTypeByUnit.delete(unit.id);
    });
  }

  /**
   * Keeps a villager's `BUILDING` order in sync with the site each tick.
   *
   * Walking to the ring is handled by the movement pass; this only checks for a
   * site that is gone or finished and, once the villager is close enough, signs it
   * up to the crew.
   */
  private processUnitBuilding(unit: UnitState) {
    const building = this.state.buildings.get(unit.targetEntityId);

    // Cancelled, destroyed or finished: there is nothing left to build, so fall
    // back to a queued waypoint (the site may have been a detour) or go idle.
    if (!building || building.isConstructed || building.ownerId !== unit.ownerId) {
      this.resumeQueuedWaypoint(unit);
      return;
    }

    if (!isWithinBuildRange(unit, building)) return;

    if (!building.builderUnitIds.includes(unit.id)) {
      building.builderUnitIds.push(unit.id);
    }
  }

  private handleHarvestResource(client: Client, payload: HarvestResourcePayload) {
    if (!payload.unitIds || payload.unitIds.length === 0) return;
    if (payload.unitIds.length > MAX_SELECTION) {
      this.rejectCommand(client, 'Too many units in one command');
      return;
    }

    const resource = this.state.resourceNodes.get(payload.resourceNodeId);
    if (!resource) {
      this.rejectCommand(client, 'Resource node no longer exists');
      return;
    }
    if (resource.remainingAmount <= 0) {
      this.rejectCommand(client, 'Resource node is depleted');
      return;
    }

    payload.unitIds.forEach((uId) => {
      const unit = this.state.units.get(uId);
      if (unit && unit.ownerId === client.sessionId && UNIT_BLUEPRINTS[unit.type as UnitType]?.canHarvest) {
        unit.queueTargetX.clear();
        unit.queueTargetY.clear();
        unit.targetEntityId = payload.resourceNodeId;
        unit.targetEntityType = 'resource';
        unit.targetX = resource.gridX;
        unit.targetY = resource.gridY;
        unit.actionState = 'HARVESTING';
        unit.previousActionState = '';
        // Remember the type so a depleted node can hand the villager to the
        // nearest node of the same kind instead of leaving it idle (CMD-06).
        this.harvestTypeByUnit.set(unit.id, resource.resourceType);
      }
    });
  }

  /**
   * Halts the given units where they stand.
   *
   * Stop cancels the unit's order (move / attack / harvest) and leaves it at its
   * exact position. `targetX/targetY` are reset to the current position so the
   * movement branch in `update()` has nothing left to walk towards.
   *
   * Per-unit timers are deliberately NOT cleared: they hold unit state, not
   * order state. Dropping `atk_<id>` would reset the weapon cooldown, letting a
   * client spam stop + attack to land a hit every tick instead of every
   * cooldown. Leaving `harv_<id>` alone keeps partial harvest progress.
   *
   * Queued waypoints ARE cleared: they are the remaining part of the cancelled
   * order, so resuming them later would undo the stop.
   */
  private handleStopUnits(client: Client, payload: StopUnitsPayload) {
    if (!payload?.unitIds || payload.unitIds.length === 0) return;
    if (payload.unitIds.length > MAX_SELECTION) {
      this.rejectCommand(client, 'Too many units in one command');
      return;
    }

    payload.unitIds.forEach((uId) => {
      const unit = this.state.units.get(uId);
      if (!unit || unit.ownerId !== client.sessionId) return;

      unit.actionState = 'IDLE';
      unit.targetEntityId = '';
      unit.targetEntityType = '';
      unit.previousActionState = '';
      unit.targetX = unit.x;
      unit.targetY = unit.y;
      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      this.harvestTypeByUnit.delete(unit.id);
    });
  }

  /**
   * Sets where this building's newly trained units should walk to.
   *
   * Only the owner may set it: a foreign building id is refused outright rather
   * than silently ignored, so a client bug surfaces as an error toast instead of
   * a rally point that appears to work. Coordinates are validated against the
   * map bounds because the client sends grid positions straight from the pointer
   * and a stray click outside the terrain would otherwise create an unreachable
   * target that traps every future unit in MOVING forever. Buildings that train
   * nothing are refused too: a rally flag on a House is a promise the simulation
   * can never keep.
   */
  private handleSetRallyPoint(client: Client, payload: SetRallyPointPayload) {
    const building = this.requireOwnedBuilding(client, payload?.buildingId);
    if (!building) return;

    if (!canTrainUnitsAt(building.type as BuildingType)) {
      this.rejectCommand(client, 'This building cannot train units');
      return;
    }

    const gridX = Number(payload.gridX);
    const gridY = Number(payload.gridY);
    if (
      !Number.isFinite(gridX) ||
      !Number.isFinite(gridY) ||
      gridX < 0 ||
      gridY < 0 ||
      gridX >= MAP_GRID_WIDTH ||
      gridY >= MAP_GRID_HEIGHT
    ) {
      this.rejectCommand(client, 'Invalid rally point');
      return;
    }

    building.rallyX = gridX;
    building.rallyY = gridY;
  }

  /** Notify a client that a command was refused, so the UI can explain why. */
  private rejectCommand(client: Client, message: string) {
    client.send(NetworkMessage.ERROR_NOTIFICATION, { message });
  }

  private update(deltaTime: number) {
    const dtSeconds = deltaTime / 1000;

    // 1. Update construction and training queues for buildings
    this.state.buildings.forEach((building: BuildingState) => {
      if (!building.isConstructed) {
        // CMD-05: work only happens while villagers stand at the site, and the
        // blueprint's buildTimeMs is the time one villager needs.
        const buildPower = syncBuilders(building, this.state.units);
        const buildTimeMs = BUILDING_BLUEPRINTS[building.type as BuildingType]?.buildTimeMs ?? 0;
        if (buildPower > 0 && buildTimeMs > 0) {
          building.constructionProgress += (deltaTime * 100 * buildPower) / buildTimeMs;
        }

        if (building.constructionProgress >= 100) {
          building.constructionProgress = 100;
          building.isConstructed = true;
          building.hp = building.maxHp;
          // The crew is done; every builder drops back to idle on its next tick
          // (see `processUnitBuilding`), and the roster must not outlive the site.
          building.builderUnitIds.clear();
          this.updatePlayerPopulation(building.ownerId);
        }
      }

      // Process training queue
      if (building.isConstructed && building.trainingQueue.length > 0) {
        building.trainingProgressMs += deltaTime;
        const currentUnitType = building.trainingQueue[0] as UnitType;
        const blueprint = UNIT_BLUEPRINTS[currentUnitType];
        if (blueprint && building.trainingProgressMs >= blueprint.trainTimeMs) {
          building.trainingQueue.shift();
          building.trainingProgressMs = 0;
          this.spawnTrainedUnit(building, currentUnitType);
        }
      }
    });

    // 2. Update units (movement, combat, harvesting)
    this.state.units.forEach((unit: UnitState) => {
      const blueprint = UNIT_BLUEPRINTS[unit.type as UnitType];
      if (!blueprint) return;

      // CMD-01: before taking a step, an attack-moving or patrolling unit checks
      // for the closest enemy inside its aggro radius. Switching to ATTACKING
      // parks the current order in `previousActionState` so the unit picks it up
      // again once the fight is over.
      if ((unit.actionState === 'ATTACK_MOVE' || unit.actionState === 'PATROL') && blueprint.aggroRadius > 0) {
        const enemy = this.findNearestEnemyUnit(unit, blueprint.aggroRadius);
        if (enemy) {
          unit.previousActionState = unit.actionState;
          unit.actionState = 'ATTACKING';
          unit.targetEntityId = enemy.id;
          unit.targetEntityType = 'unit';
        }
      }

      // A fight whose target was destroyed, killed by someone else or simply
      // removed from the snapshot resumes the stored order instead of leaving the
      // unit standing with a dangling target id. ATTACKING with no target at all
      // is the same dead end, so it takes the same exit.
      if (unit.actionState === 'ATTACKING' && !this.isAttackTargetAlive(unit)) {
        this.endAttackOrder(unit);
      }

      // Movement handling
      if (
        unit.actionState === 'MOVING' ||
        unit.actionState === 'HARVESTING' ||
        unit.actionState === 'ATTACKING' ||
        unit.actionState === 'ATTACK_MOVE' ||
        unit.actionState === 'PATROL' ||
        unit.actionState === 'BUILDING'
      ) {
        let destinationX = unit.targetX;
        let destinationY = unit.targetY;

        // If pursuing attack target, update destination towards target position
        if (unit.actionState === 'ATTACKING' && unit.targetEntityId) {
          let targetX = unit.x;
          let targetY = unit.y;

          if (unit.targetEntityType === 'unit') {
            const targetUnit = this.state.units.get(unit.targetEntityId);
            if (targetUnit) {
              targetX = targetUnit.x;
              targetY = targetUnit.y;
            }
          } else if (unit.targetEntityType === 'building') {
            const targetBuilding = this.state.buildings.get(unit.targetEntityId);
            if (targetBuilding) {
              targetX = targetBuilding.gridX + targetBuilding.sizeX / 2;
              targetY = targetBuilding.gridY + targetBuilding.sizeY / 2;
            }
          }
          destinationX = targetX;
          destinationY = targetY;
        }

        const dx = destinationX - unit.x;
        const dy = destinationY - unit.y;
        const dist = Math.hypot(dx, dy);

        const attackRange = blueprint.attackRange;

        const stopDist = unit.actionState === 'ATTACKING' ? attackRange : 0.15;

        if (dist > stopDist) {
          const moveStep = Math.min(dist, unit.speed * dtSeconds);
          unit.x += (dx / dist) * moveStep;
          unit.y += (dy / dist) * moveStep;
        } else {
          if (unit.actionState === 'MOVING' || unit.actionState === 'ATTACK_MOVE') {
            // Arrived: walk on to the next queued waypoint if there is one. An
            // attack-move ends here (IDLE), like in AoE.
            this.resumeQueuedWaypoint(unit);
          } else if (unit.actionState === 'PATROL') {
            // Reached one end of the route: swap the endpoints and head back. A
            // route whose ends collapse onto the same tile would otherwise ping
            // pong every tick, so it ends instead.
            const nextX = unit.patrolX;
            const nextY = unit.patrolY;
            if (Math.hypot(nextX - unit.x, nextY - unit.y) <= 0.15) {
              this.resumeQueuedWaypoint(unit);
            } else {
              unit.patrolX = unit.targetX;
              unit.patrolY = unit.targetY;
              unit.targetX = nextX;
              unit.targetY = nextY;
            }
          }
        }
      }

      // Attack combat handling
      if (unit.actionState === 'ATTACKING' && unit.targetEntityId) {
        this.processUnitCombat(unit, deltaTime);
      }

      // Harvesting handling
      if (unit.actionState === 'HARVESTING' && unit.targetEntityId) {
        this.processUnitHarvest(unit, deltaTime);
      }

      // CMD-05: signing a villager up to the crew once it reaches the site, and
      // dropping the order when the foundation is finished or gone.
      if (unit.actionState === 'BUILDING') {
        this.processUnitBuilding(unit);
      }
    });
  }

  /**
   * Creates a finished unit at the building's front door and, if the building
   * has a rally point, sends it walking there immediately (CTL-06).
   *
   * The spawn tile itself stays IDLE rather than MOVING-to-itself: the movement
   * pass would zero the distance and drop it back to IDLE one tick later anyway,
   * and the flag/waypoint UI would flicker in between.
   */
  private spawnTrainedUnit(building: BuildingState, unitType: UnitType) {
    const ownerId = building.ownerId;
    const x = building.gridX;
    const y = building.gridY + building.sizeY;
    const blueprint = UNIT_BLUEPRINTS[unitType];
    const uId = `u_${++this.nextEntityId}`;
    const unit = new UnitState();
    unit.id = uId;
    unit.ownerId = ownerId;
    unit.type = unitType;
    unit.x = Math.max(0, Math.min(MAP_GRID_WIDTH - 1, x));
    unit.y = Math.max(0, Math.min(MAP_GRID_HEIGHT - 1, y));
    unit.targetX = unit.x;
    unit.targetY = unit.y;
    unit.speed = blueprint.speed;
    unit.hp = blueprint.maxHp;
    unit.maxHp = blueprint.maxHp;
    unit.actionState = 'IDLE';

    if (building.rallyX >= 0 && building.rallyY >= 0) {
      const rallyX = Math.max(0, Math.min(MAP_GRID_WIDTH - 1, building.rallyX));
      const rallyY = Math.max(0, Math.min(MAP_GRID_HEIGHT - 1, building.rallyY));
      // A rally point on the spawn tile needs no order; anything else does.
      if (rallyX !== unit.x || rallyY !== unit.y) {
        unit.targetX = rallyX;
        unit.targetY = rallyY;
        unit.actionState = 'MOVING';
      }
    }

    this.state.units.set(uId, unit);
    this.updatePlayerPopulation(ownerId);
  }

  private processUnitCombat(unit: UnitState, deltaTime: number) {
    const blueprint = UNIT_BLUEPRINTS[unit.type as UnitType];
    if (!blueprint) return;

    const timerKey = `atk_${unit.id}`;
    let remainingCooldown = this.attackTimers.get(timerKey) || 0;
    remainingCooldown -= deltaTime;

    if (remainingCooldown <= 0) {
      if (unit.targetEntityType === 'unit') {
        const targetUnit = this.state.units.get(unit.targetEntityId);
        if (targetUnit && targetUnit.ownerId !== unit.ownerId) {
          const dist = Math.hypot(targetUnit.x - unit.x, targetUnit.y - unit.y);
          if (dist <= blueprint.attackRange + 0.5) {
            targetUnit.hp -= blueprint.attackPower;
            this.attackTimers.set(timerKey, blueprint.attackCooldownMs);

            if (targetUnit.hp <= 0) {
              const victimOwner = targetUnit.ownerId;
              this.state.units.delete(targetUnit.id);
              // Transient harvest state must not outlive the unit.
              this.harvestTypeByUnit.delete(targetUnit.id);
              this.updatePlayerPopulation(victimOwner);
              this.endAttackOrder(unit);
            }
          }
        } else {
          // Target died or changed hands: the order is over.
          this.endAttackOrder(unit);
        }
      } else if (unit.targetEntityType === 'building') {
        const targetBuilding = this.state.buildings.get(unit.targetEntityId);
        if (targetBuilding && targetBuilding.ownerId !== unit.ownerId) {
          const centerX = targetBuilding.gridX + targetBuilding.sizeX / 2;
          const centerY = targetBuilding.gridY + targetBuilding.sizeY / 2;
          const dist = Math.hypot(centerX - unit.x, centerY - unit.y);
          if (dist <= blueprint.attackRange + 1.5) {
            targetBuilding.hp -= blueprint.attackPower;
            this.attackTimers.set(timerKey, blueprint.attackCooldownMs);

            if (targetBuilding.hp <= 0) {
              const bOwner = targetBuilding.ownerId;
              this.state.buildings.delete(targetBuilding.id);
              this.updatePlayerPopulation(bOwner);
              this.endAttackOrder(unit);
            }
          }
        } else {
          // Building destroyed or captured by its owner: order over.
          this.endAttackOrder(unit);
        }
      }
    } else {
      this.attackTimers.set(timerKey, remainingCooldown);
    }
  }

  /**
   * Finds the closest node of `resourceType` within `radius` tiles of the unit.
   * Depleted nodes are skipped: a node can linger for a tick between its last
   * harvest and the delete, and sending a villager there would strand it.
   */
  private findNearestResource(unit: UnitState, resourceType: string, radius: number): ResourceNodeState | null {
    let nearest: ResourceNodeState | null = null;
    let nearestDist = radius;

    this.state.resourceNodes.forEach((node: ResourceNodeState) => {
      if (node.resourceType !== resourceType || node.remainingAmount <= 0) return;
      const dist = Math.hypot(node.gridX - unit.x, node.gridY - unit.y);
      if (dist <= nearestDist) {
        nearest = node;
        nearestDist = dist;
      }
    });

    return nearest;
  }

  /**
   * Moves a villager onto the nearest node of the type it was already gathering
   * (CMD-06). Without this the villager stood still as IDLE the moment its node
   * ran dry, which in a forest meant it stopped for good a few tiles from the
   * next tree.
   *
   * Only applies when the unit has no queued waypoints: those are explicit
   * player orders and outrank an automatic retarget.
   *
   * @returns `true` when a new node was assigned.
   */
  private retargetHarvest(unit: UnitState): boolean {
    if (unit.queueTargetX.length > 0) return false;

    const resourceType = this.harvestTypeByUnit.get(unit.id);
    if (!resourceType) return false;

    const node = this.findNearestResource(unit, resourceType, HARVEST_RETARGET_RADIUS);
    if (!node) return false;

    unit.targetEntityId = node.id;
    unit.targetEntityType = 'resource';
    unit.targetX = node.gridX;
    unit.targetY = node.gridY;
    unit.actionState = 'HARVESTING';
    return true;
  }

  private processUnitHarvest(unit: UnitState, deltaTime: number) {
    const resource = this.state.resourceNodes.get(unit.targetEntityId);
    if (!resource) {
      // Another villager may have emptied this node while this one was walking
      // to it. Retry a neighbour of the same type before giving up.
      if (!this.retargetHarvest(unit)) {
        this.harvestTypeByUnit.delete(unit.id);
        this.resumeQueuedWaypoint(unit);
      }
      return;
    }

    // Re-seed after a restart, where the order was restored but the transient
    // map was not, so the unit can still retarget instead of stopping.
    if (!this.harvestTypeByUnit.has(unit.id)) {
      this.harvestTypeByUnit.set(unit.id, resource.resourceType);
    }

    const dist = Math.hypot(resource.gridX - unit.x, resource.gridY - unit.y);
    if (dist <= 1.5) {
      const timerKey = `harv_${unit.id}`;
      let harvestTimer = this.harvestTimers.get(timerKey) || 0;
      harvestTimer += deltaTime;

      // Harvest interval every 1 second
      if (harvestTimer >= 1000) {
        harvestTimer = 0;
        const player = this.state.players.get(unit.ownerId);
        if (player) {
          const harvestAmount = Math.min(10, resource.remainingAmount);
          resource.remainingAmount -= harvestAmount;

          if (resource.resourceType === 'wood') player.wood += harvestAmount;
          else if (resource.resourceType === 'food') player.food += harvestAmount;
          else if (resource.resourceType === 'gold') player.gold += harvestAmount;
          else if (resource.resourceType === 'stone') player.stone += harvestAmount;

          if (resource.remainingAmount <= 0) {
            this.state.resourceNodes.delete(resource.id);
            // AoE behaviour: keep working by walking to the next node of the
            // same type instead of standing idle next to an empty stump.
            if (!this.retargetHarvest(unit)) {
              this.harvestTypeByUnit.delete(unit.id);
              this.resumeQueuedWaypoint(unit);
            }
          }
        }
      }
      this.harvestTimers.set(timerKey, harvestTimer);
    }
  }

  private updatePlayerPopulation(ownerId: string) {
    const player = this.state.players.get(ownerId);
    if (!player) return;

    let unitCount = 0;
    this.state.units.forEach((u: UnitState) => {
      if (u.ownerId === ownerId) unitCount++;
    });

    let totalCap = INITIAL_POPULATION_CAP;
    this.state.buildings.forEach((b: BuildingState) => {
      if (b.ownerId === ownerId && b.isConstructed) {
        const bp = BUILDING_BLUEPRINTS[b.type as BuildingType];
        if (bp) {
          totalCap += bp.populationProvided;
        }
      }
    });

    player.population = unitCount;
    player.populationCap = Math.min(200, totalCap);
  }

  async onLeave(client: Client, code?: number) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.isOnline = false;
      console.log(`[WorldRoom] Player ${player.name} left. Saving empire to SQLite...`);

      const ownedB: BuildingState[] = [];
      this.state.buildings.forEach((b: BuildingState) => {
        if (b.ownerId === client.sessionId) ownedB.push(b);
      });
      const ownedU: UnitState[] = [];
      this.state.units.forEach((u: UnitState) => {
        if (u.ownerId === client.sessionId) ownedU.push(u);
      });

      await DatabaseService.savePlayerEmpire(player, ownedB, ownedU);
      this.state.players.delete(client.sessionId);
    }
  }

  async onDispose() {
    console.log('🛑 [WorldRoom] Room disposing. Executing final SQLite database flush...');
    await DatabaseService.saveFullWorldState(this.state);
  }
}
