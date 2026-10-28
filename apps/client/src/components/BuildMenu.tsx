import React from 'react';
import { BUILDING_BLUEPRINTS, BuildingType, Resources } from '@chien-quoc/shared';
import { Landmark, ShieldAlert, Home, Wheat, TowerControl } from 'lucide-react';

interface BuildMenuProps {
  playerResources: Resources;
  activeBuildingType: BuildingType | null;
  onSelectBuilding: (type: BuildingType) => void;
  onCancelBuilding: () => void;
}

const BUILDINGS: { type: BuildingType; icon: React.ReactNode; hotkey: string }[] = [
  { type: 'TOWN_CENTER', icon: <Landmark size={20} />, hotkey: 'Q' },
  { type: 'BARRACKS', icon: <ShieldAlert size={20} />, hotkey: 'W' },
  { type: 'HOUSE', icon: <Home size={20} />, hotkey: 'E' },
  { type: 'FARM', icon: <Wheat size={20} />, hotkey: 'R' },
  { type: 'TOWER', icon: <TowerControl size={20} />, hotkey: 'T' }
];

export const BuildMenu: React.FC<BuildMenuProps> = ({
  playerResources,
  activeBuildingType,
  onSelectBuilding,
  onCancelBuilding
}) => {
  return (
    <div className="flex flex-col gap-1.5 aoe-panel p-3 rounded-lg pointer-events-auto">
      <div className="flex items-center justify-between border-b border-amber-800/40 pb-1.5">
        <span className="font-medieval text-xs font-bold text-amber-400 tracking-wider">
          XÂY CÔNG TRÌNH
        </span>
        {activeBuildingType && (
          <button
            onClick={onCancelBuilding}
            className="text-[10px] text-red-400 hover:text-red-300 font-semibold uppercase px-1.5 py-0.5 rounded bg-red-950/50 border border-red-800/50"
          >
            Hủy (Esc)
          </button>
        )}
      </div>

      <div className="grid grid-cols-5 gap-2">
        {BUILDINGS.map(({ type, icon, hotkey }) => {
          const bp = BUILDING_BLUEPRINTS[type];
          const canAfford =
            playerResources.wood >= bp.cost.wood &&
            playerResources.food >= bp.cost.food &&
            playerResources.gold >= bp.cost.gold &&
            playerResources.stone >= bp.cost.stone;

          const isSelected = activeBuildingType === type;

          return (
            <div key={type} className="relative group">
              <button
                onClick={() => {
                  if (isSelected) onCancelBuilding();
                  else onSelectBuilding(type);
                }}
                disabled={!canAfford}
                className={`relative flex flex-col items-center justify-center w-14 h-14 rounded border transition-all ${
                  isSelected
                    ? 'bg-amber-600/40 border-amber-400 ring-2 ring-amber-400/50 shadow-lg'
                    : canAfford
                    ? 'aoe-button text-slate-200 hover:border-amber-500'
                    : 'bg-slate-900/60 border-slate-800 text-slate-600 cursor-not-allowed opacity-60'
                }`}
              >
                {icon}
                <span className="text-[10px] font-semibold mt-1 truncate max-w-[50px]">{bp.name}</span>
                <span className="absolute top-0.5 right-1 text-[9px] text-amber-500 font-mono">{hotkey}</span>
              </button>

              {/* Tooltip */}
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 rounded bg-slate-950/95 border border-amber-600/70 shadow-2xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 text-left">
                <div className="font-medieval text-xs font-bold text-amber-300 mb-1">{bp.name}</div>
                <div className="text-[11px] text-slate-300 leading-tight mb-2">{bp.description}</div>
                <div className="text-[10px] space-y-0.5 border-t border-slate-800 pt-1 font-mono">
                  {bp.cost.wood > 0 && <div className="text-amber-400">Gỗ: {bp.cost.wood}</div>}
                  {bp.cost.food > 0 && <div className="text-red-400">Thịt: {bp.cost.food}</div>}
                  {bp.cost.gold > 0 && <div className="text-yellow-400">Vàng: {bp.cost.gold}</div>}
                  {bp.cost.stone > 0 && <div className="text-slate-300">Đá: {bp.cost.stone}</div>}
                  {bp.populationProvided > 0 && (
                    <div className="text-sky-400">Dân số: +{bp.populationProvided}</div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

