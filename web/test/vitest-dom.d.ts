import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

/**
 * jest-dom's matchers, taught to TypeScript.
 *
 * The package ships an augmentation of vitest's `Assertion`, which vitest 3 no
 * longer uses as the extension point; `Matchers` is. Declared here rather than
 * left to a `// @ts-expect-error`, so `toBeInTheDocument` is type-checked like
 * any other assertion.
 */
declare module 'vitest' {
  interface Matchers<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
}
