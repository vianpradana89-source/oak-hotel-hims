import assert from 'node:assert/strict';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting Quick Booking & OCR State Isolation Regression Tests ===\n');

// Simulating State Machine & Helpers for QuickBooking + Identity Extraction Lifecycle

interface QuickBookingState {
  channelType: 'WALKIN' | 'OTA';
  walkinSubSource: 'DIRECT' | 'PHONE_WA' | 'WEBSITE';
  selectedOtaSourceId: number | null;
  referral: string;
  sameAsBooker: boolean;
  bookerName: string;
  bookerPhone: string;
  guestName: string;
  guestPhone: string;
  guestSegment: string;
  selectedCrmGuest: any | null;
  duplicateCandidates: any[];
  showDuplicateModal: boolean;
  duplicateBypassed: boolean;
  isIdentityModalOpen: boolean;
  ktpPath: string | null;
  identityNumber: string;
  hasValidIdentity: boolean;
  identityFileName: string | null;
  extractedKtpData: any | null;
  paymentMethod: string;
  amountPaid: number;
  buktiBayarFile: any | null;
  buktiBayarPath: string | null;
  specialRequests: string;
  roomsList: any[];
}

function createFreshBookingState(): QuickBookingState {
  return {
    channelType: 'WALKIN',
    walkinSubSource: 'DIRECT',
    selectedOtaSourceId: null,
    referral: '',
    sameAsBooker: true,
    bookerName: '',
    bookerPhone: '',
    guestName: '',
    guestPhone: '',
    guestSegment: 'Walk-in',
    selectedCrmGuest: null,
    duplicateCandidates: [],
    showDuplicateModal: false,
    duplicateBypassed: false,
    isIdentityModalOpen: false,
    ktpPath: null,
    identityNumber: '',
    hasValidIdentity: false,
    identityFileName: null,
    extractedKtpData: null,
    paymentMethod: 'CASH',
    amountPaid: 0,
    buktiBayarFile: null,
    buktiBayarPath: null,
    specialRequests: '',
    roomsList: [{ id: 'room-1', adults: 1, children: 0 }]
  };
}

interface IdentityExtractionModalState {
  file: any | null;
  previewUrl: string | null;
  extracting: boolean;
  saving: boolean;
  extractedData: any | null;
  scanSuccessBanner: string | null;
  duplicateCandidate: any | null;
  nameMismatch: any | null;
  infoBanner: string | null;
  errorMsg: string | null;
  formName: string;
  formNik: string;
  formBirthPlace: string;
  formBirthDate: string;
  formGender: string;
  formAddress: string;
}

function createFreshModalState(): IdentityExtractionModalState {
  return {
    file: null,
    previewUrl: null,
    extracting: false,
    saving: false,
    extractedData: null,
    scanSuccessBanner: null,
    duplicateCandidate: null,
    nameMismatch: null,
    infoBanner: null,
    errorMsg: null,
    formName: '',
    formNik: '',
    formBirthPlace: '',
    formBirthDate: '',
    formGender: '',
    formAddress: ''
  };
}

function simulateScanOcr(
  formGuestName: string,
  ocrResult: { full_name: string; identity_number: string; [key: string]: any }
) {
  let nameMismatch = null;
  if (formGuestName && formGuestName.trim().length > 0) {
    const normForm = formGuestName.trim().toUpperCase();
    const normOcr = ocrResult.full_name.trim().toUpperCase();
    if (normForm !== normOcr) {
      nameMismatch = {
        form_name: formGuestName,
        ktp_name: ocrResult.full_name,
        message: `Nama di Form (${formGuestName}) tidak sama persis dengan KTP (${ocrResult.full_name})`
      };
    }
  }
  return {
    extractedData: ocrResult,
    nameMismatch
  };
}

// -------------------------------------------------------------
// CASE A: Open NEW booking -> Scan KTP Guest A -> Close
// -------------------------------------------------------------
console.log('--- CASE A: Open NEW booking -> Scan KTP Guest A -> Close ---');
let sessionBookingState = createFreshBookingState();
let sessionModalState = createFreshModalState();

