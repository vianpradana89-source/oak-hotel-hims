/**
 * WhatsApp Quick Action Hook — shared between ReservationDetailDrawer & QuickReservationDetail
 *
 * 规则：
 * - 不重复 state/handler/modal
 * - markGuestWhatsAppOpened 使用 communication log ID（result.log.id）
 * - 仅在 guest_phone 存在且未 CANCELLED/CHECKED_OUT 时可用
 */
import { useState, useCallback } from 'react';
import {
  listGuestCommunicationTemplates,
  prepareGuestWhatsApp,
  markGuestWhatsAppOpened,
  type GuestCommunicationTemplate,
} from '../guests/guestCommunicationApi';

export interface UseWhatsAppQuickActionOptions {
  activePropId: number | null;
  guestPhone: string;
  primaryGuestId?: number | null;
  reservationId?: number | null;
}

export interface UseWhatsAppQuickActionResult {
  // State
  isWhatsAppModalOpen: boolean;
  waTemplates: GuestCommunicationTemplate[];
  waTemplatesLoading: boolean;
  waSelectedTemplate: GuestCommunicationTemplate | null;
  waPreviewMessage: string | null;
  waDeepLink: string | null;
  waLoadingPreview: boolean;
  waError: string | null;
  waMarkingOpened: boolean;
  waCommunicationId: string | null;

  // Actions
  handleOpenWhatsAppModal: () => Promise<void>;
  handleSelectTemplate: (tpl: GuestCommunicationTemplate) => Promise<void>;
  handleSendWhatsApp: () => Promise<void>;
  setWhatsAppModalOpen: (open: boolean) => void;
}

export function useWhatsAppQuickAction(options: UseWhatsAppQuickActionOptions): UseWhatsAppQuickActionResult {
  const { activePropId, guestPhone, primaryGuestId, reservationId } = options;

  // ── State ────────────────────────────────────────────────────────────────
  const [isWhatsAppModalOpen, setIsWhatsAppModalOpen] = useState(false);
  const [waTemplates, setWaTemplates] = useState<GuestCommunicationTemplate[]>([]);
  const [waTemplatesLoading, setWaTemplatesLoading] = useState(false);
  const [waSelectedTemplate, setWaSelectedTemplate] = useState<GuestCommunicationTemplate | null>(null);
  const [waPreviewMessage, setWaPreviewMessage] = useState<string | null>(null);
  const [waDeepLink, setWaDeepLink] = useState<string | null>(null);
  const [waLoadingPreview, setWaLoadingPreview] = useState(false);
  const [waError, setWaError] = useState<string | null>(null);
  const [waMarkingOpened, setWaMarkingOpened] = useState(false);
  const [waCommunicationId, setWaCommunicationId] = useState<string | null>(null);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleOpenWhatsAppModal = useCallback(async () => {
    if (!activePropId || !guestPhone) return;
    setWaError(null);
    setWaSelectedTemplate(null);
    setWaPreviewMessage(null);
    setWaDeepLink(null);
    setWaCommunicationId(null);
    setWaTemplates([]);
    setWaTemplatesLoading(true);
    try {
      const templates = await listGuestCommunicationTemplates(activePropId);
      setWaTemplates(templates);
    } catch (err: any) {
      setWaError(err.message || 'Gagal memuat template komunikasi.');
    } finally {
      setWaTemplatesLoading(false);
    }
    setIsWhatsAppModalOpen(true);
  }, [activePropId, guestPhone]);

  const handleSelectTemplate = useCallback(async (tpl: GuestCommunicationTemplate) => {
    if (!activePropId || !primaryGuestId) return;
    setWaError(null);
    setWaPreviewMessage(null);
    setWaDeepLink(null);
    setWaCommunicationId(null);
    setWaLoadingPreview(true);
    try {
      const result = await prepareGuestWhatsApp(activePropId, {
        guest_id: primaryGuestId,
        reservation_id: reservationId ?? null,
        template_id: tpl.id,
      });
      setWaPreviewMessage(result.rendered_message);
      setWaDeepLink(result.whatsapp_deep_link);
      setWaCommunicationId(result.log.id);
      setWaSelectedTemplate(tpl);
    } catch (err: any) {
      setWaError(err.message || 'Gagal menyiapkan pesan WhatsApp.');
      setWaPreviewMessage(null);
      setWaDeepLink(null);
      setWaCommunicationId(null);
    } finally {
      setWaLoadingPreview(false);
    }
  }, [activePropId, primaryGuestId, reservationId]);

  const handleSendWhatsApp = useCallback(async () => {
    if (!waDeepLink || !waSelectedTemplate || !waCommunicationId || !activePropId) return;
    setWaMarkingOpened(true);
    setWaError(null);
    try {
      window.open(waDeepLink, '_blank', 'noopener,noreferrer');
      await markGuestWhatsAppOpened(activePropId, waCommunicationId);
      setIsWhatsAppModalOpen(false);
    } catch (err: any) {
      setWaError(err.message || 'Gagal menandai pesan sebagai dibuka.');
    } finally {
      setWaMarkingOpened(false);
    }
  }, [waDeepLink, waSelectedTemplate, waCommunicationId, activePropId]);

  return {
    isWhatsAppModalOpen,
    waTemplates,
    waTemplatesLoading,
    waSelectedTemplate,
    waPreviewMessage,
    waDeepLink,
    waLoadingPreview,
    waError,
    waMarkingOpened,
    waCommunicationId,
    handleOpenWhatsAppModal,
    handleSelectTemplate,
    handleSendWhatsApp,
    setWhatsAppModalOpen: setIsWhatsAppModalOpen,
  };
}
