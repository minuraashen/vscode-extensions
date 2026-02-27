-- Code chunks with embeddings and Merkle tree support
-- PHASE 4: Added content_hash, semantic_type, semantic_intent, context_json
-- PHASE 8: Added sequence_key, is_sequence_definition, referenced_sequences for cross-file tracking
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  chunk_type TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  parent_chunk_id INTEGER,            -- Reference to parent chunk
  timestamp INTEGER NOT NULL,
  -- Merkle tree and semantic metadata
  content_hash TEXT NOT NULL,         -- SHA-256 hash of content + metadata (for change detection)
  semantic_type TEXT NOT NULL,        -- filter | payloadFactory | sequence | resource | api
  semantic_intent TEXT NOT NULL,      -- validation | transformation | delegation | response
  context_json TEXT NOT NULL,         -- JSON: {api, method, uri, resource, sequence}
  -- Cross-file sequence tracking
  sequence_key TEXT,                  -- "CreateBookingSequence" (if this IS a sequence definition)
  is_sequence_definition INTEGER DEFAULT 0,  -- 1 if standalone sequence file
  referenced_sequences TEXT           -- JSON array: ["CreateBookingSequence", "ErrorHandler"]
);

CREATE INDEX IF NOT EXISTS idx_file_path ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_file_hash ON chunks(file_hash);
CREATE INDEX IF NOT EXISTS idx_resource_type ON chunks(resource_type);
CREATE INDEX IF NOT EXISTS idx_content_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_semantic_type ON chunks(semantic_type);
CREATE INDEX IF NOT EXISTS idx_sequence_key ON chunks(sequence_key);
CREATE INDEX IF NOT EXISTS idx_is_sequence_definition ON chunks(is_sequence_definition);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_chunk ON chunks(file_path, chunk_index, start_line, end_line);

-- Sequence reference relationships (caller → callee)
CREATE TABLE IF NOT EXISTS sequence_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_chunk_id INTEGER NOT NULL,      -- Chunk that calls sequence (API chunk)
  callee_chunk_id INTEGER NOT NULL,      -- Sequence definition chunk
  sequence_key TEXT NOT NULL,            -- "CreateBookingSequence"
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (caller_chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
  FOREIGN KEY (callee_chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_caller_chunk ON sequence_references(caller_chunk_id);
CREATE INDEX IF NOT EXISTS idx_callee_chunk ON sequence_references(callee_chunk_id);
CREATE INDEX IF NOT EXISTS idx_sequence_key_ref ON sequence_references(sequence_key);

-- BM25 full-text search index (FTS5)
-- Mirrors embedding_text from the chunking pipeline for sparse term-based search
-- chunk_id is UNINDEXED (used only for joining back to chunks table)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  embedding_text
);
