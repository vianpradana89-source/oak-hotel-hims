interface Props {
  channel?: string | null;
  otaSourceName?: string | null;
}

export function TransactionSourceBadge({ channel, otaSourceName }: Props) {
  const isOta = otaSourceName || channel?.toUpperCase() === 'OTA';

  if (isOta) {
    return (
      <span className="text-xs font-semibold bg-sky-100 text-sky-800 px-2 py-0.5 rounded-md border border-sky-200">
        {otaSourceName || 'OTA'}
      </span>
    );
  }

  return (
    <span className="text-xs font-semibold bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md border border-slate-200">
      Walk-in
    </span>
  );
}
