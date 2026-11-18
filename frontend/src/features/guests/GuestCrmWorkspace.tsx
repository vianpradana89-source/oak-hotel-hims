import React, { useCallback, useEffect, useState } from 'react';
import {
  Gift,
  Hotel,
  Users,
} from 'lucide-react';
import type {
  DuplicateCandidateCluster,
  Guest,
  GuestCrmSummary,
  GuestCrmTab,
  PropertyLoyaltySettings,
} from './guestTypes';
import { GuestCrmSummaryPanel } from './GuestCrmSummaryPanel';
import { GuestDatabaseTable } from './GuestDatabaseTable';
import { GuestProfileModal } from './GuestProfileModal';
import { GuestEditModal } from './GuestEditModal';
import { GuestDuplicateModal } from './GuestDuplicateModal';
import { GuestLoyaltyPanel } from './GuestLoyaltyPanel';
import { authenticatedFetch } from '../../lib/authenticatedFetch';

interface GuestCrmWorkspaceProps {
  propertyId: number | null;
}

const DEFAULT_WA_MESSAGES = {
  birthday:
    'Selamat ulang tahun ke-{umur} {nama}! 🎉 Semoga sehat, bahagia, dan sukses selalu. Ada hadiah spesial dari {toko} untuk Anda.',
  followup:
    'Halo {nama}, apa kabar? Kami dari {toko} merindukan kunjungan Anda sejak {terakhir}. Dapatkan promo spesial untuk kunjungan berikutnya!',
  database:
    'Halo {nama}, terima kasih telah menjadi pelanggan setia {toko}. Hubungi kami untuk reservasi kamar atau promo terbaru!',
};

