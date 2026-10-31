import { Schema, type, ArraySchema } from '@colyseus/schema';

export class UnitState extends Schema {
  @type('string') id: string = '';
  @type('string') ownerId: string = '';
  @type('string') type: string = 'VILLAGER';
  @type('number') x: number = 0; // Grid X continuous coordinate
  @type('number') y: number = 0; // Grid Y continuous coordinate
  @type('number') targetX: number = 0;
  @type('number') targetY: number = 0;
  @type('number') speed: number = 2.0;
  @type('number') hp: number = 50;
  @type('number') maxHp: number = 50;
  @type('string') actionState: string = 'IDLE'; // IDLE, MOVING, ATTACKING, HARVESTING, ATTACK_MOVE, PATROL, BUILDING
  // CMB-01: AGGRESSIVE | DEFENSIVE | STAND_GROUND | NO_ATTACK. Defaults to the
  // AoE2 default and is deliberately not persisted: a restart returns every unit
  // to aggressive, which the player can correct with one key press.
  @type('string') stance: string = 'AGGRESSIVE';
  @type('string') targetEntityId: string = '';
  @type('string') targetEntityType: string = ''; // 'unit' | 'building' | 'resource'
  @type('string') carryingResourceType: string = '';
  @type('number') carryingAmount: number = 0;
  // CTL-05: future waypoints, consumed one per arrival. Kept in two parallel
  // arrays because Colyseus cannot replicate an array of objects without a
  // dedicated Schema per waypoint.
  @type(['number']) queueTargetX = new ArraySchema<number>();
  @type(['number']) queueTargetY = new ArraySchema<number>();
  // CMD-01: the order a unit was executing before it broke off to fight. Empty
  // for a plain ATTACK_TARGET, which has nothing to return to.
  @type('string') previousActionState: string = '';
  // CMD-01: the far end of a PATROL route. targetX/targetY hold the end the unit
  // is currently walking towards; these two swap on every arrival.
  @type('number') patrolX: number = 0;
  @type('number') patrolY: number = 0;
  // SIM-01: remaining tiles of the current route, in walking order. Empty means
  // "no route" and the unit walks the straight line to targetX/targetY, which is
  // also the fallback when A* finds nothing. Recomputed per order, never per tick.
  @type(['number']) pathX = new ArraySchema<number>();
  @type(['number']) pathY = new ArraySchema<number>();
  // SIM-02: the building this unit is walking its load to. `targetEntityId` keeps
  // pointing at the resource node so the unit knows where to go back to.
  @type('string') dropOffId: string = '';
}

