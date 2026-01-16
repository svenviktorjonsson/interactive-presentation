import { defineConfig } from "vite";

export default defineConfig({
  // OneDrive/Windows can intermittently lock files in `dist/`, causing Vite's
  // "empty outDir" step to fail with EPERM. We keep old hashed assets around instead.
  // This avoids the broken "Frontend not built" dev loop.
  build: {
    emptyOutDir: false
  },
  server: {
    port: 5173,
    strictPort: true
  }
});


