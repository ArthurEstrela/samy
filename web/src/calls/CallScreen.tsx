import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { connectCallRoom } from '../lib/call-media';
import type { CallRoomHandle } from '../lib/call-media';
import { useCall } from './useCall';
import { useCallActions } from './useCallActions';

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function CallScreen(): JSX.Element {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { data } = useCall(id);
  const { hangup, panic } = useCallActions();
  const handleRef = useRef<CallRoomHandle | null>(null);
  const [muted, setMuted] = useState(false);
  const [audioError, setAudioError] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const call = data?.call;
  const media = data?.media;
  const status = call?.status;
  const isModel = user?.role === 'MODEL';

  useEffect(() => {
    if (status === 'ACTIVE' && media && !handleRef.current) {
      connectCallRoom(media.url, media.token)
        .then((h) => { handleRef.current = h; })
        .catch(() => setAudioError(true));
    }
  }, [status, media]);

  useEffect(() => {
    if (status === 'ENDED' && handleRef.current) {
      void handleRef.current.disconnect();
      handleRef.current = null;
    }
  }, [status]);

  useEffect(() => () => { void handleRef.current?.disconnect(); }, []);

  useEffect(() => {
    if (status !== 'ACTIVE' || !call?.startedAt) return;
    const started = new Date(call.startedAt).getTime();
    const tick = (): void => setElapsed((Date.now() - started) / 1000);
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [status, call?.startedAt]);

  const toggleMute = (): void => { const m = !muted; setMuted(m); handleRef.current?.setMuted(m); };
  const onHangup = (): void => { hangup.mutate(id, { onSuccess: () => { void handleRef.current?.disconnect(); handleRef.current = null; } }); };

  return (
    <main className="min-h-screen grid place-items-center px-6 text-center">
      <div className="max-w-sm">
        {status === 'ENDED' ? (
          <>
            <h1 className="font-display text-4xl text-cream">Chamada encerrada</h1>
            {call?.endReason && <p className="mt-2 text-mist text-sm">{call.endReason}</p>}
            <Link to={isModel ? '/painel' : '/'} className="mt-6 inline-block text-ember">voltar</Link>
          </>
        ) : status === 'ACTIVE' ? (
          <>
            <p className="text-mist text-sm">{isModel ? 'Em chamada com o cliente' : 'Em chamada'}</p>
            <p className="mt-2 font-mono text-5xl text-cream">{fmt(elapsed)}</p>
            {audioError && <p className="mt-3 text-ember text-sm">Não foi possível conectar o áudio.</p>}
            <div className="mt-8 flex justify-center gap-3">
              <button onClick={toggleMute} className="rounded-full border border-mist/40 px-5 py-3 text-cream hover:border-ember">{muted ? 'Reativar' : 'Mutar'}</button>
              <button onClick={onHangup} className="rounded-full bg-ember px-6 py-3 text-void">Desligar</button>
              {isModel && <button onClick={() => panic.mutate(id)} className="rounded-full border border-ember/60 px-5 py-3 text-ember">Pânico</button>}
            </div>
          </>
        ) : status === 'REQUESTED' ? (
          <>
            <h1 className="font-display text-4xl text-cream">Chamando…</h1>
            <p className="mt-2 text-mist text-sm">aguardando atender</p>
            <button onClick={onHangup} className="mt-8 rounded-full bg-ember px-6 py-3 text-void">Desligar</button>
          </>
        ) : null}
      </div>
    </main>
  );
}
