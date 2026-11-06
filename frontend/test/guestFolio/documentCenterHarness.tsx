import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import html2pdf from 'html2pdf.js';
import DocumentCenter from '../../src/features/documents/DocumentCenter';

(window as any).html2pdf = html2pdf;
import sample1 from '../../../backend/test/fixtures/guest_folio_samples/sample_1_guest_folio_partial_payment.json';
import sample2 from '../../../backend/test/fixtures/guest_folio_samples/sample_2_guest_folio_paid_lunas.json';
import sample3 from '../../../backend/test/fixtures/guest_folio_samples/sample_3_guest_folio_long_multipage.json';

// Create a corrupted version of sample 1 with reconciliation mismatch
const sample4Corrupted = {
  ...sample1,
  reconciliation: {
    ...sample1.reconciliation,
    is_reconciled: false,
    discrepancy_amount: 50000,
    discrepancy_reasons: ['Selisih audit charges dan total summary: Rp 50.000'],
  },
};

// R7 Guard test: reconciliation is TRUE, but charge lines breakdown mismatch net_total_charges
const sample5ChargesMismatch = {
  ...sample1,
  reconciliation: {
    ...sample1.reconciliation,
    is_reconciled: true,
    discrepancy_amount: 0,
    discrepancy_reasons: [],
  },
  summary: {
    ...sample1.summary,
    net_total_charges: 1375000,
  },
  effective_lines: sample1.effective_lines.filter((l: any) => l.category === 'ROOM_CHARGE'),
};

// Also add a sibling room to sample 1 to test sibling switcher (GF-O01)
// Backend contract: booking_siblings contains other rooms in the multi-room booking (excluding active room)
const sample1WithSibling = {
  ...sample1,
  room_number: '101',
  is_multi_room_booking: true,
  booking_siblings: [
    {
      id: 999,
      reservation_id: 999,
      room_number: '102',
      room_type_name: 'Deluxe Room',
      guest_name: 'Bpk. Hendra Wijaya (Room 2)',
      status: 'BOOKED',
    },
  ],
};

const pickerList = [
  {
    id: 182,
    bid: 'TST001-261106-KSGF7BRR',
    guest_name: 'Bpk. Hendra Wijaya (Partial)',
    booker_name: 'Bpk. Hendra Wijaya',
    check_in: sample1.stay.check_in,
    check_out: sample1.stay.check_out,
    room_type_name: 'Deluxe Room',
    room_number: '101',
    status: 'BOOKED',
    total_price: sample1.summary.effective_total_charges,
  },
  {
    id: 183,
    bid: 'TST001-261106-PAID0001',
    guest_name: 'Ibu Siti Rahma (Lunas)',
    booker_name: 'Ibu Siti Rahma',
    check_in: sample2.stay.check_in,
    check_out: sample2.stay.check_out,
    room_type_name: 'Superior Room',
    room_number: '102',
    status: 'BOOKED',
    total_price: sample2.summary.effective_total_charges,
  },
  {
    id: 184,
    bid: 'TST001-261106-LONG0001',
    guest_name: 'Bpk. Bambang Soedirman (Long Stay)',
    booker_name: 'Bpk. Bambang Soedirman',
    check_in: sample3.stay.check_in,
    check_out: sample3.stay.check_out,
    room_type_name: 'Executive Suite',
    room_number: '201',
    status: 'BOOKED',
    total_price: sample3.summary.effective_total_charges,
  },
  {
    id: 185,
    bid: 'TST001-261106-CORR0001',
    guest_name: 'Bpk. Mismatch Corrupted (Unreconciled Guard)',
    booker_name: 'Bpk. Mismatch Corrupted',
    check_in: sample1.stay.check_in,
    check_out: sample1.stay.check_out,
    room_type_name: 'Deluxe Room',
    room_number: '101',
    status: 'BOOKED',
    total_price: 1375000,
  },
  {
    id: 186,
    bid: 'TST001-261106-CHGDISC01',
    guest_name: 'Bpk. Charges Mismatch (R7 Guard)',
    booker_name: 'Bpk. Charges Mismatch',
    check_in: sample1.stay.check_in,
    check_out: sample1.stay.check_out,
    room_type_name: 'Deluxe Room',
    room_number: '101',
    status: 'BOOKED',
    total_price: 1375000,
  },
  {
    id: 999,
    bid: 'TST001-261106-KSGF7BRR',
    guest_name: 'Bpk. Hendra Wijaya (Room 2)',
    booker_name: 'Bpk. Hendra Wijaya',
    check_in: sample1.stay.check_in,
    check_out: sample1.stay.check_out,
    room_type_name: 'Deluxe Room',
    room_number: '102',
    status: 'BOOKED',
    total_price: 600000,
  },
];

