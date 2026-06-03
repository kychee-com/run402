/** A `villains` row as read back from the DB. `portrait` is the AssetRef JSONB. */
export interface VillainRow {
  id: string;
  user_id?: string;
  real_name?: string;
  fact?: string;
  appearance?: string;
  villain_name: string;
  origin_story?: string;
  catchphrase?: string;
  weakness?: string;
  power?: string;
  threat_level: string;
  portrait: Record<string, unknown> | null;
  elo: number;
  created_at?: string;
}
