-- Прогрев кэша после перезапуска базы (docker-compose.yml: shared_preload_libraries=pg_prewarm, autoprewarm)
CREATE EXTENSION IF NOT EXISTS pg_prewarm;
