import { Room, Client, ServerError, ErrorCode } from '@colyseus/core';
import { DatabaseService } from '../services/DatabaseService.js';
import { AuthService } from '../services/AuthService.js';
import {
  BUILDING_BLUEPRINTS,
  BuildingType,
  INITIAL_POPULATION_CAP,
  MAX_POPULATION_LIMIT,
  MAP_GRID_HEIGHT,
  MAP_GRID_WIDTH,
  NetworkMessage,
  PlaceBuildingPayload,
  MoveUnitsPayload,
  TrainUnitPayload,
  AttackTargetPayload,
  AttackMovePayload,
  BuildTargetPayload,
  HarvestResourcePayload,
  StopUnitsPayload,
  SetRallyPointPayload,
  SetStancePayload,
  CancelTrainPayload,
  CancelBuildingPayload,
  SERVER_TICK_RATE,
  UNIT_BLUEPRINTS,
  UnitType,
  isDirtRoadTile
} from '@chien-quoc/shared';
import { WorldState } from '../schema/WorldState.js';
import { PlayerState } from '../schema/PlayerState.js';
import { BuildingState } from '../schema/BuildingState.js';
import { UnitState } from '../schema/UnitState.js';
import { ResourceNodeState } from '../schema/ResourceNodeState.js';
import { isWithinBuildRange, syncBuilders } from './construction.js';
import { seedGatheredBuilding } from './gatherables.js';
import { EconomySystem } from './EconomySystem.js';
import { CombatSystem } from './CombatSystem.js';
import { CommandSystem } from './CommandSystem.js';
import { MovementSystem } from './MovementSystem.js';
import { ownerIdOf, RoomAuth } from './identity.js';

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

export class WorldRoom extends Room<{ state: WorldState }> {
  private nextEntityId: number = 1000;
  /**
   * Combat rules (damage, cooldowns, target resolution) and their transient
   * maps. Built on first use for the same reason as {@link economySystem}.
   */
  private combatSystem: CombatSystem | null = null;
  /** Built on first use; see {@link combatSystem}. */
  private get combat(): CombatSystem {
    this.combatSystem ??= new CombatSystem(this.state, {
      resumeQueuedWaypoint: (unit) => this.movement.resumeQueuedWaypoint(unit),
      forgetEconomyState: (unitId) => this.economy.forgetUnit(unitId),
      forgetMovementState: (unitId) => this.movement.forgetUnit(unitId),
      updatePlayerPopulation: (ownerId) => this.updatePlayerPopulation(ownerId)
    });
    return this.combatSystem;
  }
  /**
   * Command handlers (one per client message) and the validation they share.
   * Built on first use for the same reason as {@link economySystem}.
   */
  private commandSystem: CommandSystem | null = null;
  /** Built on first use; see {@link commandSystem}. */
  private get commands(): CommandSystem {
    this.commandSystem ??= new CommandSystem(this.state, {
      rejectCommand: (client, message) => this.rejectCommand(client, message),
      setWalkTarget: (unit, x, y) => this.movement.setWalkTarget(unit, x, y),
      advanceQueuedWaypoint: (unit) => this.movement.advanceQueuedWaypoint(unit),
      clearHarvestOrder: (unitId) => this.economy.clearHarvestOrder(unitId),
      forgetBuilding: (buildingId) => this.combat.forgetBuilding(buildingId),
      harvestOrder: (client, payload) => this.economy.handleHarvestOrder(client, payload),
      allocateEntityId: () => ++this.nextEntityId,
      updatePlayerPopulation: (ownerId) => this.updatePlayerPopulation(ownerId)
    });
    return this.commandSystem;
  }
  /**
   * Routing, waypoint queues and the blocked-tile cache (SIM-01, CTL-05). Needs
   * no ports: it only mutates the units it is handed. Built on first use for the
   * same reason as {@link economySystem}.
   */
  private movementSystem: MovementSystem | null = null;
  /** Built on first use; see {@link movementSystem}. */
  private get movement(): MovementSystem {
    this.movementSystem ??= new MovementSystem(this.state);
    return this.movementSystem;
  }
  /**
   * Economy rules (gathering, carrying, drop-off) and their transient maps.
   *
   * Built on first use rather than in a field initialiser: `this.state` only
   * exists after `onCreate()` — or after `setState()` in tests — so constructing
   * it early would capture `undefined`.
   */
  private economySystem: EconomySystem | null = null;
  /** Built on first use; see {@link economySystem}. */
  private get economy(): EconomySystem {
    this.economySystem ??= new EconomySystem(this.state, {
      setWalkTarget: (unit, x, y) => this.movement.setWalkTarget(unit, x, y),
      resumeQueuedWaypoint: (unit) => this.movement.resumeQueuedWaypoint(unit),
      rejectCommand: (client, message) => this.rejectCommand(client, message)
    });
    return this.economySystem;
  }