export const GuestCrmWorkspace: React.FC<GuestCrmWorkspaceProps> = ({ propertyId }) => {
  const [activeTab, setActiveTab] = useState<GuestCrmTab>('summary');
  const [guests, setGuests] = useState<Guest[]>([]);
  const [crmSummary, setCrmSummary] = useState<GuestCrmSummary | null>(null);
  const [duplicateClusters, setDuplicateClusters] = useState<DuplicateCandidateCluster[]>([]);
  const [loyaltySettings, setLoyaltySettings] = useState<PropertyLoyaltySettings | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Modals state
  const [selectedGuestId, setSelectedGuestId] = useState<number | null>(null);
  const [editingGuest, setEditingGuest] = useState<Guest | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState<boolean>(false);
  const [isDuplicateModalOpen, setIsDuplicateModalOpen] = useState<boolean>(false);

  // Quick WA Message Template Modal (Ref. Gambar 3)
  const [waModalTarget, setWaModalTarget] = useState<'birthday' | 'followup' | 'database' | null>(null);
  const [waMessageDraft, setWaMessageDraft] = useState<string>('');
  const [savingWaTemplate, setSavingWaTemplate] = useState<boolean>(false);
  const [quickDatabaseSearch, setQuickDatabaseSearch] = useState<string>('');

  // Authoritative Jakarta hotel date
  const hotelDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

  const loadData = useCallback(async () => {
    if (!propertyId) return;

    setLoading(true);
    setError(null);

    try {
      const [guestsRes, summaryRes, dupRes, settingsRes] = await Promise.all([
        authenticatedFetch(`/api/guests?property_id=${propertyId}&limit=1000`),
        authenticatedFetch(`/api/guests/crm-summary?property_id=${propertyId}&hotel_date=${hotelDate}`),
        authenticatedFetch(`/api/guests/duplicate-candidates?property_id=${propertyId}`),
        authenticatedFetch(`/api/guests/loyalty-settings?property_id=${propertyId}`),
      ]);

      if (!guestsRes.ok || !summaryRes.ok || !dupRes.ok) {
        throw new Error('Gagal memuat sebagian data CRM dari server.');
      }

      const guestsJson = await guestsRes.json();
      const summaryJson = await summaryRes.json();
      const dupJson = await dupRes.json();
      const settingsJson = settingsRes.ok ? await settingsRes.json() : { data: null };

      setGuests(guestsJson.data || []);
      setCrmSummary(summaryJson.data || null);
      setDuplicateClusters(dupJson.data || []);
      if (settingsJson?.data) {
        setLoyaltySettings(settingsJson.data);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Terjadi kesalahan sistem saat memuat CRM';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [propertyId, hotelDate]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleOpenProfile = (guestId: number) => {
    setSelectedGuestId(guestId);
  };

  const handleCreateNew = () => {
    setEditingGuest(null);
    setIsEditModalOpen(true);
  };

  const handleEditGuest = (guest: Guest) => {
    setEditingGuest(guest);
    setIsEditModalOpen(true);
  };

  const handleGuestSaved = (_savedGuest: Guest) => {
    loadData();
  };

  const handleOpenWaTemplateModal = (target: 'birthday' | 'followup' | 'database') => {
    setWaModalTarget(target);
    if (target === 'birthday') {
      setWaMessageDraft(loyaltySettings?.wa_birthday_message || DEFAULT_WA_MESSAGES.birthday);
    } else if (target === 'followup') {
      setWaMessageDraft(loyaltySettings?.wa_followup_message || DEFAULT_WA_MESSAGES.followup);
    } else {
      setWaMessageDraft(loyaltySettings?.wa_database_message || DEFAULT_WA_MESSAGES.database);
    }
  };

  const handleSaveWaTemplate = async () => {
    if (!propertyId || !waModalTarget) return;
    setSavingWaTemplate(true);
    try {
      const payload: Record<string, unknown> = { property_id: propertyId };
      if (waModalTarget === 'birthday') payload.wa_birthday_message = waMessageDraft;
      if (waModalTarget === 'followup') payload.wa_followup_message = waMessageDraft;
      if (waModalTarget === 'database') payload.wa_database_message = waMessageDraft;

      const res = await authenticatedFetch('/api/guests/loyalty-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.data) setLoyaltySettings(json.data);
      }
      setWaModalTarget(null);
    } finally {
      setSavingWaTemplate(false);
    }
  };

  if (!propertyId) {
    return (
      <div className="bg-white border border-stone-200 rounded-2xl p-12 text-center text-stone-500 shadow-xs">
        <Hotel className="w-8 h-8 mx-auto mb-2 text-stone-400" />
        <p className="font-semibold text-stone-700 text-sm">Pilih properti terlebih dahulu</p>
        <p className="text-xs text-stone-400 mt-1">
          Data CRM tamu disesuaikan dan diisolasi secara ketat per properti aktif.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Header & Navigation Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-stone-200">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-xl font-bold text-stone-900 tracking-tight">
              Manajemen Pelanggan & CRM
            </h1>
            <span className="text-[11px] bg-stone-100 text-stone-600 px-2 py-0.5 rounded font-mono">
              Property ID: #{propertyId}
            </span>
          </div>
          <p className="text-xs text-stone-500 mt-0.5">
            Database profil tamu terpadu, reaktivasi pelanggan, merger duplikat, dan program loyalitas.
          </p>
        </div>

        {/* Clean 2-Tab Switcher with Lucide Icons */}
        <div className="flex items-center space-x-1 bg-stone-100 p-1 rounded-xl border border-stone-200">
          <button
            type="button"
            onClick={() => setActiveTab('summary')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'summary' || activeTab === 'database'
                ? 'bg-white text-[#1E392A] shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>CRM & Database Pelanggan ({guests.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('loyalty')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'loyalty'
                ? 'bg-white text-[#1E392A] shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            <Gift className="w-3.5 h-3.5" />
            <span>Program Loyalitas & Poin</span>
          </button>
        </div>
      </div>

      {/* Global Error Banner */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={loadData}
            className="px-2.5 py-1 bg-red-100 hover:bg-red-200 text-red-800 rounded font-semibold transition-colors cursor-pointer"
          >
            Coba Lagi
          </button>
        </div>
      )}

      {/* Unified CRM Summary + Database Pelanggan (Ref. Gambar 4) */}
      {(activeTab === 'summary' || activeTab === 'database') && (
        <div className="space-y-6">
          <GuestCrmSummaryPanel
            summary={crmSummary}
            loading={loading}
            loyaltySettings={loyaltySettings}
            onSelectGuest={handleOpenProfile}
            onOpenDuplicateReview={() => setIsDuplicateModalOpen(true)}
            duplicateCount={duplicateClusters.length}
            onOpenWaTemplateModal={handleOpenWaTemplateModal}
            onQuickFilterDatabase={(q) => setQuickDatabaseSearch(q)}
          />

          <GuestDatabaseTable
            propertyId={propertyId}
            guests={guests}
            loading={loading}
            hotelDate={hotelDate}
            loyaltySettings={loyaltySettings}
            externalSearchQuery={quickDatabaseSearch}
            onSelectGuest={handleOpenProfile}
            onEditGuest={handleEditGuest}
            onCreateGuest={handleCreateNew}
            onMerged={loadData}
            onOpenWaTemplateModal={handleOpenWaTemplateModal}
          />
        </div>
      )}

      {activeTab === 'loyalty' && (
        <GuestLoyaltyPanel
          propertyId={propertyId}
          guests={guests}
          loyaltySettings={loyaltySettings}
          onRefreshGuests={loadData}
          onSelectGuest={handleOpenProfile}
        />
      )}

      {/* Modals */}
      <GuestProfileModal
        guestId={selectedGuestId}
        propertyId={propertyId}
        isOpen={Boolean(selectedGuestId)}
        onClose={() => setSelectedGuestId(null)}
        onEditGuest={(g) => {
          setSelectedGuestId(null);
          handleEditGuest(g);
        }}
        onGuestUpdated={loadData}
      />

      <GuestEditModal
        isOpen={isEditModalOpen}
        guest={editingGuest}
        propertyId={propertyId}
        onClose={() => {
          setIsEditModalOpen(false);
          setEditingGuest(null);
        }}
        onSaved={handleGuestSaved}
      />

      <GuestDuplicateModal
        isOpen={isDuplicateModalOpen}
        propertyId={propertyId}
        clusters={duplicateClusters}
        loading={loading}
        onClose={() => setIsDuplicateModalOpen(false)}
        onSelectGuest={handleOpenProfile}
        onMerged={loadData}
      />

      {/* WhatsApp Template Editor Modal (Ref. Gambar 3) */}
      {waModalTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4"
          onClick={() => setWaModalTarget(null)}
        >
          <div
            className="bg-[#FAF8F3] rounded-3xl shadow-2xl border border-[#E6DFC8] w-full max-w-lg p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-base font-bold text-stone-900">
                {waModalTarget === 'birthday'
                  ? 'Pesan Ucapan Ulang Tahun'
                  : waModalTarget === 'followup'
                  ? 'Pesan Follow Up & Reaktivasi'
                  : 'Pesan WhatsApp Database Pelanggan'}
              </h3>
              <p className="text-xs text-stone-500 mt-1">
                {waModalTarget === 'birthday'
                  ? 'Pesan WhatsApp untuk pelanggan yang berulang tahun.'
                  : waModalTarget === 'followup'
                  ? 'Pesan WhatsApp untuk menyapa kembali pelanggan yang sudah lama tidak menginap.'
                  : 'Pesan WhatsApp cepat saat menghubungi tamu dari tabel Database Pelanggan.'}
              </p>
            </div>

            <div>
              <textarea
                rows={4}
                value={waMessageDraft}
                onChange={(e) => setWaMessageDraft(e.target.value)}
                className="w-full p-3.5 text-sm text-stone-800 bg-[#FAF8F3] border-2 border-blue-600 rounded-2xl focus:outline-hidden focus:ring-2 focus:ring-blue-600/20"
              />
              <p className="text-xs text-stone-500 mt-2 font-mono">
                Variabel: &#123;nama&#125;, &#123;umur&#125;, &#123;toko&#125;, &#123;terakhir&#125;, &#123;total&#125;, &#123;ulangtahun&#125;
              </p>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setWaMessageDraft(DEFAULT_WA_MESSAGES[waModalTarget])}
                className="px-4 py-2.5 rounded-xl border border-[#E6DFC8] bg-white hover:bg-stone-50 text-xs font-bold text-stone-800 transition-colors cursor-pointer"
              >
                Reset Default
              </button>
              <button
                type="button"
                disabled={savingWaTemplate}
                onClick={handleSaveWaTemplate}
                className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-xs transition-colors disabled:opacity-50 cursor-pointer"
              >
                {savingWaTemplate ? 'Menyimpan...' : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
