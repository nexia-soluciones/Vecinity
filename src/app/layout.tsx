import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { InstallAppButton } from "./_components/InstallAppButton";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Vecinity — Comunidad Segura",
  description:
    "Tu colonia, más segura y organizada. Administración del fraccionamiento y vigilancia vecinal en una sola app.",
  applicationName: "Vecinity",
  // Experiencia standalone en iPhone al agregar a inicio.
  appleWebApp: {
    capable: true,
    title: "Vecinity",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#10b981",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        <InstallAppButton />
      </body>
    </html>
  );
}
