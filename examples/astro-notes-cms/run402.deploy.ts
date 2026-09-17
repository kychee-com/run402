import { buildAstroReleaseSlice } from '@run402/astro/release-slice';
const slice = await buildAstroReleaseSlice('dist');
export default {
  ...slice,
  database: {
    migrations: [{ id: '001_notes_cms', sql: `
      CREATE TABLE private_notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL, title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200));
      CREATE TABLE articles (slug text PRIMARY KEY, title text NOT NULL, body text NOT NULL, hero_asset jsonb);
      INSERT INTO articles (slug,title,body) VALUES ('welcome','Welcome','This public article is edited through the CLI.');
    ` }],
    expose: { version: '1', tables: [
      { name: 'private_notes', expose: true, policy: 'user_owns_rows', owner_column: 'user_id', force_owner_on_insert: true },
      { name: 'articles', expose: true, policy: 'custom', custom_sql: 'CREATE POLICY article_read ON articles FOR SELECT TO anon, authenticated USING (true);' }
    ] }
  }
};
