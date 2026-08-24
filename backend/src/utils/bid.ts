import crypto from 'crypto';

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PROPERTY_CODE_PATTERN = /^[A-Z0-9]{2,6}$/;
const BID_DATE_PATTERN = /^\d{6}$/;

export function assertPropertyCode(propertyCode: string): void {
  if (!PROPERTY_CODE_PATTERN.test(propertyCode)) {
    throw new Error(`Invalid property code: ${propertyCode}`);
  }
}

export function assertBidDateSegment(dateSegment: string): void {
  if (!BID_DATE_PATTERN.test(dateSegment)) {
    throw new Error(`Invalid BID date segment: ${dateSegment}`);
  }
}

export function generateCrockfordSuffix(byteLength = 5, randomBytes = crypto.randomBytes): string {
  const bytes = randomBytes(byteLength);
  if (!Buffer.isBuffer(bytes) || bytes.length !== byteLength) {
    throw new Error(`randomBytes must return a Buffer of length ${byteLength}`);
  }

  let value = BigInt(`0x${bytes.toString('hex')}`);
  let suffix = '';

  for (let i = 0; i < 8; i += 1) {
    const index = Number(value & 31n);
    suffix = CROCKFORD_ALPHABET[index] + suffix;
    value >>= 5n;
  }

  return suffix;
}

export function buildBid(propertyCode: string, dateSegment: string, suffix: string): string {
  assertPropertyCode(propertyCode);
  assertBidDateSegment(dateSegment);

  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(suffix)) {
    throw new Error(`Invalid BID suffix: ${suffix}`);
  }

  return `${propertyCode}-${dateSegment}-${suffix}`;
}

export function generateBid(propertyCode: string, dateSegment: string, randomBytes = crypto.randomBytes): string {
  return buildBid(propertyCode, dateSegment, generateCrockfordSuffix(5, randomBytes));
}