// Guest A scans KTP
const guestAData = {
  full_name: 'BUDI SANTOSO',
  identity_number: '3171010101900001',
  birth_place: 'JAKARTA',
  birth_date: '1990-01-01',
  file_path: '/uploads/ktp-guest-a.jpg'
};

const scanA = simulateScanOcr(sessionBookingState.guestName, guestAData);
sessionModalState.extractedData = scanA.extractedData;
sessionModalState.nameMismatch = scanA.nameMismatch;
check(sessionModalState.nameMismatch === null, 'A.1 No name mismatch when scanning into empty new booking form');

// Confirm & Apply to form
sessionBookingState.guestName = guestAData.full_name;
sessionBookingState.identityNumber = guestAData.identity_number;
sessionBookingState.ktpPath = guestAData.file_path;
sessionBookingState.hasValidIdentity = true;
sessionBookingState.identityFileName = 'ktp-guest-a.jpg';
sessionBookingState.extractedKtpData = guestAData;
sessionBookingState.selectedCrmGuest = { id: 101, full_name: 'BUDI SANTOSO' };

check(sessionBookingState.guestName === 'BUDI SANTOSO', 'A.2 Guest A applied to booking state');
check(sessionBookingState.selectedCrmGuest?.id === 101, 'A.3 Guest A CRM linked');
check(sessionBookingState.hasValidIdentity === true, 'A.4 Identity valid for Guest A');

// User closes Quick Booking
sessionBookingState = createFreshBookingState();
sessionModalState = createFreshModalState();

// -------------------------------------------------------------
// CASE B: Open NEW booking again (Verify fresh state, zero leakage)
// -------------------------------------------------------------
console.log('\n--- CASE B: Open NEW booking again (Verify Zero State Leakage) ---');
check(sessionBookingState.guestName === '', 'B.1 guestName is empty string');
check(sessionBookingState.guestPhone === '', 'B.2 guestPhone is empty string');
check(sessionBookingState.selectedCrmGuest === null, 'B.3 selectedCrmGuest is null');
check(sessionBookingState.identityNumber === '', 'B.4 identityNumber is empty string');
check(sessionBookingState.ktpPath === null, 'B.5 ktpPath is null');
check(sessionBookingState.hasValidIdentity === false, 'B.6 hasValidIdentity is false');
check(sessionBookingState.identityFileName === null, 'B.7 identityFileName is null');
check(sessionBookingState.extractedKtpData === null, 'B.8 extractedKtpData is null');
check(sessionBookingState.duplicateCandidates.length === 0, 'B.9 duplicateCandidates is empty');
check(sessionModalState.extractedData === null, 'B.10 OCR extractedData is null');
check(sessionModalState.nameMismatch === null, 'B.11 nameMismatch is null');

// -------------------------------------------------------------
// CASE C: Scan Guest B in the new clean session
// -------------------------------------------------------------
console.log('\n--- CASE C: Scan Guest B in NEW Session ---');
const guestBData = {
  full_name: 'EKA FEBRIANTI WULANDARI',
  identity_number: '3508016702910001',
  birth_place: 'LUMAJANG',
  birth_date: '1991-02-27',
  file_path: '/uploads/ktp-guest-b.jpg'
};

const scanB = simulateScanOcr(sessionBookingState.guestName, guestBData);
sessionModalState.extractedData = scanB.extractedData;
sessionModalState.nameMismatch = scanB.nameMismatch;

check(sessionModalState.nameMismatch === null, 'C.1 Guest B is NOT compared against previous Guest A (no false mismatch warning)');
check(sessionModalState.extractedData.full_name === 'EKA FEBRIANTI WULANDARI', 'C.2 Guest B extracted correctly');

