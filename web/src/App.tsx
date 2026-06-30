import { Routes, Route } from 'react-router-dom';
import { LoginPage } from './auth/LoginPage';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { DiscoveryPage } from './discovery/DiscoveryPage';
import { ModelProfilePage } from './profile/ModelProfilePage';
import { WalletPage } from './wallet/WalletPage';
import { ModelDashboard } from './model/ModelDashboard';
import { CallScreen } from './calls/CallScreen';
import { RankingPage } from './ranking/RankingPage';

export default function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<ProtectedRoute><DiscoveryPage /></ProtectedRoute>} />
      <Route path="/models/:id" element={<ProtectedRoute><ModelProfilePage /></ProtectedRoute>} />
      <Route path="/wallet" element={<ProtectedRoute><WalletPage /></ProtectedRoute>} />
      <Route path="/painel" element={<ProtectedRoute><ModelDashboard /></ProtectedRoute>} />
      <Route path="/call/:id" element={<ProtectedRoute><CallScreen /></ProtectedRoute>} />
      <Route path="/ranking" element={<ProtectedRoute><RankingPage /></ProtectedRoute>} />
    </Routes>
  );
}