  private readyPromise: Promise<void> | null = null;
  private worldRestoreError: Error | null = null;

  /**
   * The session currently driving each account.
   *
   * One account owns one empire, so one entry per account is enough: a join
   * replaces the entry, and a socket that has been superseded can no longer
   * remove the player or persist a stale snapshot when it finally closes.
   */
  private readonly activeSessionByUser = new Map<string, string>();

  onCreate(options: any) {
    this.setState(new WorldState());

    // Keep a reference so onJoin can wait until the persisted world is restored.
    // Without this, a client could join while state.buildings is still empty and
    // spawn a duplicate randomly-positioned base.
    this.readyPromise = this.initializeWorldPersistence();

    // Setup network message listeners
    this.onMessage(NetworkMessage.PLACE_BUILDING, (client, message: PlaceBuildingPayload) => {
      this.commands.handlePlaceBuilding(client, message);
    });

    this.onMessage(NetworkMessage.MOVE_UNITS, (client, message: MoveUnitsPayload) => {
      this.commands.handleMoveUnits(client, message);
    });

    this.onMessage(NetworkMessage.TRAIN_UNIT, (client, message: TrainUnitPayload) => {
      this.commands.handleTrainUnit(client, message);
    });

    this.onMessage(NetworkMessage.ATTACK_TARGET, (client, message: AttackTargetPayload) => {
      this.commands.handleAttackTarget(client, message);
    });

    this.onMessage(NetworkMessage.ATTACK_MOVE, (client, message: AttackMovePayload) => {
      this.commands.handleAttackMove(client, message, 'ATTACK_MOVE');
    });

    this.onMessage(NetworkMessage.PATROL, (client, message: AttackMovePayload) => {
      this.commands.handleAttackMove(client, message, 'PATROL');
    });

    this.onMessage(NetworkMessage.BUILD_TARGET, (client, message: BuildTargetPayload) => {
      this.commands.handleBuildTarget(client, message);
    });

    this.onMessage(NetworkMessage.HARVEST_RESOURCE, (client, message: HarvestResourcePayload) => {
      this.commands.handleHarvestResource(client, message);
    });

    this.onMessage(NetworkMessage.STOP_UNITS, (client, message: StopUnitsPayload) => {
      this.commands.handleStopUnits(client, message);
    });

    this.onMessage(NetworkMessage.SET_RALLY_POINT, (client, message: SetRallyPointPayload) => {
      this.commands.handleSetRallyPoint(client, message);
    });

    this.onMessage(NetworkMessage.SET_STANCE, (client, message: SetStancePayload) => {
      this.commands.handleSetStance(client, message);
    });

    this.onMessage(NetworkMessage.CANCEL_TRAIN, (client, message: CancelTrainPayload) => {
      this.commands.handleCancelTrain(client, message);
    });

    this.onMessage(NetworkMessage.CANCEL_BUILDING, (client, message: CancelBuildingPayload) => {
      this.commands.handleCancelBuilding(client, message);
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
          building.ownerId = p.id;
          building.type = b.type;
          building.gridX = b.gridX;
          building.gridY = b.gridY;
          building.sizeX = b.sizeX;
          building.sizeY = b.sizeY;
          building.hp = b.hp;
          building.maxHp = b.maxHp;
          building.isConstructed = b.isConstructed;
          building.constructionProgress = b.constructionProgress;

          // ECO-01: restored as a finished building, so a field comes back full
          // instead of permanently barren (see `seedGatheredBuilding`).
          if (b.isConstructed) seedGatheredBuilding(building);

          this.state.buildings.set(b.id, building);
        }

        for (const u of p.units) {
          const unit = new UnitState();
          unit.id = u.id;
          unit.ownerId = p.id;
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
   * Every building and unit owned by `ownerId`.
   *
   * Ownership is a single id now, so this is a plain filter — it is used to
   * count an empire on join and to build the snapshot saved on leave.
   */
  private ownedBy(ownerId: string): { buildings: BuildingState[]; units: UnitState[] } {
    const buildings: BuildingState[] = [];
    this.state.buildings.forEach((b: BuildingState) => {
      if (b.ownerId === ownerId) buildings.push(b);
    });

    const units: UnitState[] = [];
    this.state.units.forEach((u: UnitState) => {
      if (u.ownerId === ownerId) units.push(u);
    });

    return { buildings, units };
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
  static async onAuth(token: string | undefined): Promise<RoomAuth> {
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
    // token, so the account id is the only ownership key. There is deliberately
    // no fallback to `options.playerName`: a client-supplied name would let a
    // player join as somebody else's empire.
    const authUser = client.auth as Partial<RoomAuth> | undefined;
    if (!authUser?.userId || !authUser.displayName) {
      throw new Error('Cannot join without an authenticated account.');
    }
    const ownerId = authUser.userId;
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

      // Check if this account already has a saved profile in the database
      const savedProfile = await DatabaseService.loadPlayerProfile(ownerId);
      // Entities restored on boot are already owned by `ownerId`, so a rejoin
      // finds its empire in memory and must not spawn a second base next to it.
      const owned = this.ownedBy(ownerId);

      const player = new PlayerState();
      player.id = ownerId;
      player.name = playerName;

      if (savedProfile) {
        player.color = savedProfile.color;
        player.wood = savedProfile.wood;
        player.food = savedProfile.food;
        player.gold = savedProfile.gold;
        player.stone = savedProfile.stone;
        player.population = savedProfile.population;
        player.populationCap = savedProfile.populationCap;
      } else {
        const playerIndex = this.state.players.size % PLAYER_COLORS.length;
        player.color = PLAYER_COLORS[playerIndex];
      }
      player.isOnline = true;

      // One entry per account: a refresh or second tab replaces the session that
      // drives it, it never adds a second player.
      this.state.players.set(ownerId, player);
      this.activeSessionByUser.set(ownerId, client.sessionId);

      if (owned.buildings.length === 0 && owned.units.length === 0) {
        if (savedProfile) {
          console.log(`[WorldRoom] Player ${playerName} has no remaining units/buildings. Spawning starter base.`);
        }
        // Spawn initial base: Town Center + 3 starting Villagers
        this.spawnInitialBase(ownerId);
      }

      this.updatePlayerPopulation(ownerId);

      if (!savedProfile) {
        console.log(`⚔️ [WorldRoom] New Emperor ${playerName} (${ownerId}) joined.`);
        // Persist new empire immediately to DB
        const newEmpire = this.ownedBy(ownerId);
        await DatabaseService.savePlayerEmpire(player, newEmpire.buildings, newEmpire.units);
      } else {
        console.log(`🏰 [WorldRoom] Welcome back Emperor ${playerName}! Empire restored from SQLite.`);
      }
    } catch (err) {
      console.error(`❌ [WorldRoom] Error joining player ${playerName}:`, err);
    }
  }

  private spawnInitialBase(ownerId: string) {
    const player = this.state.players.get(ownerId);
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
    townCenter.ownerId = ownerId;
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
      villager.ownerId = ownerId;
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

    this.updatePlayerPopulation(ownerId);
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
      this.movement.resumeQueuedWaypoint(unit);
      return;
    }

    if (!isWithinBuildRange(unit, building)) return;

    if (!building.builderUnitIds.includes(unit.id)) {
      building.builderUnitIds.push(unit.id);
    }
  }

  /** Notify a client that a command was refused, so the UI can explain why. */
  rejectCommand(client: Client, message: string) {
    client.send(NetworkMessage.ERROR_NOTIFICATION, { message });
  }

  private update(deltaTime: number) {
    const dtSeconds = deltaTime / 1000;

    // SIM-01: hand out a few routes before anyone moves. Units whose request is
    // still queued keep walking straight, which is exactly the pre-SIM-01
    // behaviour, so a delayed route is never worse than no pathfinding.
    this.movement.processPendingPaths();

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
          // ECO-01: a finished field starts full. A foundation holds nothing, so
          // this is also what makes "farm still under construction" true on the
          // server side of a harvest order.
          seedGatheredBuilding(building);
          // The crew is done; every builder drops back to idle on its next tick
          // (see `processUnitBuilding`), and the roster must not outlive the site.
          building.builderUnitIds.clear();
          this.updatePlayerPopulation(building.ownerId);
        }
      }

      // SIM-03: a finished defensive building shoots at whatever enemy comes
      // inside its range. Foundations are defenceless until they are done.
      if (building.isConstructed) {
        const attackBlueprint = BUILDING_BLUEPRINTS[building.type as BuildingType];
        if (attackBlueprint && attackBlueprint.attackRange > 0) {
          this.combat.updateTowerCombat(building, deltaTime, attackBlueprint);
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
      // for the closest enemy inside its aggro radius.
      this.combat.acquireAggroTarget(unit, blueprint.aggroRadius);

      // A fight whose target was destroyed, killed by someone else or simply
      // removed from the snapshot resumes the stored order instead of leaving the
      // unit standing with a dangling target id. ATTACKING with no target at all
      // is the same dead end, so it takes the same exit.
      if (unit.actionState === 'ATTACKING' && !this.combat.isTargetAlive(unit)) {
        this.combat.endAttackOrder(unit);
      }

      // SIM-01 follow-up: a route computed before a building appeared runs
      // straight through it, so a blocked next tile drops the route and asks for
      // a new one before the unit takes the step.
      this.movement.refreshRouteIfBlocked(unit);

      // Movement handling
      if (
        unit.actionState === 'MOVING' ||
        unit.actionState === 'HARVESTING' ||
        unit.actionState === 'ATTACKING' ||
        unit.actionState === 'ATTACK_MOVE' ||
        unit.actionState === 'PATROL' ||
        unit.actionState === 'BUILDING' ||
        unit.actionState === 'RETURNING'
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

          // CMB-01: a stand-ground unit, or a defensive one that has been dragged
          // past its leash, does not take the step. Zeroing the destination keeps
          // the movement branch below untouched: dist is 0, so nothing moves,
          // while `updateUnitCombat` still lands hits on anything already in range.
          if (!this.combat.canChaseTarget(unit)) {
            destinationX = unit.x;
            destinationY = unit.y;
          }
        }

        // SIM-01: follow the computed route while it lasts. A route ends on the
        // goal tile, whose centre can sit up to half a tile from the click
        // point, so the last stretch is walked straight to `targetX/targetY`.
        if (unit.actionState !== 'ATTACKING' && unit.pathX.length > 0) {
          destinationX = unit.pathX[0];
          destinationY = unit.pathY[0];
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
        } else if (unit.actionState !== 'ATTACKING' && unit.pathX.length > 0) {
          // Reached an intermediate tile: drop it and head for the next one on
          // the following tick. The order only completes when the path is spent.
          unit.pathX.shift();
          unit.pathY.shift();
        } else {
          if (unit.actionState === 'MOVING' || unit.actionState === 'ATTACK_MOVE') {
            // Arrived: walk on to the next queued waypoint if there is one. An
            // attack-move ends here (IDLE), like in AoE.
            this.movement.resumeQueuedWaypoint(unit);
          } else if (unit.actionState === 'PATROL') {
            // Reached one end of the route: swap the endpoints and head back. A
            // route whose ends collapse onto the same tile would otherwise ping
            // pong every tick, so it ends instead.
            const nextX = unit.patrolX;
            const nextY = unit.patrolY;
            if (Math.hypot(nextX - unit.x, nextY - unit.y) <= 0.15) {
              this.movement.resumeQueuedWaypoint(unit);
            } else {
              unit.patrolX = unit.targetX;
              unit.patrolY = unit.targetY;
              this.movement.setWalkTarget(unit, nextX, nextY);
            }
          }
        }
      }

      // Attack combat handling
      if (unit.actionState === 'ATTACKING' && unit.targetEntityId) {
        this.combat.updateUnitCombat(unit, deltaTime);
      }

      // Harvesting and carrying (CMD-06 / SIM-02)
      if (unit.actionState === 'HARVESTING' && unit.targetEntityId) {
        this.economy.updateUnit(unit, deltaTime);
      }

      // CMD-05: signing a villager up to the crew once it reaches the site, and
      // dropping the order when the foundation is finished or gone.
      if (unit.actionState === 'BUILDING') {
        this.processUnitBuilding(unit);
      }

      // SIM-02: banking the load once the walk back to the drop-off is done.
      if (unit.actionState === 'RETURNING') {
        this.economy.updateUnit(unit, deltaTime);
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
        this.movement.setWalkTarget(unit, rallyX, rallyY);
        unit.actionState = 'MOVING';
      }
    }

    this.state.units.set(uId, unit);
    this.updatePlayerPopulation(ownerId);
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
    player.populationCap = Math.min(MAX_POPULATION_LIMIT, totalCap);
  }

