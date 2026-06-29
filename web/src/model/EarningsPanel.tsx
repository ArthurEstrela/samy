import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../lib/api-client';
import { useEarnings } from './useEarnings';
import { usePayouts } from './usePayouts';
import { useRequestPayout, useDevGrant } from './useRequestPayout';

export function EarningsPanel(): JSX.Element {
  const { data: earnings } = useEarnings();
  const { data: payouts } = usePayouts();
  const requestPayout = useRequestPayout();
  const devGrant = useDevGrant();
  const [amount, setAmount] = useState('200');
  const [pixKey, setPixKey] = useState('');
  const devEnabled = import.meta.env.VITE_DEV_LOGIN === 'true';

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    requestPayout.mutate({ amount, pixKey });
  };

  const errorMsg = (): string | null => {
    const err = requestPayout.error;
    if (!err) return null;
    if (err instanceof ApiError && err.status === 403) return 'Saque requer KYC aprovado.';
    if (err instanceof ApiError && err.status === 400) return 'Valor abaixo do mínimo ou saldo insuficiente.';
    return 'Não foi possível solicitar o saque.';
  };

  return (
    <section className="mt-6 rounded-2xl bg-velvet p-6">
      <p className="text-mist text-sm">Ganhos</p>
      <p className="mt-1 font-mono text-3xl text-cream">⌗ {earnings?.balance ?? '…'} <span className="text-base text-mist">créditos</span></p>

      <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
        <div>
          <label htmlFor="payout-amount" className="block text-mist text-sm">Valor do saque</label>
          <input id="payout-amount" type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-full rounded-lg bg-void px-4 py-3 font-mono text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
        </div>
        <div>
          <label htmlFor="payout-pix" className="block text-mist text-sm">Chave PIX</label>
          <input id="payout-pix" value={pixKey} onChange={(e) => setPixKey(e.target.value)} className="mt-1 w-full rounded-lg bg-void px-4 py-3 text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
        </div>
        <button type="submit" disabled={requestPayout.isPending} className="rounded-full bg-ember px-6 py-3 text-void disabled:opacity-50">
          {requestPayout.isPending ? 'Solicitando…' : 'Solicitar saque'}
        </button>
        {errorMsg() && <p className="text-ember text-sm">{errorMsg()}</p>}
        {requestPayout.isSuccess && <p className="text-gold text-sm">Saque solicitado ✓</p>}
      </form>

      {devEnabled && (
        <button onClick={() => devGrant.mutate()} className="mt-4 rounded-full border border-mist/40 px-5 py-2 text-cream text-sm hover:border-ember">
          Creditar ganhos de teste (dev)
        </button>
      )}

      <div className="mt-8">
        <p className="text-mist text-sm">Histórico de saques</p>
        {payouts && payouts.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-2">
            {payouts.map((p) => (
              <li key={p.id} className="flex items-center justify-between rounded-lg bg-void px-4 py-3">
                <span className="font-mono text-cream">⌗ {p.amount}</span>
                <span className="text-xs uppercase tracking-wide text-gold">{p.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-mist text-sm">Nenhum saque ainda.</p>
        )}
      </div>
    </section>
  );
}