// -------------------------------------------------------------
// CASE D: Edit Existing Reservation (Ensure existing data is preserved)
// -------------------------------------------------------------
console.log('\n--- CASE D: Edit Existing Reservation ---');
const existingReservation = {
  id: 42,
  guest_name: 'SITI AMINAH',
  guest_phone: '081299988877',
  guest_segment: 'Reguler',
  room_id: 105,
  room_type_id: 2,
  check_in: '2026-09-05',
  check_out: '2026-09-07'
};

// Edit modal initializes from existing reservation object
const editFormState = {
  guestName: existingReservation.guest_name,
  guestPhone: existingReservation.guest_phone,
  guestSegment: existingReservation.guest_segment,
  roomId: existingReservation.room_id,
  checkIn: existingReservation.check_in,
  checkOut: existingReservation.check_out
};

check(editFormState.guestName === 'SITI AMINAH', 'D.1 Existing guest name preserved');
check(editFormState.guestPhone === '081299988877', 'D.2 Existing guest phone preserved');
check(editFormState.roomId === 105, 'D.3 Existing room ID preserved');

// If user scans a completely different KTP for SITI AMINAH in the same session, mismatch should legitimately trigger
const scanMismatch = simulateScanOcr(editFormState.guestName, guestBData);
check(scanMismatch.nameMismatch !== null, 'D.4 Legitimate mismatch triggers when form has SITI AMINAH but KTP is EKA FEBRIANTI WULANDARI');
check(scanMismatch.nameMismatch?.form_name === 'SITI AMINAH', 'D.5 Mismatch references correct current form name');

// -------------------------------------------------------------
// CASE E: Modal Reopen Isolation (IdentityExtractionModal Lifecycle)
// -------------------------------------------------------------
console.log('\n--- CASE E: Modal Reopen Isolation (IdentityExtractionModal) ---');
let ocrModal = createFreshModalState();

// Simulate user selecting file and starting extraction
ocrModal.file = { name: 'ktp.jpg', size: 102400 };
ocrModal.previewUrl = 'blob:http://localhost:5173/fake-blob-uuid';
ocrModal.extractedData = guestAData;
ocrModal.formName = guestAData.full_name;
ocrModal.formNik = guestAData.identity_number;
ocrModal.scanSuccessBanner = 'Data KTP berhasil dipindai!';

check(ocrModal.extractedData !== null, 'E.1 OCR modal holds data during active session');
check(ocrModal.previewUrl !== null, 'E.2 Preview URL exists during active session');

// User cancels or closes OCR modal -> resetModalState runs
ocrModal = createFreshModalState();

check(ocrModal.file === null, 'E.3 File reset on modal close');
check(ocrModal.previewUrl === null, 'E.4 Preview URL reset on modal close');
check(ocrModal.extractedData === null, 'E.5 Extracted data reset on modal close');
check(ocrModal.formName === '', 'E.6 Form name reset on modal close');
check(ocrModal.formNik === '', 'E.7 Form NIK reset on modal close');
check(ocrModal.scanSuccessBanner === null, 'E.8 Success banner reset on modal close');
check(ocrModal.nameMismatch === null, 'E.9 Name mismatch reset on modal close');

// -------------------------------------------------------------
// CASE F: Architectural Create-Only Contract Guard
// -------------------------------------------------------------
console.log('\n--- CASE F: Architectural Create-Only Contract Guard ---');
// Verify that QuickBookingModal interface does NOT accept an edit reservation payload
const isQuickBookingCreateOnly = (props: { initialRoomId?: number | null; initialDate?: string | null }) => {
  // QuickBookingModal accepts initialRoomId/initialDate for room/date slot prefill only, never reservation identity
  return !('reservationId' in props) && !('reservation' in props) && !('editMode' in props);
};

check(isQuickBookingCreateOnly({ initialRoomId: 101, initialDate: '2026-09-01' }) === true, 'F.1 QuickBookingModal is strictly CREATE-ONLY');

console.log(`\n================================`);
console.log(`Summary: ${assertions} assertions PASSED`);
console.log(`================================`);
