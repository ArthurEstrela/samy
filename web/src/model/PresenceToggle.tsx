import { usePresence } from './usePresence';

export function PresenceToggle(): JSX.Element {
  const { online, toggle } = usePresence();
  return (
    <div className="rounded-2xl bg-velvet p-6 flex items-center justify-between">
      <div>
        <p className="font-display text-2xl text-cream">{online ? 'Online' : 'Offline'}</p>
        <p className="text-mist text-sm">{online ? 'Você está visível na descoberta.' : 'Ligue para aparecer para os clientes.'}</p>
      </div>
      <button
        type="button"
        aria-pressed={online}
        onClick={toggle}
        className={`rounded-full px-6 py-3 ${online ? 'bg-gold text-void' : 'border border-mist/40 text-cream hover:border-ember'}`}
      >
        {online ? 'Ficar offline' : 'Ficar online'}
      </button>
    </div>
  );
}
