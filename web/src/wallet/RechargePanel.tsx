import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { apiFetch } from '../lib/api-client';
import { useCreateRecharge } from './useCreateRecharge';
import { useRecharge } from './useRecharge';

export function RechargePanel(): JSX.Element {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('20');
  const [rechargeId, setRechargeId] = useState<string | null>(null);
  const create = useCreateRecharge();
  const { data: recharge } = useRecharge(rechargeId);
  const devEnabled = import.meta.env.VITE_DEV_LOGIN === 'true';

  useEffect(() => {
    if (recharge?.status === 'PAID') {
      void qc.invalidateQueries({ queryKey: ['balance'] });
    }
  }, [recharge?.status, qc]);

  const submit = (): void => {
    create.mutate(amount, { onSuccess: (r) => setRechargeId(r.id) });
  };

  const devConfirm = (): void => {
    if (!rechargeId) return;
    void apiFetch(`/wallet/recharge/${rechargeId}/dev-confirm`, { method: 'POST', auth: true }).then(() => {
      void qc.invalidateQueries({ queryKey: ['recharge', rechargeId] });
    });
  };

  if (recharge?.status === 'PAID') {
    return (
      <div className="mt-8 rounded-2xl bg-velvet p-6 text-center">
        <p className="text-gold">Recarga confirmada ✓</p>
        <button onClick={() => { setRechargeId(null); }} className="mt-4 text-mist text-sm hover:text-cream">nova recarga</button>
      </div>
    );
  }

  if (recharge && recharge.status === 'PENDING') {
    return (
      <div className="mt-8 rounded-2xl bg-velvet p-6 text-center">
        <p className="text-mist text-sm">Aguardando pagamento…</p>
        {recharge.qrText && (
          <div className="mt-4 flex flex-col items-center gap-3">
            <div className="rounded-xl bg-cream p-3"><QRCodeSVG value={recharge.qrText} size={180} /></div>
            <code className="block max-w-xs break-all text-xs text-mist">{recharge.qrText}</code>
          </div>
        )}
        {devEnabled && (
          <button onClick={devConfirm} className="mt-5 rounded-full border border-mist/40 px-6 py-3 text-cream hover:border-ember">
            Já paguei (simular)
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-8 rounded-2xl bg-velvet p-6">
      <label htmlFor="amount" className="block text-mist text-sm">Valor (créditos)</label>
      <input
        id="amount"
        type="number"
        min="5"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="mt-2 w-full rounded-lg bg-void px-4 py-3 text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember"
      />
      <button
        onClick={submit}
        disabled={create.isPending}
        className="mt-4 w-full rounded-full bg-ember px-6 py-3 text-void disabled:opacity-50"
      >
        {create.isPending ? 'Gerando…' : 'Gerar QR de recarga'}
      </button>
      {create.isError && <p className="mt-3 text-sm text-ember">Não foi possível criar a recarga. Tente de novo.</p>}
    </div>
  );
}
