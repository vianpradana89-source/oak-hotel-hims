import crypto from 'crypto';

export function computeRequestHash(method: string, path: string, body: any): string {
  const bodyStr = body ? JSON.stringify(body) : '';
  const h = crypto.createHash('sha256');
  h.update(method.toUpperCase() + '|' + path + '|' + bodyStr);
  return h.digest('hex');
}
