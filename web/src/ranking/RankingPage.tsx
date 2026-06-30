import { Link } from 'react-router-dom';
import { useRankingTop } from './useRankingTop';
import { TierBadge } from './TierBadge';

export function RankingPage(): JSX.Element {
  const { data } = useRankingTop();
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl text-cream">Ranking</h1>
        <Link to="/" className="text-mist text-sm hover:text-cream">descoberta</Link>
      </header>
      {data && data.length > 0 ? (
        <ol className="mt-8 flex flex-col gap-2">
          {data.map((e) => (
            <li key={e.modelId}>
              <Link to={`/models/${e.modelId}`} className="flex items-center justify-between rounded-xl bg-velvet px-4 py-3 hover:ring-1 hover:ring-ember">
                <span className="flex items-center gap-3">
                  <span className="font-mono text-mist">#{e.rank}</span>
                  <span className="text-cream">{e.stageName}</span>
                </span>
                <TierBadge tier={e.tier} />
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-8 text-mist">Ranking ainda vazio.</p>
      )}
    </main>
  );
}
