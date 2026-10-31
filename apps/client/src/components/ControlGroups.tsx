import React from 'react';
import { Layers } from 'lucide-react';
import type { ControlGroupSummary } from '../game/scenes/WorldScene.js';

/** Short Vietnamese labels so the group rows stay one line wide. */
const UNIT_SHORT_LABELS: Record<string, string> = {
  VILLAGER: 'Dân',
  SPEARMAN: 'Giáo',
  ARCHER: 'Cung',
  CAVALRY: 'Kỵ'
};

interface ControlGroupsProps {
  groups: ControlGroupSummary[];
  /** UIX-03: same recall as pressing the group's digit key. */
  onSelectGroup: (index: number) => void;
}

/**
 * UIX-03: the `Ctrl+1..9` rosters, mirrored next to the HUD.
 *
 * AoE2 has no equivalent panel (it relies on muscle memory), but a browser RTS
 * loses the digit keys to tab switching often enough that the groups need to be
 * visible and clickable. Nothing renders while no group exists, so a player who
 * never groups units sees no extra chrome.
 */
export const ControlGroups: React.FC<ControlGroupsProps> = ({ groups, onSelectGroup }) => {
  if (groups.length === 0) return null;

  return (
    <div
      className="aoe-panel w-40 p-2 rounded-lg pointer-events-auto flex flex-col gap-1"
      data-control-groups
    >
      <div className="flex items-center gap-1.5 border-b border-amber-800/40 pb-1 text-[10px] font-bold tracking-wider text-amber-400">
        <Layers size={12} /> NHÓM QUÂN
      </div>

      {groups.map((group) => (
        <button
          key={group.index}
          type="button"
          onClick={() => onSelectGroup(group.index)}
          data-group-index={group.index}
          title={group.breakdown
            .map((entry) => `${UNIT_SHORT_LABELS[entry.type] ?? entry.type} ×${entry.count}`)
            .join(', ')}
          className="flex items-center gap-2 rounded border border-slate-700/70 bg-slate-900/70 px-1.5 py-1 text-left transition-colors hover:border-amber-400 hover:bg-slate-800/80"
        >
          <span className="w-4 shrink-0 text-center font-mono text-[10px] font-bold text-amber-300">
            {group.index}
          </span>
          <span className="flex-1 truncate font-semibold text-[11px] text-slate-200">
            {group.breakdown
              .map((entry) => `${UNIT_SHORT_LABELS[entry.type] ?? entry.type} ${entry.count}`)
              .join(' · ')}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-slate-400 tabular-nums">
            {group.count}
          </span>
        </button>
      ))}
    </div>
  );
};
