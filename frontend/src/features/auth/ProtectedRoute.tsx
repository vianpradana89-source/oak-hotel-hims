import React from 'react';
import { useAuth } from './AuthContext';
import { LoginPage } from './LoginPage';
import { OnboardingWorkspace } from './OnboardingWorkspace';
import { EmployeeMobileWorkspace } from '../employee/EmployeeMobileWorkspace';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          width: '100vw',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#12261e',
          color: '#ffffff',
          fontFamily: 'Inter, system-ui, sans-serif',
          gap: '1rem',
        }}
      >
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            border: '3px solid rgba(197, 168, 128, 0.2)',
            borderTopColor: '#c5a880',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <p style={{ margin: 0, color: '#c5a880', fontSize: '0.9rem', fontWeight: 500, letterSpacing: '0.05em' }}>
          Memuat OAK HIMS...
        </p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  // Strict ONBOARDING boundary: onboarding users MUST NOT enter PMS
  if (user?.scope === 'ONBOARDING') {
    return <OnboardingWorkspace />;
  }

  // Strict MOBILE_ONLY boundary: mobile-only accounts MUST NOT enter desktop PMS workspace
  if (user?.access_type === 'MOBILE_ONLY' && user?.role !== 'Super Admin') {
    return (
      <EmployeeMobileWorkspace
        propertyId={user.property_id || 1}
        currentUser={{
          id: user.id,
          name: user.full_name || user.username,
          role: user.role
        }}
      />
    );
  }

  return <>{children}</>;
};
