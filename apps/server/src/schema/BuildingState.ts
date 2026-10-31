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
  /** Rally point in grid coordinates; -1 on both axes means "not set". */
  @type('number') rallyX: number = -1;
  @type('number') rallyY: number = -1;
  /**
   * CMD-05: villagers currently putting work into this foundation. Rebuilt from
   * the units' own state every tick (`syncBuilders` in `rooms/construction.ts`
   * drops whoever walked away or was given a new order), so this is a view, not
   * the source of truth.
   */
  @type(['string']) builderUnitIds = new ArraySchema<string>();
  /**
   * ECO-01: what is left to gather from this building. Only farms use it today
   * (`BUILDING_BLUEPRINTS[type].gatheredResource`), and a farm at 0 is fallow
   * until somebody re-sows it. `resourceCapacity` is replicated too so the panel
   * can show a fraction without re-reading the blueprint on the client.
   */
  @type('number') resourceAmount: number = 0;
  @type('number') resourceCapacity: number = 0;
}

