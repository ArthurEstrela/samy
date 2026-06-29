import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { PresenceToggle } from './PresenceToggle';
import { ProfileForm } from './ProfileForm';
import { EarningsPanel } from './EarningsPanel';

export function ModelDashboard(): JSX.Element {
  const { user, logout } = useAuth();
  if (user?.role !== 'MODEL') return <Navigate to="/" replace />;

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl text-cream">Seu painel</h1>
        <button onClick={() => void logout()} className="text-mist text-sm hover:text-cream">sair</button>
      </header>
      <div className="mt-8"><PresenceToggle /></div>
      <ProfileForm />
      <EarningsPanel />
    </main>
  );
}
