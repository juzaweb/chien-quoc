import { Schema, type } from '@colyseus/schema';
import { INITIAL_PLAYER_RESOURCES, INITIAL_POPULATION_CAP } from '@chien-quoc/shared';

export class PlayerState extends Schema {
  @type('string') id: string = '';
  @type('string') name: string = 'Player';
  @type('string') color: string = '#3b82f6';
  @type('number') wood: number = INITIAL_PLAYER_RESOURCES.wood;
  @type('number') food: number = INITIAL_PLAYER_RESOURCES.food;
  @type('number') gold: number = INITIAL_PLAYER_RESOURCES.gold;
  @type('number') stone: number = INITIAL_PLAYER_RESOURCES.stone;
  @type('number') population: number = 0;
  @type('number') populationCap: number = INITIAL_POPULATION_CAP;
  @type('boolean') isOnline: boolean = true;
}

