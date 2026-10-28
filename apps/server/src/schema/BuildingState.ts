import { Schema, type, ArraySchema } from '@colyseus/schema';

export class BuildingState extends Schema {
  @type('string') id: string = '';
  @type('string') ownerId: string = '';
  @type('string') type: string = 'TOWN_CENTER';
  @type('number') gridX: number = 0;
  @type('number') gridY: number = 0;
  @type('number') sizeX: number = 2;
  @type('number') sizeY: number = 2;
  @type('number') hp: number = 1000;
  @type('number') maxHp: number = 1000;
  @type('boolean') isConstructed: boolean = true;
  @type('number') constructionProgress: number = 100;
  @type(['string']) trainingQueue = new ArraySchema<string>();
  @type('number') trainingProgressMs: number = 0;
}

