import React, { useState } from 'react';
import { useAuth } from './AuthContext';

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const [emailOrUsername, setEmailOrUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');

    if (!emailOrUsername.trim() || !password) {
      setErrorMessage('Silakan masukkan email/username dan password.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await login(emailOrUsername, password);
      if (!res.success) {
        setErrorMessage(res.message || 'Email atau password salah.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Gagal terhubung ke server.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100vw',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#12261e',
        backgroundImage: 'radial-gradient(circle at 50% 20%, #1e4234 0%, #11231b 75%, #0c1813 100%)',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        padding: '1.5rem',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '440px',
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.1)',
          overflow: 'hidden',
          animation: 'fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Header Branding */}
        <div
          style={{
            backgroundColor: '#1a382b',
            backgroundImage: 'linear-gradient(135deg, #1a382b 0%, #244b3b 100%)',
            padding: '2.5rem 2rem 2rem 2rem',
            textAlign: 'center',
            borderBottom: '2px solid #c5a880',
            position: 'relative',
          }}
        >
          {/* Logo Badge */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '64px',
              height: '64px',
              borderRadius: '16px',
              backgroundColor: '#ffffff',
              boxShadow: '0 8px 16px rgba(0,0,0,0.2)',
              marginBottom: '1rem',
              border: '2px solid #dfb76c',
            }}
          >
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#1a382b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
              <polyline points="9 22 9 12 15 12 15 22"></polyline>
            </svg>
          </div>

          <h1
            style={{
              margin: '0 0 0.25rem 0',
              color: '#ffffff',
              fontSize: '1.5rem',
              fontWeight: 700,
              letterSpacing: '0.05em',
            }}
          >
            OAK TREE HOTEL
          </h1>
          <p
            style={{
              margin: 0,
              color: '#c5a880',
              fontSize: '0.85rem',
              fontWeight: 600,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            Integrated Management System
          </p>
        </div>

        {/* Form Body */}
        <div style={{ padding: '2.25rem 2rem 2.5rem 2rem', backgroundColor: '#faf8f5' }}>
          <div style={{ marginBottom: '1.5rem', textAlign: 'center' }}>
            <h2 style={{ margin: '0 0 0.35rem 0', color: '#1a382b', fontSize: '1.2rem', fontWeight: 600 }}>
              Masuk ke Akun Anda
            </h2>
            <p style={{ margin: 0, color: '#6b7280', fontSize: '0.875rem' }}>
              Silakan masukkan kredensial staf untuk melanjutkan
            </p>
          </div>

          {errorMessage && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.625rem',
                backgroundColor: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#991b1b',
                padding: '0.75rem 1rem',
                borderRadius: '8px',
                fontSize: '0.85rem',
                marginBottom: '1.25rem',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            {/* Email / Username Input */}
            <div style={{ marginBottom: '1.25rem' }}>
              <label
                style={{
                  display: 'block',
                  color: '#374151',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  marginBottom: '0.4rem',
                }}
              >
                Email atau Username
              </label>
              <div style={{ position: 'relative' }}>
                <div
                  style={{
                    position: 'absolute',
                    left: '0.875rem',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: '#9ca3af',
                    display: 'flex',
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                  </svg>
                </div>
                <input
                  type="text"
                  value={emailOrUsername}
                  onChange={(e) => setEmailOrUsername(e.target.value)}
                  placeholder="admin / user@oaklawang.com"
                  required
                  autoFocus
                  style={{
                    width: '100%',
                    padding: '0.75rem 0.875rem 0.75rem 2.5rem',
                    fontSize: '0.925rem',
                    borderRadius: '8px',
                    border: '1px solid #d1d5db',
                    backgroundColor: '#ffffff',
                    color: '#111827',
                    boxSizing: 'border-box',
                    outline: 'none',
                    transition: 'border-color 0.15s, box-shadow 0.15s',
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = '#1a382b';
                    e.currentTarget.style.boxShadow = '0 0 0 3px rgba(26, 56, 43, 0.15)';
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = '#d1d5db';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                />
              </div>
            </div>

            {/* Password Input */}
            <div style={{ marginBottom: '1.75rem' }}>
              <label
                style={{
                  display: 'block',
                  color: '#374151',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  marginBottom: '0.4rem',
                }}
              >
                Password
              </label>
              <div style={{ position: 'relative' }}>
                <div
                  style={{
                    position: 'absolute',
                    left: '0.875rem',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: '#9ca3af',
                    display: 'flex',
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                  </svg>
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                  style={{
                    width: '100%',
                    padding: '0.75rem 2.75rem 0.75rem 2.5rem',
                    fontSize: '0.925rem',
                    borderRadius: '8px',
                    border: '1px solid #d1d5db',
                    backgroundColor: '#ffffff',
                    color: '#111827',
                    boxSizing: 'border-box',
                    outline: 'none',
                    transition: 'border-color 0.15s, box-shadow 0.15s',
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = '#1a382b';
                    e.currentTarget.style.boxShadow = '0 0 0 3px rgba(26, 56, 43, 0.15)';
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = '#d1d5db';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute',
                    right: '0.75rem',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    padding: '0.25rem',
                    cursor: 'pointer',
                    color: '#6b7280',
                    display: 'flex',
                  }}
                  title={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                >
                  {showPassword ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                      <line x1="1" y1="1" x2="23" y2="23"></line>
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                      <circle cx="12" cy="12" r="3"></circle>
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              style={{
                width: '100%',
                padding: '0.85rem 1.25rem',
                fontSize: '0.95rem',
                fontWeight: 600,
                color: '#ffffff',
                backgroundColor: '#1a382b',
                border: 'none',
                borderRadius: '8px',
                cursor: isLoading ? 'not-allowed' : 'pointer',
                opacity: isLoading ? 0.8 : 1,
                boxShadow: '0 4px 6px -1px rgba(26, 56, 43, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                transition: 'background-color 0.15s, transform 0.05s',
              }}
              onMouseEnter={(e) => {
                if (!isLoading) e.currentTarget.style.backgroundColor = '#142d22';
              }}
              onMouseLeave={(e) => {
                if (!isLoading) e.currentTarget.style.backgroundColor = '#1a382b';
              }}
            >
              {isLoading ? (
                <>
                  <svg
                    style={{ animation: 'spin 1s linear infinite', width: '18px', height: '18px' }}
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle cx="12" cy="12" r="10" stroke="#ffffff" strokeWidth="4" opacity="0.25"></circle>
                    <path fill="#ffffff" d="M4 12a8 8 0 018-8v8H4z"></path>
                  </svg>
                  <span>Memverifikasi...</span>
                </>
              ) : (
                <span>Masuk ke Sistem</span>
              )}
            </button>
          </form>

          {/* Footer Note */}
          <div style={{ marginTop: '2rem', textAlign: 'center', borderTop: '1px solid #e5e7eb', paddingTop: '1.25rem' }}>
            <p style={{ margin: 0, color: '#9ca3af', fontSize: '0.78rem' }}>
              &copy; {new Date().getFullYear()} OAK Lawang Hotel Management System.
              <br />
              Sistem Khusus Operasional Staf & Manajemen Terdaftar.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
