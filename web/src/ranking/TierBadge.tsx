import type { Tier } from '../types/api';

const STYLE: Record<Tier, string> = {
  BRONZE: 'bg-velvet text-gold',
  PRATA: 'bg-velvet text-mist',
  OURO: 'bg-gold/20 text-gold',
  DIAMANTE: 'bg-ember/20 text-ember',
};

export function TierBadge({ tier }: { tier: Tier }): JSX.Element {
  return (
    <span className={`inline-block rounded-full px-3 py-1 font-mono text-xs uppercase tracking-wide ${STYLE[tier]}`}>
      {tier}
    </span>
  );
}
