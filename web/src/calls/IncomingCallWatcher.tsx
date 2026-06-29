import { useNavigate } from 'react-router-dom';
import { useIncomingCall } from './useIncomingCall';
import { useCallActions } from './useCallActions';

export function IncomingCallWatcher(): JSX.Element | null {
  const navigate = useNavigate();
  const { data } = useIncomingCall(true);
  const { accept, reject } = useCallActions();
  const call = data?.call;
  if (!call) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-void/80 px-6">
      <div className="rounded-2xl bg-velvet p-8 text-center max-w-sm">
        <p className="text-mist text-sm">Chamada recebida</p>
        <h2 className="mt-2 font-display text-3xl text-cream">Alguém quer te ouvir</h2>
        <div className="mt-8 flex justify-center gap-3">
          <button
            onClick={() => accept.mutate(call.id, { onSuccess: () => navigate(`/call/${call.id}`) })}
            className="rounded-full bg-gold px-6 py-3 text-void"
          >
            Aceitar
          </button>
          <button
            onClick={() => reject.mutate(call.id)}
            className="rounded-full border border-mist/40 px-6 py-3 text-cream hover:border-ember"
          >
            Recusar
          </button>
        </div>
      </div>
    </div>
  );
}
