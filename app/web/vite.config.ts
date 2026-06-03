import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the app can run from file:// and from a server.
  base: "./",
  // Windows/OneDrive can intermittently fail when wiping dist/ during watch builds.
  // Keeping the directory avoids EPERM races.
  build: {
    emptyOutDir: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/katex")) return "vendor-katex";
          if (id.includes("node_modules/qrcode")) return "vendor-qrcode";
          if (id.includes("/src/render/")) return "render-runtime";
          if (id.includes("/src/editor/") || id.includes("/src/core/stateMachine")) return "editor-runtime";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "node",
  },
});

