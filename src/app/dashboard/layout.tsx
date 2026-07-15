import { SosFab } from "./sos";
import AvisoPrivacidad from "@/app/_components/AvisoPrivacidad";

// Layout del dashboard: monta el botón de pánico flotante en TODAS las páginas
// (una emergencia no debe requerir navegar de regreso al home) y el modal del
// Aviso de Privacidad (aparece solo si la colonia tiene un aviso sin aceptar).
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <SosFab />
      <AvisoPrivacidad />
    </>
  );
}
