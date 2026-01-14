import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the app can run from file:// and from a server.
  base: "./",
  // Windows/OneDrive can intermittently fail when wiping dist/ during watch builds.
  // Keeping the directory avoids EPERM races.
  build: {
    emptyOutDir: false,
  },
});

