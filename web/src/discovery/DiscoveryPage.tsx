import { useModels } from './useModels';
import { ModelCard } from './ModelCard';
import { useAuth } from '../auth/auth-context';

export function DiscoveryPage(): JSX.Element {
  const { data, isLoading, isError, refetch } = useModels();
  const { logout } = useAuth();

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl text-cream">Quem você quer ouvir?</h1>
        <button onClick={() => void logout()} className="text-mist text-sm hover:text-cream">sair</button>
      </header>

      <section className="mt-10">
        {isLoading && (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-48 rounded-2xl bg-velvet animate-pulse" />
            ))}
          </div>
        )}

        {isError && (
          <div className="text-center text-mist">
            <p>Não foi possível carregar as vozes.</p>
            <button onClick={() => void refetch()} className="mt-3 rounded-full bg-ember px-5 py-2 text-void">tentar de novo</button>
          </div>
        )}

        {data && data.length === 0 && (
          <p className="text-center text-mist">Nenhuma voz disponível agora. Volte mais tarde.</p>
        )}

        {data && data.length > 0 && (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((m) => <ModelCard key={m.userId} model={m} />)}
          </div>
        )}
      </section>
    </main>
  );
}
