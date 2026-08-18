"use client";

import { useCallback, useEffect, useState } from "react";
import { callRpc } from "@/lib/rpc";

// Semáforo de pagos recurrentes del comité (migr. 094).
//
// La señal es el CARGO EN EL BANCO, no el recibo: de 156 gastos registrados
// ninguno tiene recibo adjunto, pero el estado de cuenta se sube cada 3-4 días.
// Por eso 'sin_dato' existe y se muestra distinto de 'vencido': si el estado de
// cuenta todavía no cubre la fecha de vencimiento, NO se puede afirmar que no
// se pagó.

export type EstadoPago = {
  bill_id: string;
  nombre: string;
  categoria: string;
  periodicidad: string;
  cargos_por_periodo: number;
  cargos_ultimo_ciclo: number;
  ultimo_pago: string | null;
  origen: "banco" | "manual" | null;
  monto_ultimo: number | null;
  monto_min: number | null;
  monto_max: number | null;
  proximo_esperado: string | null;
  dias_atraso: number | null;
  estado: "al_dia" | "por_vencer" | "vencido" | "incompleto" | "sin_dato";
  alerta_monto: "pago_doble" | "fuera_de_rango" | null;
  cobertura_hasta: string | null;
  dias_sin_estado_cuenta: number | null;
};

const ORDEN: Record<EstadoPago["estado"], number> = {
  vencido: 0,
  incompleto: 1,
  por_vencer: 2,
  sin_dato: 3,
  al_dia: 4,
};

const ESTILO: Record<EstadoPago["estado"], { punto: string; caja: string; etiqueta: string }> = {
  vencido:    { punto: "bg-red-500",     caja: "bg-red-50 ring-red-200",         etiqueta: "Sin pagar" },
  incompleto: { punto: "bg-amber-500",   caja: "bg-amber-50 ring-amber-200",     etiqueta: "Falta un recibo" },
  por_vencer: { punto: "bg-orange-400",  caja: "bg-orange-50 ring-orange-200",   etiqueta: "Por vencer" },
  sin_dato:   { punto: "bg-slate-300",   caja: "bg-slate-50 ring-slate-200",     etiqueta: "No se sabe" },
  al_dia:     { punto: "bg-emerald-500", caja: "bg-white ring-slate-100",        etiqueta: "Al día" },
};

const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fecha = (d: string) =>
  new Date(d + "T00:00:00").toLocaleDateString("es-MX", { day: "numeric", month: "short" });

const DIAS_PERIODO: Record<string, number> = { semanal: 7, quincenal: 15, mensual: 30, bimestral: 60 };

/** Frase que explica el renglón sin que el comité tenga que interpretar fechas. */
function explicar(p: EstadoPago): string {
  const ciclo = DIAS_PERIODO[p.periodicidad] ?? 30;
  switch (p.estado) {
    case "vencido":
      return p.ultimo_pago
        ? `Sin cargo desde hace ${(p.dias_atraso ?? 0) + ciclo} días (último: ${fecha(p.ultimo_pago)})`
        : "Nunca ha aparecido un cargo de este proveedor";
    case "incompleto":
      return `Apareció ${p.cargos_ultimo_ciclo} de ${p.cargos_por_periodo} recibos del periodo`;
    case "por_vencer":
      return p.proximo_esperado ? `Se espera alrededor del ${fecha(p.proximo_esperado)}` : "Se espera pronto";
    case "sin_dato":
      return p.cobertura_hasta
        ? `El estado de cuenta llega al ${fecha(p.cobertura_hasta)} — todavía no alcanza a decirlo`
        : "No hay estado de cuenta cargado";
    default:
      return p.ultimo_pago
        ? `Pagado el ${fecha(p.ultimo_pago)}${p.origen === "manual" ? " (registrado a mano)" : ""}`
        : "Al día";
  }
}

