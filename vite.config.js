import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Não publica mapas de código-fonte em produção.
    sourcemap: false,
  },
});
