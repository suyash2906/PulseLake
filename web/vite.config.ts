import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Two pages: the PC dashboard (index.html) and the phone device app (device.html).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        dashboard: resolve(__dirname, "index.html"),
        device: resolve(__dirname, "device.html"),
      },
    },
  },
});
