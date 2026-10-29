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
      // 1. Load resources from SQLite
      const savedResources = await DatabaseService.loadResources();
      if (savedResources && savedResources.length > 0) {
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
        this.generateWorldResources();
        const resArray: ResourceNodeState[] = [];
        this.state.resourceNodes.forEach((node: ResourceNodeState) => resArray.push(node));
        await DatabaseService.saveAllResources(resArray);
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
    // Generate scattered forests, gold mines, stone quarries, berry bushes
    const clusters = [
      { type: 'TREE', res: 'wood', amount: 200, count: 60 },
      { type: 'GOLD_MINE', res: 'gold', amount: 800, count: 18 },
      { type: 'STONE_MINE', res: 'stone', amount: 600, count: 14 },
      { type: 'BERRY_BUSH', res: 'food', amount: 150, count: 24 }
    ];

    for (const cluster of clusters) {
      for (let i = 0; i < cluster.count; i++) {
        const id = `res_${++this.nextEntityId}`;
        const node = new ResourceNodeState();
        node.id = id;
        node.type = cluster.type;
        node.resourceType = cluster.res;
        node.gridX = Math.floor(4 + Math.random() * (MAP_GRID_WIDTH - 8));
        node.gridY = Math.floor(4 + Math.random() * (MAP_GRID_HEIGHT - 8));
        node.remainingAmount = cluster.amount;
        node.maxAmount = cluster.amount;

        // Check tile occupancy
        let occupied = false;
        this.state.resourceNodes.forEach((existing: ResourceNodeState) => {
          if (existing.gridX === node.gridX && existing.gridY === node.gridY) {
            occupied = true;
          }
        });

        if (!occupied) {
          this.state.resourceNodes.set(id, node);
        }
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

    // Find a clear area for spawn
    let spawnX = 10 + Math.floor(Math.random() * (MAP_GRID_WIDTH - 20));
    let spawnY = 10 + Math.floor(Math.random() * (MAP_GRID_HEIGHT - 20));

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

    // Spawn 3 starter villagers near Town Center
    const villagerOffsets = [
      { dx: 3, dy: 1 },
      { dx: 1, dy: 3 },
      { dx: 3, dy: 2 }
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
