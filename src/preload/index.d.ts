export {}

declare global {
  interface Window {
    // typed access lives in src/renderer/src/api.ts
    api: unknown
  }
}
