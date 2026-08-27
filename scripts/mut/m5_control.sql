-- MUTACIÓN 5 (CONTROL) — un cambio inocuo. Si esto muerde, las aserciones miran
-- el archivo y no la conducta, y todas las demás son falsos positivos.
COMMENT ON COLUMN vecino.incident_reports.origen IS 'control de la corrida de mutaciones';
