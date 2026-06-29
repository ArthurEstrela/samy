import type { CallStatus } from '../types/api';

const LABEL: Record<CallStatus, string> = { ONLINE: 'online', OCUPADA: 'ocupada', OFFLINE: 'offline' };
const STYLE: Record<CallStatus, string> = {
  ONLINE: 'text-gold',
  OCUPADA: 'text-ember/80',
  OFFLINE: 'text-mist',
};

export function StatusBadge({ status }: { status: CallStatus }): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs uppercase tracking-wide ${STYLE[status]}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status === 'ONLINE' ? 'bg-gold' : status === 'OCUPADA' ? 'bg-ember/80' : 'bg-mist'}`} />
      {LABEL[status]}
    </span>
  );
}
