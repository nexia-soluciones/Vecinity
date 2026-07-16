"use client";

import { useParams } from "next/navigation";
import VerificarTarjeta from "../../_components/VerificarTarjeta";

/** QR de tarjeta de VISITA FRECUENTE (vf/<card_request_id>). */
export default function VerificarVisitaFrecuente() {
  const params = useParams<{ id: string }>();
  if (!params?.id) return null;
  return <VerificarTarjeta clase="vf" id={params.id} />;
}
