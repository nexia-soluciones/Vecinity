import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Necesario para el Docker multi-stage (runner mínimo) en EasyPanel.
  output: "standalone",
  // Oculta el indicador de dev (botón flotante) — capturas limpias del manual.
  devIndicators: false,
};

export default nextConfig;
