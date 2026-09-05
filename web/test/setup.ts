import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/*
 * Unmount between tests.
 *
 * Testing Library only registers this automatically when vitest runs with
 * globals enabled, and this suite imports its helpers explicitly instead.
 * Without it the previous test's DOM stays in the document and queries start
 * matching two of everything — which reads as a component bug rather than as
 * leftover state.
 */
afterEach(cleanup);
