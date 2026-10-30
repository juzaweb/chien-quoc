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
  @type('string') actionState: string = 'IDLE'; // IDLE, MOVING, ATTACKING, HARVESTING
  @type('string') targetEntityId: string = '';
  @type('string') targetEntityType: string = ''; // 'unit' | 'building' | 'resource'
  @type('string') carryingResourceType: string = '';
  @type('number') carryingAmount: number = 0;
  // CTL-05: future waypoints, consumed one per arrival. Kept in two parallel
  // arrays because Colyseus cannot replicate an array of objects without a
  // dedicated Schema per waypoint.
  @type(['number']) queueTargetX = new ArraySchema<number>();
  @type(['number']) queueTargetY = new ArraySchema<number>();
}

