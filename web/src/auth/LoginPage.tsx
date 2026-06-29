import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './auth-context';

export function LoginPage(): JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();
  const btnRef = useRef<HTMLDivElement>(null);
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

  useEffect(() => {
    if (!clientId || !window.google || !btnRef.current) return;
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (resp) => {
        void login(resp.credential).then(() => navigate('/', { replace: true }));
      },
    });
    window.google.accounts.id.renderButton(btnRef.current, { theme: 'filled_black', size: 'large', shape: 'pill' });
  }, [clientId, login, navigate]);

  return (
    <main className="min-h-screen grid place-items-center px-6">
      <div className="text-center max-w-sm">
        <h1 className="font-display text-5xl text-cream">Samy</h1>
        <p className="mt-3 text-mist">Quem você quer ouvir esta noite?</p>
        <div className="mt-8 flex justify-center">
          {clientId
            ? <div ref={btnRef} />
            : <p className="text-mist text-sm">Login não configurado (defina <code>VITE_GOOGLE_CLIENT_ID</code>).</p>}
        </div>
      </div>
    </main>
  );
}