  async onLeave(client: Client, code?: number) {
    const ownerId = ownerIdOf(client);
    const player = this.state.players.get(ownerId);
    if (!player) return;

    // A refresh opens the new session before this socket is cleaned up, and that
    // new session already drives the account. Dropping the player entry here
    // would remove the live session's empire from the snapshot, so a superseded
    // socket only closes itself.
    if (this.activeSessionByUser.get(ownerId) !== client.sessionId) {
      console.log(
        `[WorldRoom] Player ${player.name} still has a live session; keeping the empire in place.`
      );
      return;
    }

    this.activeSessionByUser.delete(ownerId);
    this.state.players.delete(ownerId);
    player.isOnline = false;
    console.log(`[WorldRoom] Player ${player.name} left. Saving empire to SQLite...`);

    // The empire is owned by the account id, which is what this leave is about:
    // the snapshot below is the whole current empire, never an empty list that
    // `savePlayerEmpire` would turn into a delete of every row.
    const owned = this.ownedBy(ownerId);

    await DatabaseService.savePlayerEmpire(player, owned.buildings, owned.units);
  }

  async onDispose() {
    console.log('🛑 [WorldRoom] Room disposing. Executing final SQLite database flush...');
    await DatabaseService.saveFullWorldState(this.state);
  }
}
