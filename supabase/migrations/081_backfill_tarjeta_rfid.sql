-- 081 — Backfill: liga vehicles.tarjeta_rfid desde los tags de la campaña
-- La alta de la campaña SÍ registró tag↔vehículo en rfid_tags (115/120 con
-- vehicle_id) — lo que nunca se copió fue vehicles.tarjeta_rfid. Se liga todo
-- vehículo con EXACTAMENTE UN tag vehicular activo (0 ambiguos medidos).
-- Con esto el modal de entrega pre-llena el número de la tarjeta física
-- (las históricas se entregan tal cual — su número ES el tag de campaña).

UPDATE vecino.vehicles v
   SET tarjeta_rfid = t.codigo_tag
  FROM (
    SELECT vehicle_id, min(codigo_tag) AS codigo_tag
      FROM vecino.rfid_tags
     WHERE tipo = 'vehiculo' AND status IN ('activo','suspendido') AND vehicle_id IS NOT NULL
     GROUP BY vehicle_id
    HAVING count(*) = 1
  ) t
 WHERE t.vehicle_id = v.id
   AND (v.tarjeta_rfid IS NULL OR v.tarjeta_rfid = '');
