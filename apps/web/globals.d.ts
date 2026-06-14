// Ambient declarations for global (non-module) CSS side-effect imports.
// Next.js does not ship a `*.css` (non-module) declaration, and under
// TypeScript's "Bundler" module resolution side-effect imports of `.css`
// files are type-checked. This provides the missing module type without
// weakening type-checking.
declare module '*.css';
