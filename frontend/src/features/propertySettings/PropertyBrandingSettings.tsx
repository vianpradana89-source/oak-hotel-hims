import React, { useState, useEffect } from 'react';
import type { PropertyBrandingConfig } from './propertyBrandingTypes';
import { isValidHexColor } from './propertyBrandingTypes';
import { Card, CardHeader, CardTitle, CardContent } from '../../design-system/Card';
import { Button } from '../../design-system/Button';
import { Input } from '../../design-system/Input';
import { OakLogo } from '../../design-system/OakLogo';

export interface PropertyBrandingSettingsProps {
  propertyId: number;
  initialBranding: PropertyBrandingConfig;
  onSaveBranding: (updated: PropertyBrandingConfig) => Promise<void> | void;
  isLoading?: boolean;
}

export const PropertyBrandingSettings: React.FC<PropertyBrandingSettingsProps> = ({
  propertyId: _propertyId,
  initialBranding,
  onSaveBranding,
  isLoading = false,
}) => {
  const [form, setForm] = useState<PropertyBrandingConfig>(initialBranding);
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setForm(initialBranding);
  }, [initialBranding]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSavedSuccess(false);

    // Validate colors
    if (!isValidHexColor(form.primaryColor)) {
      setErrorMessage('Warna Utama tidak valid. Gunakan format HEX (contoh: #1b4332).');
      return;
    }
    if (!isValidHexColor(form.accentColor)) {
      setErrorMessage('Warna Aksen tidak valid. Gunakan format HEX (contoh: #c5a880).');
      return;
    }

    try {
      setIsSaving(true);
      await onSaveBranding(form);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 4000);
    } catch (err: any) {
      setErrorMessage(err.message || 'Gagal menyimpan pengaturan branding.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12 flex flex-col items-center justify-center gap-3">
          <div className="w-8 h-8 border-3 border-emerald-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-slate-500 font-medium">Memuat konfigurasi branding...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Branding & Tampilan Properti</CardTitle>
            <p className="text-xs text-slate-500 mt-0.5">
              Kelola identitas visual, nama display, dan tema warna properti aktif.
            </p>
          </div>
          <OakLogo variant="compact" size={32} />
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {savedSuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold rounded-lg flex items-center gap-2">
                <svg className="w-4 h-4 text-emerald-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
                Pengaturan branding berhasil disimpan ke database!
              </div>
            )}

            {errorMessage && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold rounded-lg flex items-center gap-2">
                <svg className="w-4 h-4 text-rose-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {errorMessage}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Nama Tampilan Properti (Display Name)"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="Contoh: OAK Lawang"
                required
                helperText="Nama yang tampil pada Global Bar, Sidebar, dan Header Laporan"
              />

              <Input
                label="Kode Singkat Properti (Short Name)"
                value={form.shortName}
                onChange={(e) => setForm({ ...form, shortName: e.target.value })}
                placeholder="Contoh: LWG"
                maxLength={10}
                required
                helperText="Kode 3-5 huruf untuk prefiks nomor invoice dan kamar"
              />
            </div>

            <Input
              label="Tagline / Deskripsi Singkat"
              value={form.tagline || ''}
              onChange={(e) => setForm({ ...form, tagline: e.target.value })}
              placeholder="Contoh: Comfort & Elegance in Lawang"
              helperText="Tampil di bawah nama properti pada dokumen operasional"
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">
                  Warna Utama Operasional (Primary Color)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={isValidHexColor(form.primaryColor) ? form.primaryColor : '#1b4332'}
                    onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                    className="w-10 h-9 p-1 rounded border border-slate-300 cursor-pointer"
                  />
                  <input
                    type="text"
                    value={form.primaryColor}
                    onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                    className="w-28 h-9 text-xs px-2.5 rounded border border-slate-300 font-mono"
                  />
                  <span className="text-[11px] text-slate-500">Default: #1b4332 (Forest Green)</span>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">
                  Warna Aksen Brand (Brand Accent)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={isValidHexColor(form.accentColor) ? form.accentColor : '#c5a880'}
                    onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
                    className="w-10 h-9 p-1 rounded border border-slate-300 cursor-pointer"
                  />
                  <input
                    type="text"
                    value={form.accentColor}
                    onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
                    className="w-28 h-9 text-xs px-2.5 rounded border border-slate-300 font-mono"
                  />
                  <span className="text-[11px] text-slate-500">Default: #c5a880 (Muted Gold)</span>
                </div>
              </div>
            </div>

            {/* Official Logo Destination Notice */}
            <div className="p-3.5 bg-amber-50/70 border border-amber-200/80 rounded-xl text-xs text-amber-900 space-y-1">
              <div className="font-semibold flex items-center gap-1.5 text-amber-800">
                <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Aset Logo Resmi Hotel
              </div>
              <p className="text-[11px] text-amber-800/90 leading-relaxed">
                Aset logo resmi hotel dikelola melalui direktori statis <code className="bg-amber-100 px-1 py-0.5 rounded font-mono text-[10px]">frontend/src/assets/branding/</code>.
                Simpan file logo resmi (<code className="font-mono text-[10px]">oak-logo-full.png</code>, <code className="font-mono text-[10px]">oak-logo-mark.png</code>) pada folder tersebut untuk digunakan secara otomatis.
              </p>
            </div>

            {/* Live Preview Panel */}
            <div className="p-4 bg-[#131b24] rounded-xl border border-slate-800 text-slate-100 space-y-3 mt-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
                Pratinjau Visual Identitas Properti
              </div>
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-3 bg-slate-900/80 rounded-lg border border-slate-800">
                <OakLogo
                  variant="full"
                  size={36}
                  brandTitle={form.displayName || 'OAK HIMS'}
                  subtitle={form.tagline || 'Hospitality Management System'}
                  accentColor={form.accentColor}
                />
                <div className="text-right text-xs">
                  <span className="inline-block px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono font-bold">
                    {form.shortName || 'PRP'}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button type="submit" variant="primary" isLoading={isSaving}>
                Simpan Pengaturan Branding
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
