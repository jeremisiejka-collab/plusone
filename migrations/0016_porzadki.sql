-- Porządki: usunięcie nieużywanych tabel i ustawień po wycofanym module.
DROP TABLE IF EXISTS ig_log;
DROP TABLE IF EXISTS ig_posts;
DELETE FROM settings WHERE key IN ('instagram', 'ig_health', 'ig_lock');
