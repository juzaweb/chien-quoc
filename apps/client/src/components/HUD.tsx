import React from 'react';
import { Axe, Drumstick, Coins, Mountain, Users, ShieldCheck, Wifi } from 'lucide-react';

interface HUDProps {
  playerName: string;
  playerColor: string;
  wood: number;
  food: number;
  gold: number;
  stone: number;
  population: number;
  populationCap: number;
  isConnected: boolean;
}

export const HUD: React.FC<HUDProps> = ({
  playerName,
  playerColor,
  wood,
  food,
  gold,
  stone,
  population,
  populationCap,
  isConnected
}) => {
  return (
    <div className="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-none select-none z-20">
      {/* Player Emblem & Name */}
      <div className="flex items-center gap-3 bg-slate-900/90 border border-amber-600/70 rounded-md px-4 py-2 shadow-lg backdrop-blur-sm pointer-events-auto">
        <div
          className="w-4 h-4 rounded-full border border-white/50 shadow-sm"
          style={{ backgroundColor: playerColor || '#3b82f6' }}
        />
        <span className="font-medieval text-amber-300 font-bold tracking-wide text-base">
          {playerName || 'Emperor'}
        </span>
      </div>

      {/* Central Resource Bar (AoE Classic Style) */}
      <div className="flex items-center gap-5 bg-slate-950/85 border-2 border-amber-700/80 rounded-lg px-6 py-2 shadow-2xl backdrop-blur-md pointer-events-auto">
        {/* Wood */}
        <div className="flex items-center gap-2" title="Gỗ (Wood)">
          <div className="p-1 rounded bg-amber-950/60 text-amber-500 border border-amber-800/40">
            <Axe size={16} />
          </div>
          <span className="font-semibold text-slate-100 text-sm tabular-nums">{Math.floor(wood)}</span>
        </div>

        {/* Food */}
        <div className="flex items-center gap-2" title="Thực lương (Food)">
          <div className="p-1 rounded bg-red-950/60 text-red-400 border border-red-800/40">
            <Drumstick size={16} />
          </div>
          <span className="font-semibold text-slate-100 text-sm tabular-nums">{Math.floor(food)}</span>
        </div>

        {/* Gold */}
        <div className="flex items-center gap-2" title="Vàng (Gold)">
          <div className="p-1 rounded bg-yellow-950/60 text-yellow-400 border border-yellow-800/40">
            <Coins size={16} />
          </div>
          <span className="font-semibold text-slate-100 text-sm tabular-nums">{Math.floor(gold)}</span>
        </div>

        {/* Stone */}
        <div className="flex items-center gap-2" title="Đá (Stone)">
          <div className="p-1 rounded bg-slate-800/60 text-slate-300 border border-slate-700/40">
            <Mountain size={16} />
          </div>
          <span className="font-semibold text-slate-100 text-sm tabular-nums">{Math.floor(stone)}</span>
        </div>

        {/* Divider */}
        <div className="h-5 w-px bg-slate-700" />

        {/* Population */}
        <div className="flex items-center gap-2" title="Dân số (Population)">
          <div className="p-1 rounded bg-sky-950/60 text-sky-400 border border-sky-800/40">
            <Users size={16} />
          </div>
          <span
            className={`font-semibold text-sm tabular-nums ${
              population >= populationCap ? 'text-red-400 font-bold' : 'text-slate-100'
            }`}
          >
            {population} / {populationCap}
          </span>
        </div>
      </div>

      {/* Network Status indicator */}
      <div className="flex items-center gap-2 bg-slate-900/90 border border-slate-700/80 rounded-md px-3 py-2 text-xs backdrop-blur-sm pointer-events-auto">
        <Wifi size={14} className={isConnected ? 'text-emerald-400' : 'text-red-500 animate-pulse'} />
        <span className={isConnected ? 'text-emerald-400' : 'text-red-400'}>
          {isConnected ? 'ONLINE' : 'OFFLINE'}
        </span>
      </div>
    </div>
  );
};

