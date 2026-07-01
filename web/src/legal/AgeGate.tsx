import { useState } from 'react';
import type { ReactNode } from 'react';

const KEY = 'samy.age_ok';

// Porta de entrada 18+. A Samy é companhia por voz para adultos; ninguém vê
// conteúdo sem confirmar a maioridade. A confirmação fica no dispositivo.
export function AgeGate({ children }: { children: ReactNode }): JSX.Element {
  const [ok, setOk] = useState<boolean>(() => localStorage.getItem(KEY) === 'true');
  if (ok) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-void px-6">
      <div className="max-w-sm text-center">
        <h1 className="font-display text-5xl text-cream">Samy</h1>
        <p className="mt-4 text-mist">
          Companhia por voz para adultos. Este espaço é exclusivo para <strong className="text-cream">maiores de 18 anos</strong>.
        </p>
        <button
          type="button"
          onClick={() => { localStorage.setItem(KEY, 'true'); setOk(true); }}
          className="mt-8 w-full rounded-full bg-ember px-6 py-3 text-void"
        >
          Tenho 18 anos ou mais — entrar
        </button>
        <a href="https://www.google.com" className="mt-4 block text-mist text-sm hover:text-cream">Sair</a>
        <p className="mt-6 text-xs text-mist/70">
          Ao entrar, você confirma ter 18 anos ou mais e concorda com os Termos de Serviço e a Política de Uso da Samy.
        </p>
      </div>
    </div>
  );
}
