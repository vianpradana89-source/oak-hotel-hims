import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export interface AuthUser {
  id: number;
  email: string;
  username: string;
  full_name: string;
  role: string;
  role_id: number;
  property_id: number;
  scope?: 'FULL' | 'ONBOARDING';
  account_status?: string;
  must_change_password?: boolean;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (emailOrUsername: string, password: string) => Promise<{ success: boolean; message?: string }>;
  logout: () => void;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  updateSessionToken: (newToken: string, updatedUserPartial?: Partial<AuthUser>) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_KEY = 'oak_hims_auth_token';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Authenticated fetch helper that injects Authorization header
  const authFetch = useCallback(
    async (url: string, init?: RequestInit): Promise<Response> => {
      const currentToken = token || localStorage.getItem(TOKEN_KEY);
      const headers = new Headers(init?.headers || {});
      if (currentToken) {
        headers.set('Authorization', `Bearer ${currentToken}`);
      }
      return fetch(url, {
        ...init,
        headers,
      });
    },
    [token]
  );

  // Validate session on mount or token change
  useEffect(() => {
    let isMounted = true;

    const validateSession = async () => {
      const storedToken = localStorage.getItem(TOKEN_KEY);
      if (!storedToken) {
        if (isMounted) {
          setUser(null);
          setToken(null);
          setIsLoading(false);
        }
        return;
      }

      try {
        const res = await fetch('/api/auth/me', {
          headers: {
            Authorization: `Bearer ${storedToken}`,
          },
        });

        if (res.ok) {
          const data = await res.json();
          if (isMounted && data.status === 'OK' && data.data?.user) {
            setUser(data.data.user);
            setToken(storedToken);
          } else {
            throw new Error('Invalid session response');
          }
        } else {
          // Token expired or invalid
          localStorage.removeItem(TOKEN_KEY);
          if (isMounted) {
            setUser(null);
            setToken(null);
          }
        }
      } catch (err) {
        console.warn('Session verification note:', err);
        localStorage.removeItem(TOKEN_KEY);
        if (isMounted) {
          setUser(null);
          setToken(null);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    validateSession();

    return () => {
      isMounted = false;
    };
  }, []);

  const login = async (
    emailOrUsername: string,
    password: string
  ): Promise<{ success: boolean; message?: string }> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: emailOrUsername, password }),
      });

      const json = await res.json();

      if (res.ok && json.status === 'OK' && json.data) {
        const { token: receivedToken, user: receivedUser } = json.data;
        localStorage.setItem(TOKEN_KEY, receivedToken);
        setToken(receivedToken);
        setUser(receivedUser);
        return { success: true, message: json.message || 'Login berhasil' };
      } else {
        return {
          success: false,
          message: json.message || 'Gagal masuk. Periksa kembali email dan password Anda.',
        };
      }
    } catch (err: any) {
      return {
        success: false,
        message: err.message || 'Terjadi kesalahan koneksi ke server.',
      };
    }
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  };

  const updateSessionToken = (newToken: string, updatedUserPartial?: Partial<AuthUser>) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
    if (updatedUserPartial) {
      setUser((prev) => (prev ? { ...prev, ...updatedUserPartial } : null));
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: Boolean(token && user),
        isLoading,
        login,
        logout,
        authFetch,
        updateSessionToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
