import { Schema, type } from '@colyseus/schema';

export class ResourceNodeState extends Schema {
  @type('string') id: string = '';
  @type('string') type: string = 'TREE';
  @type('string') resourceType: string = 'wood';
  @type('number') gridX: number = 0;
  @type('number') gridY: number = 0;
  @type('number') remainingAmount: number = 100;
  @type('number') maxAmount: number = 100;
}

