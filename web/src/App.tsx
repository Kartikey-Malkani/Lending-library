import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth.js';
import { Layout } from './components/Layout.js';
import { CataloguePage } from './pages/CataloguePage.js';
import { ItemDetailPage } from './pages/ItemDetailPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { MyItemsPage } from './pages/MyItemsPage.js';

/**
 * Routes.
 *
 * `RequireAuth` decides what to show, not what is permitted. Every page behind
 * it calls endpoints the server guards by capability, so a member who types
 * `/my-items` into the address bar gets a 403 from the API regardless of what
 * this file says. Loans, the dashboard, alerts and bulk operations arrive in
 * later milestones.
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/catalogue" replace />} />
        <Route path="/catalogue" element={<CataloguePage />} />
        <Route path="/catalogue/:id" element={<ItemDetailPage />} />
        <Route
          path="/my-items"
          element={
            <RequireAuth role="librarian">
              <MyItemsPage />
            </RequireAuth>
          }
        />
      </Route>

      <Route
        path="*"
        element={
          <div className="state">
            <h1>Page not found</h1>
            <p>
              <a href="/catalogue">Go to the catalogue</a>
            </p>
          </div>
        }
      />
    </Routes>
  );
}
