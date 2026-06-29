import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isLoggedIn, getUser } from './lib/auth';
import Login from './pages/Login';
import Register from './pages/Register';
import Conferences from './pages/Conferences';
import ReporterConference from './pages/ReporterConference';
import AnchorConference from './pages/AnchorConference';
import AdminCreate from './pages/AdminCreate';
import AdminConferenceDetail from './pages/AdminConferenceDetail';
import AdminUsers from './pages/AdminUsers';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  return isLoggedIn() ? <>{children}</> : <Navigate to="/login" replace />;
}

function RoleGuard({ role, children }: { role: string; children: React.ReactNode }) {
  const user = getUser();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role && user.role !== 'ADMIN') {
    return <Navigate to="/conferences" replace />;
  }
  return <>{children}</>;
}

function AdminGuard({ children }: { children: React.ReactNode }) {
  const user = getUser();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'ADMIN') return <Navigate to="/conferences" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />

          <Route path="/conferences" element={
            <RequireAuth><Conferences /></RequireAuth>
          } />

          <Route path="/reporter/:id" element={
            <RequireAuth>
              <RoleGuard role="REPORTER">
                <ReporterConference />
              </RoleGuard>
            </RequireAuth>
          } />

          <Route path="/anchor/:id" element={
            <RequireAuth>
              <RoleGuard role="ANCHOR">
                <AnchorConference />
              </RoleGuard>
            </RequireAuth>
          } />

          {/* Admin routes */}
          <Route path="/admin/create" element={
            <RequireAuth>
              <AdminGuard>
                <AdminCreate />
              </AdminGuard>
            </RequireAuth>
          } />

          <Route path="/admin/conference/:id" element={
            <RequireAuth>
              <AdminGuard>
                <AdminConferenceDetail />
              </AdminGuard>
            </RequireAuth>
          } />

          <Route path="/admin/users" element={
            <RequireAuth>
              <AdminGuard>
                <AdminUsers />
              </AdminGuard>
            </RequireAuth>
          } />

          {/* Default redirect */}
          <Route path="/" element={
            isLoggedIn()
              ? <Navigate to="/conferences" replace />
              : <Navigate to="/login" replace />
          } />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
