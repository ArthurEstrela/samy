import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api-client';
import { useGiftCatalog } from './useGiftCatalog';
import { useSendGift } from './useSendGift';

export function GiftPicker({ modelId }: { modelId: string }): JSX.Element {
  const { data } = useGiftCatalog();
  const send = useSendGift();
  const [sentName, setSentName] = useState<string | null>(null);

  const errorMsg = (): string | null => {
    const e = send.error;
    if (!e) return null;
    if (e instanceof ApiError && e.status === 402) return 'Saldo insuficiente — recarregue.';
    if (e instanceof ApiError && e.status === 404) return 'Presente indisponível.';
    return 'Não foi possível enviar.';
  };
  const insufficient = send.error instanceof ApiError && send.error.status === 402;

  return (
    <section className="mt-6 rounded-2xl bg-velvet p-6">
      <p className="text-mist text-sm">Presentes</p>
      {data && data.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {data.map((g) => (
            <button
              key={g.id}
              type="button"
              disabled={send.isPending}
              onClick={() => { setSentName(g.name); send.mutate({ modelId, giftTypeId: g.id }); }}
              className="rounded-xl bg-void p-4 text-center hover:ring-1 hover:ring-ember disabled:opacity-50"
            >
              <p className="text-cream">{g.name}</p>
              <p className="mt-1 font-mono text-sm text-gold">⌗ {g.priceCredits}</p>
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-mist text-sm">Nenhum presente disponível.</p>
      )}
      {send.isSuccess && <p className="mt-3 text-gold text-sm">{sentName} enviado ✓</p>}
      {errorMsg() && (
        <p className="mt-3 text-ember text-sm">
          {errorMsg()}{' '}
          {insufficient && <Link to="/wallet" className="underline">Carteira</Link>}
        </p>
      )}
    </section>
  );
}
