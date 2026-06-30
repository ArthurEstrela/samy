import { Link } from 'react-router-dom';
import { useMyRanking } from './useMyRanking';
import { TierBadge } from './TierBadge';

export function RankingPanel(): JSX.Element {
  const { data } = useMyRanking();
  return (
    <section className="mt-6 rounded-2xl bg-velvet p-6">
      <div className="flex items-center justify-between">
        <p className="text-mist text-sm">Seu ranking</p>
        <Link to="/ranking" className="text-mist text-sm underline hover:text-cream">ver ranking</Link>
      </div>
      {data ? (
        <div className="mt-3">
          <TierBadge tier={data.tier} />
          <p className="mt-3 font-mono text-sm text-mist">comissão atual: {(Number(data.takeRate) * 100).toFixed(0)}%</p>
          {data.nextTier ? (
            <p className="mt-1 text-cream text-sm">faltam <span className="font-mono text-gold">⌗ {data.remaining}</span> pra {data.nextTier}</p>
          ) : (
            <p className="mt-1 text-gold text-sm">tier máximo 💎</p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-mist text-sm">…</p>
      )}
    </section>
  );
}
