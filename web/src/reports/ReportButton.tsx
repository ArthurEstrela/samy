import { useState } from 'react';
import { useReport } from './useReport';
import type { ReportReason } from '../types/api';

const OPTIONS: { reason: ReportReason; label: string }[] = [
  { reason: 'EXPLICITO', label: 'Conteúdo explícito' },
  { reason: 'ENCONTRO_FORA', label: 'Encontro/pagamento fora da plataforma' },
  { reason: 'ASSEDIO', label: 'Assédio ou abuso' },
  { reason: 'MENOR', label: 'Suspeita de menor de idade' },
  { reason: 'GOLPE', label: 'Golpe' },
  { reason: 'OUTRO', label: 'Outro' },
];

export function ReportButton({ reportedUserId }: { reportedUserId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const report = useReport();

  if (report.isSuccess) return <p className="mt-8 text-mist text-xs">Denúncia enviada. Obrigado por ajudar a manter a Samy segura.</p>;

  return (
    <div className="mt-8">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="text-mist text-xs hover:text-ember">Denunciar</button>
      ) : (
        <div className="rounded-xl bg-velvet p-4">
          <p className="text-mist text-sm">Motivo da denúncia</p>
          <div className="mt-2 flex flex-col gap-1">
            {OPTIONS.map((o) => (
              <button key={o.reason} type="button" disabled={report.isPending}
                onClick={() => report.mutate({ reportedUserId, reason: o.reason })}
                className="text-left text-sm text-cream hover:text-ember disabled:opacity-50">
                {o.label}
              </button>
            ))}
          </div>
          {report.isError && <p className="mt-2 text-ember text-xs">Não foi possível enviar. Tente de novo.</p>}
          <button type="button" onClick={() => setOpen(false)} className="mt-2 text-mist text-xs hover:text-cream">cancelar</button>
        </div>
      )}
    </div>
  );
}
