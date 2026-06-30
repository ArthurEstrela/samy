import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { useAdminUsers } from './useAdminUsers';
import { useSetUserStatus } from './useSetUserStatus';

export function AdminPage(): JSX.Element {
  const { user } = useAuth();
  const { data } = useAdminUsers();
  const setStatus = useSetUserStatus();
  if (user?.role !== 'ADMIN') return <Navigate to="/" replace />;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl text-cream">Admin</h1>
        <Link to="/" className="text-mist text-sm hover:text-cream">descoberta</Link>
      </header>
      {data && data.length > 0 ? (
        <ul className="mt-8 flex flex-col gap-2">
          {data.map((u) => (
            <li key={u.id} className="flex items-center justify-between rounded-xl bg-velvet px-4 py-3">
              <span className="flex flex-col">
                <span className="text-cream">{u.displayName}</span>
                <span className="font-mono text-xs text-mist">
                  <span>{u.email}</span>
                  <span className="mx-1">·</span>
                  <span>{u.role}</span>
                  <span className="mx-1">·</span>
                  <span>{u.status}</span>
                </span>
              </span>
              {u.status === 'ACTIVE' ? (
                <button type="button" disabled={setStatus.isPending}
                  onClick={() => setStatus.mutate({ id: u.id, action: 'suspend' })}
                  className="rounded-full border border-mist/40 px-4 py-2 text-sm text-cream hover:border-ember disabled:opacity-50">
                  Suspender
                </button>
              ) : (
                <button type="button" disabled={setStatus.isPending}
                  onClick={() => setStatus.mutate({ id: u.id, action: 'activate' })}
                  className="rounded-full border border-mist/40 px-4 py-2 text-sm text-gold hover:border-gold disabled:opacity-50">
                  Ativar
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-8 text-mist">Nenhum usuário.</p>
      )}
    </main>
  );
}
