import { useKyc } from './useKyc';

const LABEL: Record<string, string> = {
  NONE: 'não iniciada',
  PENDING: 'em análise',
  APPROVED: 'aprovada ✓',
  REJECTED: 'recusada',
};

export function KycPanel(): JSX.Element {
  const { status, start, devApprove } = useKyc();
  const devEnabled = import.meta.env.VITE_DEV_LOGIN === 'true';
  const s = status.data?.status ?? 'NONE';

  return (
    <section className="mt-6 rounded-2xl bg-velvet p-6">
      <div className="flex items-baseline justify-between">
        <p className="text-mist text-sm">Verificação (KYC)</p>
        <span className={`text-xs uppercase tracking-wide ${s === 'APPROVED' ? 'text-gold' : s === 'REJECTED' ? 'text-ember' : 'text-mist'}`}>
          {LABEL[s] ?? s}
        </span>
      </div>
      {status.data?.status === 'REJECTED' && status.data.reason && (
        <p className="mt-2 text-ember text-sm">{status.data.reason}</p>
      )}

      {s !== 'APPROVED' && (
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={start.isPending}
            className="rounded-full bg-ember px-6 py-3 text-void disabled:opacity-50"
          >
            {start.isPending ? 'Iniciando…' : 'Iniciar verificação'}
          </button>
          {devEnabled && (
            <button
              type="button"
              onClick={() => devApprove.mutate()}
              className="rounded-full border border-mist/40 px-6 py-3 text-cream hover:border-ember"
            >
              Aprovar KYC (simular)
            </button>
          )}
        </div>
      )}

      {start.isError && <p className="mt-3 text-ember text-sm">Verificação indisponível no momento.</p>}
      {s === 'APPROVED' && <p className="mt-3 text-gold text-sm">Identidade verificada — você pode sacar.</p>}
    </section>
  );
}