const sample1SecondNight = new Date(Date.parse(sample1.stay.check_in + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);

const mockReservationDetail = {
  id: 182,
  bid: 'TST001-261106-KSGF7BRR',
  legacy_booking_number: 'WALKIN-20261106-0002',
  guest_name: 'Bpk. Hendra Wijaya',
  guest_phone: '081234560002',
  guest_email: 'hendra.wijaya@example.com',
  guest_address: 'Jl. Sudirman No. 45, Jakarta',
  booker_name: 'Bpk. Hendra Wijaya',
  booker_phone: '081234560002',
  booker_email: 'hendra.wijaya@example.com',
  contact_person: 'Bpk. Hendra Wijaya',
  check_in: sample1.stay.check_in,
  check_out: sample1.stay.check_out,
  room_type_name: 'Deluxe Room',
  room_type: 'Deluxe Room',
  room_number: '101',
  adults: 2,
  children: 0,
  infants: 0,
  special_requests: 'Tamu VIP, mohon siapkan buah selamat datang di kamar.',
  notes: 'Tamu VIP, mohon siapkan buah selamat datang di kamar.',
  booking_source: 'DIRECT',
  booking_channel: 'WALK_IN',
  total_price: 1375000,
  amount_paid: 750000,
  applied_deposit: 0,
  remaining_balance: 625000,
  payment_status: 'PARTIAL',
  financials: {
    total_price: 1375000,
    amount_paid: 750000,
    remaining_balance: 625000,
    payment_status: 'PARTIAL',
  },
  rate_snapshot: {
    reservation_id: 182,
    nightly_rates: [
      {
        stay_date: sample1.stay.check_in,
        hotel_date: sample1.stay.check_in,
        total_amount: 600000,
        final_room_rate: 600000,
        final_rate: 600000,
        base_rate: 600000,
        note: null,
        notes: null,
      },
      {
        stay_date: sample1SecondNight,
        hotel_date: sample1SecondNight,
        total_amount: 600000,
        final_room_rate: 600000,
        final_rate: 600000,
        base_rate: 600000,
        note: null,
        notes: null,
      },
    ],
  },
};

const mockQuotationDraft = {
  reference: 'Q-20261106-001',
  recipient_name: 'PT Mitra Sukses Mandiri',
  recipient_phone: '081298765432',
  recipient_email: 'procurement@mitrasukses.co.id',
  recipient_address: 'Wisma GKBI Lt. 12, Jakarta Pusat',
  check_in: '2026-11-15',
  check_out: '2026-11-17',
  nights: 2,
  items: [
    {
      description: 'Deluxe Room (Twin Bed) - Termasuk Sarapan 2 Pax',
      qty: 5,
      rate_per_unit: 650000,
      total_rate: 6500000,
    },
    {
      description: 'Meeting Room Package (Full Day) 16 Nov 2026',
      qty: 1,
      rate_per_unit: 2500000,
      total_rate: 2500000,
    },
  ],
  subtotal: 9000000,
  tax_amount: 900000,
  total_price: 9900000,
  notes: 'Penawaran berlaku hingga 10 November 2026.',
  terms: 'Uang muka 50% saat konfirmasi pemesanan, pelunasan H-3 kedatangan.',
};

const mockAuthFetch = async (url: string, _options?: RequestInit) => {
  const u = new URL(url, 'http://localhost');
  const pathname = u.pathname;

  // Picker list
  if (pathname === '/api/documents/reservations') {
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'OK', data: pickerList }),
    } as Response;
  }

  // Folio detail
  const folioMatch = pathname.match(/\/api\/documents\/reservations\/(\d+)\/folio/);
  if (folioMatch) {
    const id = Number(folioMatch[1]);
    let base = sample1WithSibling;
    if (id === 183) base = sample2 as any;
    else if (id === 184) base = sample3 as any;
    else if (id === 185) base = sample4Corrupted as any;
    else if (id === 186) base = sample5ChargesMismatch as any;
    else if (id === 999) {
      base = {
        ...sample1,
        is_multi_room_booking: true,
        booking_siblings: [
          {
            id: 182,
            reservation_id: 182,
            room_number: '101',
            room_type_name: 'Deluxe Room',
            guest_name: 'Bpk. Hendra Wijaya',
            status: 'BOOKED',
          },
        ],
        reservation_id: 999,
        room_number: '102',
        stay: {
          ...sample1.stay,
          room_number: '102',
        },
        reservation: {
          ...sample1.reservation,
          id: 999,
          reservation_code: 'TST001-261106-999 / RES-999',
        },
      } as any;
    }
    const data = {
      ...base,
      reservation_id: id,
      reservation: {
        ...(base as any).reservation,
        id,
        room_number: id === 999 ? '102' : (base as any).room_number,
      },
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'OK', data }),
    } as Response;
  }

  // Reservation detail (for confirmation)
  const resMatch = pathname.match(/\/api\/documents\/reservations\/(\d+)$/);
  if (resMatch) {
    return {
      ok: true,
      status: 200,
      json: async () => {
        const id = Number(resMatch[1]);
        const picker = pickerList.find((p) => p.id === id);
        const isPaid = id === 183;
        const isLong = id === 184;
        const totalPrice = picker?.total_price || mockReservationDetail.total_price;
        const amountPaid = isPaid ? 750000 : isLong ? totalPrice : mockReservationDetail.amount_paid;
        const appliedDeposit = isPaid ? 625000 : 0;
        const remainingBalance = isPaid || isLong ? 0 : Math.max(0, totalPrice - amountPaid - appliedDeposit);
        const paymentStatus = isPaid || isLong ? 'PAID' : 'PARTIAL';
        const fixtureStay = isLong ? sample3.stay : isPaid ? sample2.stay : sample1.stay;
        const checkIn = fixtureStay.check_in;
        const checkOut = fixtureStay.check_out;
        const nights = fixtureStay.nights;

        return {
          status: 'OK',
          data: {
            ...mockReservationDetail,
            id,
            guest_name: picker?.guest_name || mockReservationDetail.guest_name,
            booker_name: picker?.booker_name || mockReservationDetail.booker_name,
            bid: picker?.bid || mockReservationDetail.bid,
            room_number: picker?.room_number || mockReservationDetail.room_number,
            room_type_name: picker?.room_type_name || mockReservationDetail.room_type_name,
            room_type: picker?.room_type_name || mockReservationDetail.room_type,
            check_in: checkIn,
            check_out: checkOut,
            nights,
            total_price: totalPrice,
            amount_paid: amountPaid,
            applied_deposit: appliedDeposit,
            remaining_balance: remainingBalance,
            payment_status: paymentStatus,
            financials: {
              total_price: totalPrice,
              amount_paid: amountPaid,
              applied_deposit: appliedDeposit,
              remaining_balance: remainingBalance,
              payment_status: paymentStatus,
            },
          },
        };
      },
    } as Response;
  }

  // Quotation draft
  if (pathname.includes('/quotation-draft')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'OK', data: mockQuotationDraft }),
    } as Response;
  }

  // Payment instructions
  if (pathname.includes('/payment-instructions')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'OK',
        data: {
          bank_name: 'Bank Central Asia (BCA)',
          account_number: '123-456-7890',
          account_holder: 'PT OAK Hotel Management',
          instructions: 'Mohon cantumkan kode BID pada berita transfer.',
        },
      }),
    } as Response;
  }

  return {
    ok: false,
    status: 404,
    json: async () => ({ status: 'ERROR', message: 'Not Found' }),
  } as Response;
};

