import { Routes, Route } from 'react-router-dom';
import { LoginPage } from './auth/LoginPage';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { DiscoveryPage } from './discovery/DiscoveryPage';
import { ModelProfilePage } from './profile/ModelProfilePage';

export default function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<ProtectedRoute><DiscoveryPage /></ProtectedRoute>} />
      <Route path="/models/:id" element={<ProtectedRoute><ModelProfilePage /></ProtectedRoute>} />
    </Routes>
  );
}
