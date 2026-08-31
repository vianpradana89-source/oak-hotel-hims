import React, { useCallback, useEffect, useState } from 'react';
import type {
  DuplicateCandidateCluster,
  Guest,
  GuestCrmSummary,
  GuestCrmTab
} from './guestTypes';
import { GuestCrmSummaryPanel } from './GuestCrmSummaryPanel';
import { GuestDatabaseTable } from './GuestDatabaseTable';
import { GuestProfileModal } from './GuestProfileModal';
import { GuestEditModal } from './GuestEditModal';
import { GuestDuplicateModal } from './GuestDuplicateModal';

interface GuestCrmWorkspaceProps {
  propertyId: number | null;
}

export const GuestCrmWorkspace: React.FC<GuestCrmWorkspaceProps> = ({ propertyId }) => {
  const [activeTab, setActiveTab] = useState<GuestCrmTab>('summary');
  const [guests, setGuests] = useState<Guest[]>([]);
  const [crmSummary, setCrmSummary] = useState<GuestCrmSummary | null>(null);
  const [duplicateClusters, setDuplicateClusters] = useState<DuplicateCandidateCluster[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Modals state
  const [selectedGuestId, setSelectedGuestId] = useState<number | null>(null);
  const [editingGuest, setEditingGuest] = useState<Guest | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState<boolean>(false);
  const [isDuplicateModalOpen, setIsDuplicateModalOpen] = useState<boolean>(false);

  // Authoritative Jakarta hotel date
  const hotelDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

  const loadData = useCallback(async () => {
    if (!propertyId) return;

    setLoading(true);
    setError(null);

    try {
      const [guestsRes, summaryRes, dupRes] = await Promise.all([
        fetch(`/api/guests?property_id=${propertyId}`),
        fetch(`/api/guests/crm-summary?property_id=${propertyId}&hotel_date=${hotelDate}`),
        fetch(`/api/guests/duplicate-candidates?property_id=${propertyId}`)
      ]);

      if (!guestsRes.ok || !summaryRes.ok || !dupRes.ok) {
        throw new Error('Gagal memuat sebagian data CRM dari server.');
      }

      const guestsJson = await guestsRes.json();
      const summaryJson = await summaryRes.json();
      const dupJson = await dupRes.json();

      setGuests(guestsJson.data || []);
      setCrmSummary(summaryJson.data || null);
      setDuplicateClusters(dupJson.data || []);
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

  if (!propertyId) {
    return (
      <div className="bg-white border border-stone-200 rounded-lg p-12 text-center text-stone-500 shadow-xs">
        <span className="text-3xl block mb-2">🏨</span>
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
            Database profil tamu, analisis loyalitas, dan riwayat menginap properti.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center space-x-1 bg-stone-100 p-1 rounded-lg border border-stone-200">
          <button
            onClick={() => setActiveTab('summary')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
              activeTab === 'summary'
                ? 'bg-white text-[#1E392A] shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            📊 Ringkasan CRM
          </button>
          <button
            onClick={() => setActiveTab('database')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
              activeTab === 'database'
                ? 'bg-white text-[#1E392A] shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            📋 Database Pelanggan ({guests.length})
          </button>
          <button
            disabled
            className="px-3 py-1.5 text-xs font-medium text-stone-400 cursor-not-allowed flex items-center space-x-1"
            title="Program Loyalitas akan hadir pada fase mendatang"
          >
            <span>🎁 Loyalitas</span>
            <span className="text-[9px] bg-stone-200 text-stone-500 px-1 py-0.2 rounded">
              Segera
            </span>
          </button>
        </div>
      </div>

      {/* Global Error Banner */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={loadData}
            className="px-2.5 py-1 bg-red-100 hover:bg-red-200 text-red-800 rounded font-semibold transition-colors"
          >
            Coba Lagi
          </button>
        </div>
      )}

      {/* Tab Panels */}
      {activeTab === 'summary' && (
        <GuestCrmSummaryPanel
          summary={crmSummary}
          loading={loading}
          onSelectGuest={handleOpenProfile}
          onOpenDuplicateReview={() => setIsDuplicateModalOpen(true)}
          duplicateCount={duplicateClusters.length}
        />
      )}

      {activeTab === 'database' && (
        <GuestDatabaseTable
          guests={guests}
          loading={loading}
          hotelDate={hotelDate}
          onSelectGuest={handleOpenProfile}
          onEditGuest={handleEditGuest}
          onCreateGuest={handleCreateNew}
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
        clusters={duplicateClusters}
        loading={loading}
        onClose={() => setIsDuplicateModalOpen(false)}
        onSelectGuest={handleOpenProfile}
      />
    </div>
  );
};
