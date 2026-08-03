# Corte de tarjetas de acceso — Villa Catania
> Fecha de corte: 2026-07-31 · Fuente: BD de Vecinity (schema `vecino`) + export bancario
> Validación completa: saldos de mantenimiento SIN contaminación por tarjetas (ver §4)

---

## 1. Ingresos por tarjetas (recibido de los vecinos)

**101 tarjetas adicionales pagadas × $150 = $15,150**

| Vía de cobro | Monto | Detalle |
|---|---|---|
| Depósitos identificados en banco (ventana julio) | $9,900 | 40 movimientos marcados `tarjeta` (migr. 088) |
| Cobrado del saldo a favor | $300 | Casa 234 (2 tarjetas) |
| Comprobantes validados con depósito fuera de la ventana del export | $4,950 | 33 tarjetas de la campaña (depósitos previos al primer corte subido) |
| **Total** | **$15,150** | |

- Precio efectivo cobrado: **$150 parejo** en todas.
- La 1ª vehicular de cada casa es incluida (`pago no_requerido`) — no genera ingreso.

## 2. Pagado al proveedor (Nexia Soluciones)

**SPEI 21-jul-2026 · $13,804.00** (RFC NSO260331T) = $11,900 + IVA 16%

Composición de la factura:
- 100 impresiones × $50 = $5,000
- 46 tarjetas (después de la #100) × $150 = $6,900

**Cuadre perfecto contra la BD:** al 21-jul había exactamente **146 tarjetas impresas**.

## 3. Cruce y posición

| Concepto | Monto |
|---|---|
| Recibido de vecinos | $15,150 |
| Pagado a Nexia (21-jul) | −$13,804 |
| **Posición al corte** | **+$1,346** |

**Por facturar (posterior al 21-jul):** 44 tarjetas impresas después de la factura
(al 31-jul, incluye las 9 reimpresas por el error de impresora). A $150 + IVA ≈ **$7,656**.
Parte ya está cobrada a vecinos dentro de los $15,150; las entregas nuevas se siguen
cobrando a $150 cada una.

### Focos para decisión del comité
1. **Margen negativo post-100:** cada tarjeta después de la #100 cuesta a la colonia
   **$174 con IVA** y al vecino se le cobran **$150** → −$24 por tarjeta.
   Opciones: subir el precio al vecino (~$175) o absorberlo como costo.
2. **Personalización no cobrada:** 91 de las 101 pagadas son personalizadas; el precio
   configurado es +$50 y nunca se aplicó (habrían sido **$4,550** adicionales).
3. **Blancas:** 11 tarjetas entregadas sin imprimir — aclarar con el proveedor si
   facturan como tarjeta sin impresión.
4. Mermas del proceso: 2 dañadas + 1 reemplazada (ya reflejadas en inventario).

## 4. Validación de saldos (auditoría del 31-jul)

- ✅ Ningún saldo positivo de mantenimiento tiene componente de tarjeta.
  Único cargo de tarjeta al saldo: casa 234 ($300, intencional del saldo a favor; la casa
  sigue con $2,750 a favor).
- ✅ Los 40 depósitos marcados `tarjeta` traen texto del propio vecino que confirma que
  son pago de tarjeta — ningún abono de mantenimiento se perdió en ese bote.
- ✅ Recibos vía Caty: solo uno era de tarjeta (casa 167, $150) y ya estaba revertido y
  reclasificado (validación 23-jul).
- ✅ Todos los saldos reales cuadran contra su libro de transacciones.
  (La única diferencia es D-02 de la villa demo, por un abono `pendiente` sembrado a propósito.)
