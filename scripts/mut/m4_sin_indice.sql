-- MUTACIÓN 4 — se quita el índice único: el invariante vuelve a depender de que
-- todo el que escriba se acuerde.
DROP INDEX IF EXISTS vecino.profiles_telegram_chat_uniq;
