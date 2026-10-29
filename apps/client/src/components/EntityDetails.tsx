import React from 'react';
import { SelectedEntityData } from '../game/scenes/WorldScene.js';
import {
  BUILDING_BLUEPRINTS,
  BuildingType,
  Resources,
  UNIT_BLUEPRINTS,
  UnitType
} from '@chien-quoc/shared';
import { Shield, Swords, UserPlus, Heart } from 'lucide-react';

interface EntityDetailsProps {
  entity: SelectedEntityData | null;
  playerResources: Resources;
  onTrainUnit: (buildingId: string, unitType: UnitType) => void;
}

export const EntityDetails: React.FC<EntityDetailsProps> = ({
  entity,
  playerResources,
  onTrainUnit
}) => {
  if (!entity) {
    return (
      <div className="aoe-panel w-72 h-36 p-3 rounded-lg flex flex-col items-center justify-center text-slate-500 text-xs italic pointer-events-auto">
        <Swords size={28} className="mb-2 text-slate-600 opacity-60" />
        Chọn lính, công trình hoặc tài nguyên để xem chi tiết
      </div>
    );
  }

  const buildingBp = entity.type === 'building' ? BUILDING_BLUEPRINTS[entity.subType as BuildingType] : null;
  const trainableUnits = buildingBp ? buildingBp.trainableUnits : [];

  return (
    <div className="aoe-panel w-80 min-h-[144px] p-3 rounded-lg flex flex-col gap-2 pointer-events-auto">
      {/* Header Info */}
      <div className="flex items-center justify-between border-b border-amber-800/40 pb-1.5">
        <div className="flex items-center gap-2">
          {entity.subType === 'VILLAGER' ? (
            <img
              src="/assets/units/villager_idle.png"
              alt="Villager"
              className="w-5 h-5 object-contain rounded bg-slate-900/80 border border-amber-500/50"
            />
          ) : (
            <div className="w-2.5 h-2.5 rounded-sm bg-amber-500" />
          )}
          <span className="font-medieval text-xs font-bold text-amber-300 truncate max-w-[170px]">
            {entity.name}
          </span>
        </div>
        <span className="text-[10px] text-slate-400 uppercase font-mono tracking-wider">
          {entity.type}
        </span>
      </div>

      {/* Health Bar (if applicable) */}
      {entity.hp !== undefined && entity.maxHp !== undefined && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-slate-300">
            <span className="flex items-center gap-1">
              <Heart size={12} className="text-red-400" /> Sinh lực (HP)
            </span>
            <span className="font-mono text-slate-200">
              {entity.hp} / {entity.maxHp}
            </span>
          </div>
          <div className="w-full h-2 rounded bg-slate-900 border border-slate-700 overflow-hidden">
            <div
              className={`h-full transition-all duration-200 ${
                entity.hp / entity.maxHp > 0.5
                  ? 'bg-emerald-500'
                  : entity.hp / entity.maxHp > 0.25
                  ? 'bg-amber-500'
                  : 'bg-red-500'
              }`}
              style={{ width: `${Math.max(0, Math.min(100, (entity.hp / entity.maxHp) * 100))}%` }}
            />
          </div>
        </div>
      )}

      {/* Resource Node Info */}
      {entity.remainingAmount !== undefined && (
        <div className="text-xs text-slate-300 space-y-1">
          <div className="flex justify-between">
            <span>Trữ lượng còn lại:</span>
            <span className="font-mono text-amber-400 font-bold">
              {entity.remainingAmount} / {entity.maxAmount}
            </span>
          </div>
          <p className="text-[10px] text-slate-400 italic">
            Chuột phải dân làng vào mỏ để tiến hành khai thác.
          </p>
        </div>
      )}

      {/* Unit Production Section (for owned buildings) */}
      {entity.isOwner && trainableUnits.length > 0 && (
        <div className="border-t border-slate-800 pt-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-amber-400 tracking-wider flex items-center gap-1">
              <UserPlus size={12} /> HUẤN LUYỆN QUÂN ĐỘI
            </span>
            {entity.trainingQueue && entity.trainingQueue.length > 0 && (
              <span className="text-[10px] text-amber-300 font-mono">
                Đang chờ: {entity.trainingQueue.length}
              </span>
            )}
          </div>

          <div className="flex gap-2">
            {trainableUnits.map((uType) => {
              const uBp = UNIT_BLUEPRINTS[uType];
              const canAfford =
                playerResources.wood >= uBp.cost.wood &&
                playerResources.food >= uBp.cost.food &&
                playerResources.gold >= uBp.cost.gold &&
                playerResources.stone >= uBp.cost.stone;

              return (
                <div key={uType} className="relative group/train">
                  <button
                    onClick={() => onTrainUnit(entity.id, uType)}
                    disabled={!canAfford}
                    className={`px-2.5 py-1.5 rounded border text-[11px] font-semibold transition-all flex flex-col items-center gap-1 ${
                      canAfford
                        ? 'aoe-button text-slate-200 hover:border-amber-400'
                        : 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed opacity-50'
                    }`}
                  >
                    {uType === 'VILLAGER' && (
                      <img src="/assets/units/villager_idle.png" alt="Villager" className="w-6 h-6 object-contain" />
                    )}
                    <span>{uBp.name}</span>
                  </button>

                  {/* Tooltip */}
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-44 p-2 rounded bg-slate-950 border border-amber-600/70 shadow-2xl opacity-0 group-hover/train:opacity-100 transition-opacity pointer-events-none z-50 text-left">
                    <div className="font-medieval text-xs font-bold text-amber-300 mb-0.5">{uBp.name}</div>
                    <div className="text-[10px] text-slate-300 mb-1">{uBp.description}</div>
                    <div className="text-[10px] space-y-0.5 border-t border-slate-800 pt-1 font-mono">
                      {uBp.cost.food > 0 && <span className="text-red-400 mr-2">Thịt: {uBp.cost.food}</span>}
                      {uBp.cost.wood > 0 && <span className="text-amber-400 mr-2">Gỗ: {uBp.cost.wood}</span>}
                      {uBp.cost.gold > 0 && <span className="text-yellow-400 mr-2">Vàng: {uBp.cost.gold}</span>}
                      <div className="text-slate-400 text-[9px] mt-0.5">
                        Tấn công: {uBp.attackPower} | Máu: {uBp.maxHp}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

