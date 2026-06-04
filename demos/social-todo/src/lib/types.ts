/** A `todos` row as read back from the DB. */
export interface TodoRow {
  id: string;
  user_id: string;
  text: string;
  done: boolean;
  created_at: string;
}
