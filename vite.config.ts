import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and must not be cleared from the terminal.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: "localhost" },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2022", outDir: "dist" },
});
