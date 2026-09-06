import { useSecureDocumentBlob } from './useSecureDocumentBlob';

interface SecurePrivateImageProps {
  src: string | null | undefined;
  alt: string;
  className?: string;
  unavailableLabel?: string;
  enabled?: boolean;
}

export function SecurePrivateImage({
  src,
  alt,
  className,
  unavailableLabel = 'Gambar tidak tersedia',
  enabled = true
}: SecurePrivateImageProps) {
  const { blobUrl, loading, error } = useSecureDocumentBlob(src, enabled && Boolean(src));

  if (loading) {
    return (
      <div
        className={`flex items-center justify-center bg-slate-100 text-slate-400 text-[10px] ${className || ''}`}
        aria-label="Memuat gambar"
      >
        Memuat...
      </div>
    );
  }

  if (error || !blobUrl) {
    return (
      <div
        className={`flex items-center justify-center bg-slate-100 text-slate-500 text-[10px] text-center px-2 ${className || ''}`}
        role="img"
        aria-label={unavailableLabel}
      >
        {unavailableLabel}
      </div>
    );
  }

  return <img src={blobUrl} alt={alt} className={className} />;
}
