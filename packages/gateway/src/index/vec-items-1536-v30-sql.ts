export const VEC_ITEMS_1536_V30_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_items_1536
  USING vec0(embedding float[1536]);

DROP TRIGGER IF EXISTS embedding_chunk_ad_delete_vec384;
CREATE TRIGGER embedding_chunk_ad_delete_vec384
AFTER DELETE ON embedding_chunk
FOR EACH ROW
WHEN OLD.dims = 384
BEGIN
  DELETE FROM vec_items_384 WHERE rowid = OLD.vec_rowid;
END;

CREATE TRIGGER IF NOT EXISTS embedding_chunk_ad_delete_vec1536
AFTER DELETE ON embedding_chunk
FOR EACH ROW
WHEN OLD.dims = 1536
BEGIN
  DELETE FROM vec_items_1536 WHERE rowid = OLD.vec_rowid;
END;
`;

export const VEC_ITEMS_1536_V30_NO_VEC_SQL = "";
