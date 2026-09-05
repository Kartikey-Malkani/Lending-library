import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth.js';
import { Layout } from './components/Layout.js';
import { CataloguePage } from './pages/CataloguePage.js';
import { ImportPage } from './pages/ImportPage.js';
import { ItemDetailPage } from './pages/ItemDetailPage.js';
import { LoanDetailPage } from './pages/LoanDetailPage.js';
import { LoansPage } from './pages/LoansPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { MyItemsPage } from './pages/MyItemsPage.js';

/**
 * Routes.
 *
 * `RequireAuth` decides what to show, not what is permitted. Every page behind
 * it calls endpoints the server guards by capability, so a member who types
 * `/my-items` or `/import` into the address bar gets a 403 from the API
 * regardless of what this file says. The dashboard and alerts arrive in a later
 * milestone.
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
        {/* Both roles: the server scopes a member's list to their own loans. */}
        <Route path="/loans" element={<LoansPage />} />
        <Route path="/loans/:id" element={<LoanDetailPage />} />
        <Route
          path="/import"
          element={
            <RequireAuth role="librarian">
              <ImportPage />
            </RequireAuth>
          }
        />
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
