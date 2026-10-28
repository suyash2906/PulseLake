import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Three pages: the PC dashboard (index.html), the phone IoT node (device.html) and the
// Responder app for the people who receive the alerts (responder.html, installable PWA).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        dashboard: resolve(__dirname, "index.html"),
        device: resolve(__dirname, "device.html"),
        responder: resolve(__dirname, "responder.html"),
      },
    },
  },
});
