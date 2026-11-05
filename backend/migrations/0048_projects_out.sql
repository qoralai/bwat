DROP SCHEMA IF EXISTS projects CASCADE;

DELETE FROM bwat.settings WHERE key IN ('plugin_insights', 'plugin_projects');

DELETE FROM public.schema_migrations WHERE name LIKE 'plugins/projects/%';
