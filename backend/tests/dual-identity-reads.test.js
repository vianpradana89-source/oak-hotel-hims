"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const BASE_URL = 'http://localhost:3000/api';
describe('Dual-Identity Read Support (Phase 1D.3)', () => {
    describe('GET /api/reservations/:id', () => {
        it('should return dual-identity fields for known reservation', async () => {
            const response = await axios_1.default.get(`${BASE_URL}/reservations/1`, {
                validateStatus: () => true,
            });
            expect(response.status).toBe(200);
            expect(response.data.status).toBe('OK');
            const res = response.data.data;
            // Backward compatibility: original `id` field must still exist
            expect(res.id).toBeDefined();
            expect(res.id).toBe(1);
            // New alias field must exist
            expect(res.reservation_id).toBeDefined();
            expect(res.reservation_id).toBe(1);
            // Legacy booking number must still exist
            expect(res.booking_number).toBeDefined();
            expect(res.legacy_booking_number).toBeDefined();
            expect(res.legacy_booking_number).toBe(res.booking_number);
            // New dual-identity fields
            expect(res.booking_id).toBeDefined(); // fk to bookings
            expect(res.bid).toBeDefined(); // from bookings join
            expect(res.stay_sequence).toBeDefined(); // position in stay sequence
            // Stay sequence should be set for backfilled reservations
            expect(res.stay_sequence).toBeGreaterThanOrEqual(0);
        });
        it('should handle legacy invalid-date reservations (rows 2, 3, 9)', async () => {
            for (const id of [2, 3, 9]) {
                const response = await axios_1.default.get(`${BASE_URL}/reservations/${id}`, {
                    validateStatus: () => true,
                });
                expect(response.status).toBe(200);
                expect(response.data.status).toBe('OK');
                const res = response.data.data;
                // Should be readable despite check_out <= check_in
                expect(res.id).toBe(id);
                expect(res.bid).toBeDefined();
                expect(res.booking_id).toBeDefined();
            }
        });
        it('should return 404 for nonexistent reservation', async () => {
            const response = await axios_1.default.get(`${BASE_URL}/reservations/999999`, {
                validateStatus: () => true,
            });
            expect(response.status).toBe(404);
            expect(response.data.status).toBe('ERROR');
        });
        it('should preserve all original fields unchanged', async () => {
            const response = await axios_1.default.get(`${BASE_URL}/reservations/1`, {
                validateStatus: () => true,
            });
            const res = response.data.data;
            // All original fields must still exist
            expect(res.guest_name).toBeDefined();
            expect(res.check_in).toBeDefined();
            expect(res.check_out).toBeDefined();
            expect(res.payment_status).toBeDefined();
            expect(res.status).toBeDefined();
            expect(res.room_id).toBeDefined();
        });
    });
    describe('GET /api/reservations/:id/folio', () => {
        it('should return dual-identity fields in folio view', async () => {
            const response = await axios_1.default.get(`${BASE_URL}/reservations/1/folio`, {
                validateStatus: () => true,
            });
            expect(response.status).toBe(200);
            expect(response.data.status).toBe('OK');
            const folio = response.data.data;
            // Folio should include dual-identity fields
            expect(folio.id).toBeDefined();
            expect(folio.reservation_id).toBeDefined();
            expect(folio.bid).toBeDefined();
            expect(folio.booking_id).toBeDefined();
            expect(folio.stay_sequence).toBeDefined();
            expect(folio.legacy_booking_number).toBeDefined();
            // Folio items
            expect(Array.isArray(folio.folioItems)).toBe(true);
        });
    });
    describe('GET /api/tapechart', () => {
        it('should return dual-identity fields in tapechart reservations', async () => {
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
            const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();
            const response = await axios_1.default.get(`${BASE_URL}/tapechart?start=${start}&end=${end}`, {
                validateStatus: () => true,
            });
            expect(response.status).toBe(200);
            expect(response.data.status).toBe('OK');
            const data = response.data.data;
            expect(Array.isArray(data.reservations)).toBe(true);
            if (data.reservations.length > 0) {
                const res = data.reservations[0];
                // Dual-identity fields must be present
                expect(res.id).toBeDefined();
                expect(res.reservation_id).toBeDefined();
                expect(res.bid).toBeDefined();
                expect(res.booking_id).toBeDefined();
                expect(res.stay_sequence).toBeDefined();
                // Original fields preserved
                expect(res.guest_name).toBeDefined();
                expect(res.check_in).toBeDefined();
                expect(res.check_out).toBeDefined();
            }
        });
    });
    describe('GET /api/bookings/:bid', () => {
        let knownBid;
        beforeAll(async () => {
            // Fetch any reservation to get a known BID
            const response = await axios_1.default.get(`${BASE_URL}/reservations/1`, {
                validateStatus: () => true,
            });
            if (response.status === 200) {
                knownBid = response.data.data.bid;
            }
        });
        it('should return booking metadata for valid BID', async () => {
            if (!knownBid) {
                console.warn('Skipping: no known BID from reservation');
                return;
            }
            const response = await axios_1.default.get(`${BASE_URL}/bookings/${knownBid}`, {
                validateStatus: () => true,
            });
            expect(response.status).toBe(200);
            expect(response.data.status).toBe('OK');
            const booking = response.data.data;
            // Booking identity fields
            expect(booking.booking_id).toBeDefined();
            expect(booking.bid).toBeDefined();
            expect(booking.bid.toUpperCase()).toBe(knownBid.toUpperCase());
            // Booking metadata
            expect(booking.property_id).toBeDefined();
            expect(booking.guest_name_snapshot).toBeDefined();
            expect(booking.booking_status).toBeDefined();
            expect(booking.currency_code).toBeDefined();
            expect(booking.legacy_booking_number).toBeDefined();
            expect(booking.created_at).toBeDefined();
            expect(booking.updated_at).toBeDefined();
        });
        it('should handle BID normalization (case-insensitive)', async () => {
            if (!knownBid) {
                console.warn('Skipping: no known BID from reservation');
                return;
            }
            // Test with lowercase
            const lowerResponse = await axios_1.default.get(`${BASE_URL}/bookings/${knownBid.toLowerCase()}`, { validateStatus: () => true });
            expect(lowerResponse.status).toBe(200);
            // Test with mixed case
            const mixedResponse = await axios_1.default.get(`${BASE_URL}/bookings/${knownBid.substring(0, 3).toUpperCase()}${knownBid.substring(3).toLowerCase()}`, { validateStatus: () => true });
            expect(mixedResponse.status).toBe(200);
        });
        it('should return 404 for nonexistent BID', async () => {
            const response = await axios_1.default.get(`${BASE_URL}/bookings/INVALIDBID`, {
                validateStatus: () => true,
            });
            expect(response.status).toBe(404);
            expect(response.data.status).toBe('ERROR');
        });
    });
    describe('GET /api/bookings/:bid/reservations', () => {
        let knownBid;
        beforeAll(async () => {
            // Fetch any reservation to get a known BID
            const response = await axios_1.default.get(`${BASE_URL}/reservations/1`, {
                validateStatus: () => true,
            });
            if (response.status === 200) {
                knownBid = response.data.data.bid;
            }
        });
        it('should return all child reservations for a booking', async () => {
            if (!knownBid) {
                console.warn('Skipping: no known BID from reservation');
                return;
            }
            const response = await axios_1.default.get(`${BASE_URL}/bookings/${knownBid}/reservations`, {
                validateStatus: () => true,
            });
            expect(response.status).toBe(200);
            expect(response.data.status).toBe('OK');
            expect(Array.isArray(response.data.data)).toBe(true);
            const reservations = response.data.data;
            // All should have dual-identity fields
            for (const res of reservations) {
                expect(res.id).toBeDefined();
                expect(res.reservation_id).toBeDefined();
                expect(res.bid).toBe(knownBid);
                expect(res.booking_id).toBeDefined();
                expect(res.stay_sequence).toBeDefined();
                expect(res.legacy_booking_number).toBeDefined();
            }
        });
        it('should return reservations ordered by stay_sequence', async () => {
            if (!knownBid) {
                console.warn('Skipping: no known BID from reservation');
                return;
            }
            const response = await axios_1.default.get(`${BASE_URL}/bookings/${knownBid}/reservations`, {
                validateStatus: () => true,
            });
            expect(response.status).toBe(200);
            const reservations = response.data.data;
            // Verify sequence ordering
            for (let i = 1; i < reservations.length; i++) {
                expect(reservations[i].stay_sequence).toBeGreaterThanOrEqual(reservations[i - 1].stay_sequence);
            }
        });
        it('should return 404 for nonexistent BID', async () => {
            const response = await axios_1.default.get(`${BASE_URL}/bookings/INVALIDBID/reservations`, {
                validateStatus: () => true,
            });
            expect(response.status).toBe(404);
            expect(response.data.status).toBe('ERROR');
        });
        it('should have exactly one reservation per backfilled booking (current schema)', async () => {
            if (!knownBid) {
                console.warn('Skipping: no known BID from reservation');
                return;
            }
            const response = await axios_1.default.get(`${BASE_URL}/bookings/${knownBid}/reservations`, {
                validateStatus: () => true,
            });
            expect(response.status).toBe(200);
            const reservations = response.data.data;
            // During Phase 1D.2 backfill, each booking was mapped to exactly one reservation
            expect(reservations.length).toBe(1);
            expect(reservations[0].stay_sequence).toBe(0);
        });
    });
    describe('Dual-identity field consistency', () => {
        it('should not confuse reservation_id (new) with booking_id (new)', async () => {
            const response = await axios_1.default.get(`${BASE_URL}/reservations/1`, {
                validateStatus: () => true,
            });
            expect(response.status).toBe(200);
            const res = response.data.data;
            // reservation_id should be the reservation PK
            expect(res.reservation_id).toBe(res.id);
            // booking_id should be a FK to bookings table (different value)
            expect(res.booking_id).toBeDefined();
            expect(res.booking_id).not.toBe(res.id);
        });
        it('should preserve booking_number (legacy) without removal', async () => {
            const response = await axios_1.default.get(`${BASE_URL}/reservations/1`, {
                validateStatus: () => true,
            });
            expect(response.status).toBe(200);
            const res = response.data.data;
            // Both booking_number (original) and legacy_booking_number (alias) must exist
            expect(res.booking_number).toBeDefined();
            expect(res.legacy_booking_number).toBeDefined();
            expect(res.booking_number).toBe(res.legacy_booking_number);
        });
    });
    describe('Read-only verification', () => {
        it('should not modify database state on read operations', async () => {
            // Fetch current state
            const preResponse = await axios_1.default.get(`${BASE_URL}/reservations/1`, {
                validateStatus: () => true,
            });
            expect(preResponse.status).toBe(200);
            const preData = preResponse.data.data;
            // Make multiple reads
            for (let i = 0; i < 3; i++) {
                await axios_1.default.get(`${BASE_URL}/reservations/1`, {
                    validateStatus: () => true,
                });
            }
            // Verify data unchanged
            const postResponse = await axios_1.default.get(`${BASE_URL}/reservations/1`, {
                validateStatus: () => true,
            });
            expect(postResponse.status).toBe(200);
            const postData = postResponse.data.data;
            expect(postData.id).toBe(preData.id);
            expect(postData.bid).toBe(preData.bid);
            expect(postData.booking_id).toBe(preData.booking_id);
            expect(postData.updated_at).toBe(preData.updated_at);
        });
    });
});