export default function TestHarness() {
  const [initialResId, setInitialResId] = useState<number>(182);
  const [initialKind, setInitialKind] = useState<'confirmation' | 'quotation' | 'folio'>('folio');

  return (
    <div className="test-harness-wrapper" style={{ minHeight: '100vh', background: '#f8fafc', padding: '16px' }}>
      <style>{`
        @media print {
          .test-harness-controller {
            display: none !important;
          }
          .test-harness-wrapper {
            padding: 0 !important;
            margin: 0 !important;
            background: #fff !important;
            min-height: 0 !important;
          }
        }
      `}</style>
      <div className="test-harness-controller" style={{ marginBottom: '12px', display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={{ fontWeight: 'bold' }}>Test Controller:</span>
        <button
          id="btn-select-partial"
          onClick={() => { setInitialResId(182); setInitialKind('folio'); }}
          style={{ padding: '6px 12px', background: '#0284c7', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
        >
          Load Partial (182)
        </button>
        <button
          id="btn-select-paid"
          onClick={() => { setInitialResId(183); setInitialKind('folio'); }}
          style={{ padding: '6px 12px', background: '#16a34a', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
        >
          Load Paid (183)
        </button>
        <button
          id="btn-select-long"
          onClick={() => { setInitialResId(184); setInitialKind('folio'); }}
          style={{ padding: '6px 12px', background: '#9333ea', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
        >
          Load Long (184)
        </button>
        <button
          id="btn-select-corrupted"
          onClick={() => { setInitialResId(185); setInitialKind('folio'); }}
          style={{ padding: '6px 12px', background: '#dc2626', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
        >
          Load Corrupted (185)
        </button>
        <button
          id="btn-select-corrupted-bill"
          onClick={() => { setInitialResId(185); setInitialKind('confirmation'); }}
          style={{ padding: '6px 12px', background: '#b91c1c', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
        >
          Load Corrupted Bill (185)
        </button>
        <button
          id="btn-select-chg-mismatch"
          onClick={() => { setInitialResId(186); setInitialKind('confirmation'); }}
          style={{ padding: '6px 12px', background: '#991b1b', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
        >
          Load Chg Mismatch (186)
        </button>
        <button
          id="btn-select-confirmation"
          onClick={() => { setInitialResId(182); setInitialKind('confirmation'); }}
          style={{ padding: '6px 12px', background: '#ea580c', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
        >
          Load Guest Bill
        </button>
        <button
          id="btn-select-bill-paid"
          onClick={() => { setInitialResId(183); setInitialKind('confirmation'); }}
          style={{ padding: '6px 12px', background: '#059669', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
        >
          Load Guest Bill (Paid)
        </button>
        <button
          id="btn-select-bill-long"
          onClick={() => { setInitialResId(184); setInitialKind('confirmation'); }}
          style={{ padding: '6px 12px', background: '#7c3aed', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
        >
          Load Guest Bill (Long)
        </button>
        <button
          id="btn-select-quotation"
          onClick={() => { setInitialResId(182); setInitialKind('quotation'); }}
          style={{ padding: '6px 12px', background: '#ca8a04', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
        >
          Load Quotation
        </button>
      </div>

      <DocumentCenter
        key={`${initialResId}-${initialKind}`}
        propertyInfo={{
          id: 1,
          name: 'OAK Tree Urban Resort',
          address: 'Jl. Raya Lawang No. 123, Lawang, Kab. Malang, Jawa Timur',
          phone: '+62 341 555-0199',
        }}
        propertyBranding={{
          displayName: 'OAK Tree Resort',
        }}
        propertyId={1}
        authFetch={mockAuthFetch as any}
        initialReservationId={initialResId}
        initialKind={initialKind}
      />
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<TestHarness />);
}
