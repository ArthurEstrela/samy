import { Link } from 'react-router-dom';
import { useBalance } from './useBalance';
import { RechargePanel } from './RechargePanel';

export function WalletPage(): JSX.Element {
  const { data, isLoading } = useBalance();

  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <Link to="/" className="text-mist text-sm hover:text-cream">← voltar</Link>
      <h1 className="mt-6 font-display text-4xl text-cream">Carteira</h1>
      <section className="mt-6 rounded-2xl bg-velvet p-6">
        <p className="text-mist text-sm">Saldo</p>
        <p className="mt-1 font-mono text-3xl text-cream">
          ⌗ {isLoading ? '…' : data?.balance ?? '0'} <span className="text-base text-mist">créditos</span>
        </p>
      </section>
      <RechargePanel />
    </main>
  );
}
