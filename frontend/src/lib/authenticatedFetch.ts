const TOKEN_KEY = 'oak_hims_auth_token';

export async function authenticatedFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = new Headers(init?.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(url, { ...init, headers });
}
