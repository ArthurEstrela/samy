import { Link, useParams, useNavigate } from 'react-router-dom';
import { useModel } from './useModel';
import { useFavorite } from './useFavorite';
import { useCallActions } from '../calls/useCallActions';
import { Orb } from '../ui/Orb';
import { Voiceprint } from '../ui/Voiceprint';
import { StatusBadge } from '../ui/StatusBadge';
import { ApiError } from '../lib/api-client';
import { GiftPicker } from '../gifts/GiftPicker';

export function ModelProfilePage(): JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: model, isLoading, error } = useModel(id);
  const { toggle, pending } = useFavorite(id);
  const { initiate } = useCallActions();

  if (isLoading) {
    return <main className="mx-auto max-w-2xl px-6 py-10"><div className="h-64 rounded-2xl bg-velvet animate-pulse" /></main>;
  }
  if (error instanceof ApiError && error.status === 404) {
    return <main className="mx-auto max-w-2xl px-6 py-16 text-center text-mist"><p>Voz não encontrada.</p><Link to="/" className="mt-4 inline-block text-ember">voltar</Link></main>;
  }
  if (!model) {
    return <main className="mx-auto max-w-2xl px-6 py-16 text-center text-mist"><p>Algo deu errado.</p><Link to="/" className="mt-4 inline-block text-ember">voltar</Link></main>;
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link to="/" className="text-mist text-sm hover:text-cream">← voltar</Link>
      <div className="mt-6 flex items-center gap-5">
        <Orb seed={model.userId} size={96} />
        <div>
          <h1 className="font-display text-5xl text-cream">{model.stageName}</h1>
          <div className="mt-2"><StatusBadge status={model.status} /></div>
        </div>
      </div>

      <div className="mt-8"><Voiceprint seed={model.userId} alive={model.status === 'ONLINE'} /></div>

      {model.bio && <p className="mt-6 text-cream/90 leading-relaxed">{model.bio}</p>}
      {model.tags.length > 0 && <p className="mt-4 text-mist">{model.tags.map((t) => `#${t}`).join('  ')}</p>}

      <p className="mt-6 font-mono text-cream">⌗ {model.pricePerMinute} créditos/min</p>

      <div className="mt-10 flex gap-3">
        <button
          type="button"
          disabled={model.status !== 'ONLINE' || initiate.isPending}
          onClick={() => initiate.mutate(model.userId, { onSuccess: (call) => navigate(`/call/${call.id}`) })}
          className="rounded-full bg-ember px-6 py-3 text-void disabled:bg-ember/40 disabled:text-void/70 disabled:cursor-not-allowed"
        >
          {model.status === 'ONLINE' ? 'Iniciar chamada' : 'Indisponível'}
        </button>
        {initiate.isError && <p className="mt-3 text-ember text-sm">Não foi possível iniciar (saldo ou disponibilidade).</p>}
        <button
          type="button"
          onClick={() => toggle(model.isFavorite)}
          disabled={pending}
          aria-pressed={model.isFavorite}
          className="rounded-full border border-mist/40 px-6 py-3 text-cream hover:border-ember disabled:opacity-50"
        >
          {model.isFavorite ? 'Remover dos favoritos' : 'Favoritar'}
        </button>
      </div>

      <GiftPicker modelId={model.userId} />
    </main>
  );
}
