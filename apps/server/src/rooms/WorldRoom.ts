import { Room, Client } from '@colyseus/core';
import { DatabaseService } from '../services/DatabaseService.js';
import {
  BUILDING_BLUEPRINTS,
  BuildingBlueprint,
  BuildingType,
  INITIAL_POPULATION_CAP,
  MAP_GRID_HEIGHT,
  MAP_GRID_WIDTH,
  NetworkMessage,
  POPULATION_PER_HOUSE,
  PlaceBuildingPayload,
  MoveUnitsPayload,
  TrainUnitPayload,
  AttackTargetPayload,
  HarvestResourcePayload,
  SERVER_TICK_RATE,
  UNIT_BLUEPRINTS,
  UnitBlueprint,
  UnitType
} from '@chien-quoc/shared';
import { WorldState } from '../schema/WorldState.js';
import { PlayerState } from '../schema/PlayerState.js';
import { BuildingState } from '../schema/BuildingState.js';
import { UnitState } from '../schema/UnitState.js';
import { ResourceNodeState } from '../schema/ResourceNodeState.js';

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
  private attackTimers: Map<string, number> = new Map();
  private harvestTimers: Map<string, number> = new Map();

  onCreate(options: any) {
    this.setState(new WorldState());
    this.initializeWorldPersistence();

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

    this.onMessage(NetworkMessage.HARVEST_RESOURCE, (client, message: HarvestResourcePayload) => {
      this.handleHarvestResource(client, message);
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
      const maxStoredCoord = (savedResources || []).reduce((max, r) => Math.max(max, r.gridX, r.gridY), 0);
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
    } catch (err) {
      console.error('❌ [WorldRoom] Failed to initialize persistence:', err);
    }
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

  async onJoin(client: Client, options: any) {
    const playerName = (options && options.playerName) || `Emperor_${client.sessionId.substring(0, 4)}`;

    try {
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

    // Find a clear area for spawn across large map
    let spawnX = 20 + Math.floor(Math.random() * (MAP_GRID_WIDTH - 40));
    let spawnY = 20 + Math.floor(Math.random() * (MAP_GRID_HEIGHT - 40));

    // Create Town Center
    const tcBlueprint = BUILDING_BLUEPRINTS.TOWN_CENTER;
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
      const id = `res_${++this.nextEntityId}`;
      const node = new ResourceNodeState();
      node.id = id;
      node.type = 'TREE';
      node.resourceType = 'wood';
      node.gridX = spawnX + off.dx;
      node.gridY = spawnY + off.dy;
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
      const id = `res_${++this.nextEntityId}`;
      const node = new ResourceNodeState();
      node.id = id;
      node.type = 'BERRY_BUSH';
      node.resourceType = 'food';
      node.gridX = spawnX + off.dx;
      node.gridY = spawnY + off.dy;
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
    building.hp = Math.floor(blueprint.maxHp * 0.2); // Starts at 20% hp while building
    building.maxHp = blueprint.maxHp;
    building.isConstructed = false;
    building.constructionProgress = 0;

    this.state.buildings.set(buildingId, building);
    this.updatePlayerPopulation(client.sessionId);
  }

  private handleMoveUnits(client: Client, payload: MoveUnitsPayload) {
    if (!payload.unitIds || payload.unitIds.length === 0) return;

    payload.unitIds.forEach((uId, idx) => {
      const unit = this.state.units.get(uId);
      if (unit && unit.ownerId === client.sessionId) {
        // Form slight offset so units don't stack on exact same point
        const offsetX = (idx % 3) * 0.5;
        const offsetY = Math.floor(idx / 3) * 0.5;

        unit.targetX = Math.max(0, Math.min(MAP_GRID_WIDTH - 1, payload.targetGridX + offsetX));
        unit.targetY = Math.max(0, Math.min(MAP_GRID_HEIGHT - 1, payload.targetGridY + offsetY));
        unit.actionState = 'MOVING';
        unit.targetEntityId = '';
        unit.targetEntityType = '';
      }
    });
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

  private handleAttackTarget(client: Client, payload: AttackTargetPayload) {
    payload.unitIds.forEach((uId) => {
      const unit = this.state.units.get(uId);
      if (unit && unit.ownerId === client.sessionId) {
        unit.targetEntityId = payload.targetEntityId;
        unit.targetEntityType = payload.targetType;
        unit.actionState = 'ATTACKING';
      }
    });
  }

  private handleHarvestResource(client: Client, payload: HarvestResourcePayload) {
    const resource = this.state.resourceNodes.get(payload.resourceNodeId);
    if (!resource) return;

    payload.unitIds.forEach((uId) => {
      const unit = this.state.units.get(uId);
      if (unit && unit.ownerId === client.sessionId && unit.type === 'VILLAGER') {
        unit.targetEntityId = payload.resourceNodeId;
        unit.targetEntityType = 'resource';
        unit.targetX = resource.gridX;
        unit.targetY = resource.gridY;
        unit.actionState = 'HARVESTING';
      }
    });
  }

  private update(deltaTime: number) {
    const dtSeconds = deltaTime / 1000;

    // 1. Update construction and training queues for buildings
    this.state.buildings.forEach((building: BuildingState) => {
      if (!building.isConstructed) {
        building.constructionProgress += (dtSeconds * 100) / 5; // 5s build rate demo
        if (building.constructionProgress >= 100) {
          building.constructionProgress = 100;
          building.isConstructed = true;
          building.hp = building.maxHp;
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
          this.spawnTrainedUnit(building.ownerId, currentUnitType, building.gridX, building.gridY + building.sizeY);
        }
      }
    });

    // 2. Update units (movement, combat, harvesting)
    this.state.units.forEach((unit: UnitState) => {
      // Movement handling
      if (unit.actionState === 'MOVING' || unit.actionState === 'HARVESTING' || unit.actionState === 'ATTACKING') {
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
            } else {
              unit.actionState = 'IDLE';
              unit.targetEntityId = '';
            }
          } else if (unit.targetEntityType === 'building') {
            const targetBuilding = this.state.buildings.get(unit.targetEntityId);
            if (targetBuilding) {
              targetX = targetBuilding.gridX + targetBuilding.sizeX / 2;
              targetY = targetBuilding.gridY + targetBuilding.sizeY / 2;
            } else {
              unit.actionState = 'IDLE';
              unit.targetEntityId = '';
            }
          }
          destinationX = targetX;
          destinationY = targetY;
        }

        const dx = destinationX - unit.x;
        const dy = destinationY - unit.y;
        const dist = Math.hypot(dx, dy);

        const blueprint = UNIT_BLUEPRINTS[unit.type as UnitType];
        const attackRange = blueprint ? blueprint.attackRange : 1.2;

        const stopDist = unit.actionState === 'ATTACKING' ? attackRange : 0.15;

        if (dist > stopDist) {
          const moveStep = Math.min(dist, unit.speed * dtSeconds);
          unit.x += (dx / dist) * moveStep;
          unit.y += (dy / dist) * moveStep;
        } else {
          if (unit.actionState === 'MOVING') {
            unit.actionState = 'IDLE';
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
    });
  }

  private spawnTrainedUnit(ownerId: string, unitType: UnitType, x: number, y: number) {
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
              this.updatePlayerPopulation(victimOwner);
              unit.actionState = 'IDLE';
              unit.targetEntityId = '';
            }
          }
        } else {
          unit.actionState = 'IDLE';
          unit.targetEntityId = '';
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
              unit.actionState = 'IDLE';
              unit.targetEntityId = '';
            }
          }
        } else {
          unit.actionState = 'IDLE';
          unit.targetEntityId = '';
        }
      }
    } else {
      this.attackTimers.set(timerKey, remainingCooldown);
    }
  }

  private processUnitHarvest(unit: UnitState, deltaTime: number) {
    const resource = this.state.resourceNodes.get(unit.targetEntityId);
    if (!resource) {
      unit.actionState = 'IDLE';
      unit.targetEntityId = '';
      return;
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
            unit.actionState = 'IDLE';
            unit.targetEntityId = '';
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
