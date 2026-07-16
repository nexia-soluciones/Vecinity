"use client";

import { useParams } from "next/navigation";
import VerificarTarjeta from "../../_components/VerificarTarjeta";

/** QR de credencial peatonal de RESIDENTE (r/<profile_id>). */
export default function VerificarResidente() {
  const params = useParams<{ id: string }>();
  if (!params?.id) return null;
  return <VerificarTarjeta clase="r" id={params.id} />;
}
