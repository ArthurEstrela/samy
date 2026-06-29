import { Link } from 'react-router-dom';
import type { ModelCard as ModelCardType } from '../types/api';
import { Orb } from '../ui/Orb';
import { Voiceprint } from '../ui/Voiceprint';
import { StatusBadge } from '../ui/StatusBadge';

export function ModelCard({ model }: { model: ModelCardType }): JSX.Element {
  return (
    <Link
      to={`/models/${model.userId}`}
      className="block rounded-2xl bg-velvet p-5 transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ember"
    >
      <div className="flex items-center gap-4">
        <Orb seed={model.userId} />
        <div className="min-w-0">
          <h3 className="font-display text-2xl text-cream truncate">{model.stageName}</h3>
          <StatusBadge status={model.status} />
        </div>
      </div>
      <div className="mt-4">
        <Voiceprint seed={model.userId} alive={model.status === 'ONLINE'} />
      </div>
      <div className="mt-4 flex items-center justify-between">
        <span className="font-mono text-sm text-cream">⌗ {model.pricePerMinute} créditos/min</span>
      </div>
      {model.tags.length > 0 && (
        <p className="mt-3 text-mist text-sm">{model.tags.map((t) => `#${t}`).join('  ')}</p>
      )}
    </Link>
  );
}