export default function PagosRecurrentes() {
  const [filas, setFilas] = useState<EstadoPago[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [form, setForm] = useState<{ fecha: string; motivo: string; busy?: boolean; msg?: string }>({
    fecha: "",
    motivo: "",
  });

  // Sin setState síncrono: la primera llamada viene de un efecto y el estado
  // ya arranca en "cargando" (regla react-hooks/set-state-in-effect).
  const cargar = useCallback(async () => {
    const res = await callRpc<EstadoPago[]>("pagos_recurrentes_estado");
    setCargando(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    setFilas((res.data ?? []).slice().sort((a, b) => ORDEN[a.estado] - ORDEN[b.estado]));
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function marcarPagado(bill: string) {
    if (!form.fecha) return setForm((f) => ({ ...f, msg: "Pon la fecha en que se pagó." }));
    if (!form.motivo.trim()) return setForm((f) => ({ ...f, msg: "Escribe por qué (efectivo, otra cuenta…)." }));
    setForm((f) => ({ ...f, busy: true, msg: undefined }));
    const res = await callRpc("recurring_bill_marcar_pagado", {
      p_bill: bill,
      p_fecha: form.fecha,
      p_motivo: form.motivo.trim(),
    });
    setForm((f) => ({ ...f, busy: false }));
    if (!res.ok) return setForm((f) => ({ ...f, msg: res.error }));
    setAbierto(null);
    setForm({ fecha: "", motivo: "" });
    await cargar();
  }

  if (cargando) return null;
  if (error)
    return (
      <p className="mt-4 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 ring-1 ring-amber-200">
        No pude leer los pagos recurrentes: {error}
      </p>
    );
  if (filas.length === 0) return null;

  const enAlerta = filas.filter((f) => f.estado !== "al_dia").length;
  const stale = filas[0]?.dias_sin_estado_cuenta ?? null;

  return (
    <section className="mt-4">
      <h2 className="text-sm font-bold text-slate-700 mb-2">
        💳 Pagos recurrentes{" "}
        {enAlerta > 0 && <span className="text-red-600 font-medium">({enAlerta} por revisar)</span>}
      </h2>

      {stale !== null && stale > 5 && (
        <p className="mb-2 text-xs text-slate-600 bg-slate-100 rounded-lg px-3 py-2">
          ⚠️ El estado de cuenta lleva {stale} días sin subirse. Puede que algo ya esté pagado y aquí
          no se vea.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {filas.map((p) => {
          const s = ESTILO[p.estado];
          return (
            <li key={p.bill_id} className={`rounded-2xl ring-1 p-3.5 ${s.caja}`}>
              <div className="flex items-start gap-2.5">
                <span className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${s.punto}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="font-semibold text-slate-800 text-sm">{p.nombre}</p>
                    <span className="text-[11px] font-semibold text-slate-500 shrink-0">{s.etiqueta}</span>
                  </div>
                  <p className="text-xs text-slate-600 mt-0.5">{explicar(p)}</p>

                  {p.alerta_monto === "pago_doble" && (
                    <p className="text-xs text-amber-700 mt-1">
                      El último cargo fue {p.monto_ultimo ? money(p.monto_ultimo) : "doble"} — cubrió dos
                      periodos, venía atrasado.
                    </p>
                  )}

                  {p.estado !== "al_dia" && p.estado !== "sin_dato" && (
                    <>
                      <button
                        onClick={() => {
                          setAbierto(abierto === p.bill_id ? null : p.bill_id);
                          setForm({ fecha: "", motivo: "" });
                        }}
                        className="press mt-2 rounded-xl bg-white ring-1 ring-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:ring-brand-300"
                      >
                        {abierto === p.bill_id ? "Cancelar" : "Ya se pagó (fuera del banco)"}
                      </button>

                      {abierto === p.bill_id && (
                        <div className="mt-2 flex flex-col gap-2">
                          <input
                            type="date"
                            value={form.fecha}
                            onChange={(e) => setForm((f) => ({ ...f, fecha: e.target.value }))}
                            className="rounded-xl ring-1 ring-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                          />
                          <input
                            value={form.motivo}
                            onChange={(e) => setForm((f) => ({ ...f, motivo: e.target.value }))}
                            placeholder="¿Por qué no aparece en el banco? (efectivo, otra cuenta…)"
                            className="rounded-xl ring-1 ring-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-brand-300"
                          />
                          {form.msg && (
                            <p className="text-xs text-red-600 bg-red-50 rounded-lg px-2 py-1.5 ring-1 ring-red-200">
                              {form.msg}
                            </p>
                          )}
                          <button
                            disabled={form.busy}
                            onClick={() => marcarPagado(p.bill_id)}
                            className="press rounded-xl bg-brand-500 text-white text-sm font-bold py-2 disabled:opacity-40"
                          >
                            {form.busy ? "Guardando…" : "Registrar el pago"}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-[11px] text-slate-400">
        Se detecta por el cargo en el banco, no por el recibo. Que no aparezca no prueba que no se
        pagó: confírmalo antes de reclamar al proveedor.
      </p>
    </section>
  );
}
