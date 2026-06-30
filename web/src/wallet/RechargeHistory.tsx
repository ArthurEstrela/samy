import { useRecharges } from './useRecharges';
import type { RechargeSummary } from '../types/api';

const LABEL: Record<string, { text: string; cls: string }> = {
  PAID: { text: 'paga', cls: 'text-gold' },
  PENDING: { text: 'pendente', cls: 'text-mist' },
  EXPIRED: { text: 'expirada', cls: 'text-mist' },
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function RechargeHistory(): JSX.Element {
  const { data } = useRecharges();
  return (
    <section className="mt-6 rounded-2xl bg-velvet p-6">
      <p className="text-mist text-sm">Recargas</p>
      {data && data.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {data.map((r: RechargeSummary) => {
            const label = LABEL[r.status] ?? { text: r.status, cls: 'text-mist' };
            return (
              <li key={r.id} className="flex items-center justify-between rounded-xl bg-void px-4 py-3">
                <span className="font-mono text-cream">⌗ {r.amount}</span>
                <span className="flex items-center gap-3">
                  <span className={`text-sm ${label.cls}`}>{label.text}</span>
                  <span className="font-mono text-xs text-mist">{fmtDate(r.createdAt)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-mist text-sm">Nenhuma recarga ainda.</p>
      )}
    </section>
  );
}
