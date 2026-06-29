export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'REPORTER' | 'ANCHOR';
}

export function saveAuth(token: string, user: AuthUser) {
  localStorage.setItem('fc_token', token);
  localStorage.setItem('fc_user', JSON.stringify(user));
}

export function getToken(): string | null {
  return localStorage.getItem('fc_token');
}

export function getUser(): AuthUser | null {
  const raw = localStorage.getItem('fc_user');
  return raw ? JSON.parse(raw) : null;
}

export function clearAuth() {
  localStorage.removeItem('fc_token');
  localStorage.removeItem('fc_user');
}

export function isLoggedIn(): boolean {
  return !!getToken();
}
