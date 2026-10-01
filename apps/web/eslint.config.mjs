import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default defineConfig([
  ...nextVitals,
  {
    rules: {
      // React Compiler rules, new in eslint-plugin-react-hooks 7. The app does
      // not use the compiler, and both flag patterns that are correct without
      // it: loading data from an effect, a ref holding the latest callback.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      // The full page loads are deliberate: after a sign-out or a lapsed
      // session nothing the page held in memory may survive.
      '@next/next/no-location-assign-relative-destination': 'off',
    },
  },
  globalIgnores(['.next/**', 'next-env.d.ts']),
]);
