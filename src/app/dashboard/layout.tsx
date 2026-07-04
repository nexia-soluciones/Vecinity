import { SosFab } from "./sos";

// Layout del dashboard: monta el botón de pánico flotante en TODAS las páginas
// (una emergencia no debe requerir navegar de regreso al home).
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <SosFab />
    </>
  );
}
