import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';

/**
 * Custom React hook to securely fetch protected documents (e.g. KTP, Payment Receipts)
 * using the existing Authorization Bearer header, converting the response into a
 * temporary Blob Object URL without leaking credentials in query strings or browser history.
 *
 * Automatically revokes previous object URLs when the path changes, when disabled, or on unmount.
 */
export function useSecureDocumentBlob(rawPath: string | null | undefined, enabled: boolean = true) {
  const { authFetch } = useAuth();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let currentObjectUrl: string | null = null;

    if (enabled && rawPath) {
      setLoading(true);
      setError(null);

      // Clean localhost prefix if any legacy path contains it
      const cleanPath = rawPath.replace(/^http:\/\/localhost(:\d+)?/, '');
      const url = cleanPath.startsWith('http://') || cleanPath.startsWith('https://')
        ? cleanPath
        : (cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`);

      authFetch(url)
        .then(async (res) => {
          if (!active) return;
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.message || `Gagal memuat dokumen (${res.status})`);
          }
          const blob = await res.blob();
          if (!active) return;
          currentObjectUrl = URL.createObjectURL(blob);
          setBlobUrl(currentObjectUrl);
          setLoading(false);
        })
        .catch((err) => {
          if (!active) return;
          console.warn('[useSecureDocumentBlob] Error loading document:', err);
          setError(err.message || 'Gagal memuat dokumen');
          setLoading(false);
        });
    } else {
      setBlobUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setLoading(false);
      setError(null);
    }

    return () => {
      active = false;
      if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
      }
    };
  }, [rawPath, enabled, authFetch]);

  return { blobUrl, loading, error };
}
