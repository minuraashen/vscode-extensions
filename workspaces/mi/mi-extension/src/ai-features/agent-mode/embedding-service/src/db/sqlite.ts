import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// Schema is inlined to avoid runtime dependency on schema.sql being present
// alongside the compiled JS (tsc watch / dev mode does not copy non-TS assets).
const SCHEMA_SQL = `
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
  parent_chunk_id INTEGER,
  timestamp INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  semantic_intent TEXT NOT NULL,
  context_json TEXT NOT NULL,
  sequence_key TEXT,
  is_sequence_definition INTEGER DEFAULT 0,
  referenced_sequences TEXT
);

CREATE INDEX IF NOT EXISTS idx_file_path ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_file_hash ON chunks(file_hash);
CREATE INDEX IF NOT EXISTS idx_resource_type ON chunks(resource_type);
CREATE INDEX IF NOT EXISTS idx_content_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_semantic_type ON chunks(semantic_type);
CREATE INDEX IF NOT EXISTS idx_sequence_key ON chunks(sequence_key);
CREATE INDEX IF NOT EXISTS idx_is_sequence_definition ON chunks(is_sequence_definition);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_chunk ON chunks(file_path, chunk_index, start_line, end_line);

CREATE TABLE IF NOT EXISTS sequence_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_chunk_id INTEGER NOT NULL,
  callee_chunk_id INTEGER NOT NULL,
  sequence_key TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (caller_chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
  FOREIGN KEY (callee_chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_caller_chunk ON sequence_references(caller_chunk_id);
CREATE INDEX IF NOT EXISTS idx_callee_chunk ON sequence_references(callee_chunk_id);
CREATE INDEX IF NOT EXISTS idx_sequence_key_ref ON sequence_references(sequence_key);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  embedding_text
);
`;

export interface ChunkMetadata {
  filePath: string;
  fileHash: string;
  resourceName: string;
  resourceType: string;
  chunkType: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  parentChunkId: number | null;
  timestamp: number;
  // NEW: Merkle tree and semantic metadata
  contentHash: string;
  semanticType: string;
  semanticIntent: string;
  context: {
    api?: {
      name?: string;
      context?: string;
      xmlns?: string;
    };
    resource?: {
      method?: string;
      uriTemplate?: string;
    };
    sequence?: string | {
      name?: string;
      xmlns?: string;
    };
    localEntry?: {
      key?: string;
      xmlns?: string;
    };
    endpoint?: {
      name?: string;
      xmlns?: string;
    };
    template?: {
      name?: string;
      xmlns?: string;
    };
    // NEW: Support for additional artifact types
    proxyService?: {
      name?: string;
      transports?: string;
      xmlns?: string;
    };
    messageStore?: {
      name?: string;
      type?: string;
      xmlns?: string;
    };
    messageProcessor?: {
      name?: string;
      type?: string;
      messageStore?: string;
      xmlns?: string;
    };
    dataService?: {
      name?: string;
      enableBatchRequests?: boolean;
      xmlns?: string;
    };
    query?: {
      id?: string;
      useConfig?: string;
    };
    operation?: {
      name?: string;
      callsQuery?: string;
    };
    task?: {
      name?: string;
      trigger?: string;
      xmlns?: string;
    };
    references?: string[];
  };
  // NEW: Cross-file sequence tracking
  sequenceKey?: string;
  isSequenceDefinition?: boolean;
  referencedSequences?: string[];
}

export interface ChunkRecord extends ChunkMetadata {
  id: number;
  embedding: Buffer;
}

export class SQLiteDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(SCHEMA_SQL);
  }

  // ── FTS5 helpers (keep in sync with chunks table) ──────────────────

  private insertFts(chunkId: number, embeddingText: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO chunks_fts (chunk_id, embedding_text) VALUES (?, ?)`
    );
    stmt.run(chunkId, embeddingText);
  }

  private updateFts(chunkId: number, embeddingText: string): void {
    // FTS5 does not support UPDATE — delete then re-insert
    this.deleteFts(chunkId);
    this.insertFts(chunkId, embeddingText);
  }

  private deleteFts(chunkId: number): void {
    const stmt = this.db.prepare(
      `DELETE FROM chunks_fts WHERE chunk_id = ?`
    );
    stmt.run(chunkId);
  }

  // ── Chunk CRUD ────────────────────────────────────────────────────

  insertChunk(metadata: ChunkMetadata, embedding: Float32Array, embeddingText?: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO chunks (
        file_path, file_hash, resource_name, resource_type, chunk_type,
        chunk_index, start_line, end_line, parent_chunk_id, embedding, timestamp,
        content_hash, semantic_type, semantic_intent, context_json,
        sequence_key, is_sequence_definition, referenced_sequences
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      metadata.filePath,
      metadata.fileHash,
      metadata.resourceName,
      metadata.resourceType,
      metadata.chunkType,
      metadata.chunkIndex,
      metadata.startLine,
      metadata.endLine,
      metadata.parentChunkId,
      Buffer.from(embedding.buffer),
      metadata.timestamp,
      metadata.contentHash,
      metadata.semanticType,
      metadata.semanticIntent,
      JSON.stringify(metadata.context),
      metadata.sequenceKey || null,
      metadata.isSequenceDefinition ? 1 : 0,
      metadata.referencedSequences ? JSON.stringify(metadata.referencedSequences) : null
    );

    const id = result.lastInsertRowid as number;

    // Sync FTS5 index
    if (embeddingText) {
      this.insertFts(id, embeddingText);
    }

    return id;
  }

  updateChunk(id: number, metadata: ChunkMetadata, embedding: Float32Array, embeddingText?: string): void {
    const stmt = this.db.prepare(`
      UPDATE chunks SET
        file_hash = ?, resource_name = ?, resource_type = ?, chunk_type = ?,
        chunk_index = ?, start_line = ?, end_line = ?, parent_chunk_id = ?,
        embedding = ?, timestamp = ?,
        content_hash = ?, semantic_type = ?, semantic_intent = ?, context_json = ?,
        sequence_key = ?, is_sequence_definition = ?, referenced_sequences = ?
      WHERE id = ?
    `);

    stmt.run(
      metadata.fileHash,
      metadata.resourceName,
      metadata.resourceType,
      metadata.chunkType,
      metadata.chunkIndex,
      metadata.startLine,
      metadata.endLine,
      metadata.parentChunkId,
      Buffer.from(embedding.buffer),
      metadata.timestamp,
      metadata.contentHash,
      metadata.semanticType,
      metadata.semanticIntent,
      JSON.stringify(metadata.context),
      metadata.sequenceKey || null,
      metadata.isSequenceDefinition ? 1 : 0,
      metadata.referencedSequences ? JSON.stringify(metadata.referencedSequences) : null,
      id
    );

    // Sync FTS5 index
    if (embeddingText) {
      this.updateFts(id, embeddingText);
    }
  }

  getChunksByFile(filePath: string): ChunkRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM chunks WHERE file_path = ?
    `);
    const rows = stmt.all(filePath) as any[];
    return rows.map(this.mapRowToRecord);
  }

  /**
   * Find artifact definition by key (sequence, local-entry, endpoint, template)
   * Handles references like:
   * - sequence:CreateBookingSequence
   * - localEntry:CurrencyConverter
   * - endpoint:BankEndpoint
   * - template:LogTemplate
   */
  getSequenceDefinition(artifactRef: string): ChunkRecord | null {
    // Parse reference format: "type:name" or just "name" (assume sequence)
    let artifactType = 'sequence';
    let artifactName = artifactRef;

    if (artifactRef.includes(':')) {
      [artifactType, artifactName] = artifactRef.split(':', 2);
    }

    const stmt = this.db.prepare(`
      SELECT * FROM chunks 
      WHERE sequence_key = ? AND is_sequence_definition = 1 
      LIMIT 1
    `);
    const row = stmt.get(artifactName) as any;
    return row ? this.mapRowToRecord(row) : null;
  }

  /**
   * Link caller chunk to callee sequence definition
   */
  linkSequenceReference(callerChunkId: number, calleeChunkId: number, sequenceKey: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO sequence_references (caller_chunk_id, callee_chunk_id, sequence_key, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(callerChunkId, calleeChunkId, sequenceKey, Date.now());
  }

  deleteChunksByFile(filePath: string): void {
    // Delete FTS5 entries for all chunks in this file first
    const idsStmt = this.db.prepare(`SELECT id FROM chunks WHERE file_path = ?`);
    const rows = idsStmt.all(filePath) as { id: number }[];
    for (const row of rows) {
      this.deleteFts(row.id);
    }

    const stmt = this.db.prepare(`DELETE FROM chunks WHERE file_path = ?`);
    stmt.run(filePath);
  }

  deleteChunk(id: number): void {
    this.deleteFts(id);
    const stmt = this.db.prepare(`DELETE FROM chunks WHERE id = ?`);
    stmt.run(id);
  }

  getAllChunks(): ChunkRecord[] {
    const stmt = this.db.prepare(`SELECT * FROM chunks`);
    const rows = stmt.all() as any[];
    return rows.map(this.mapRowToRecord);
  }

  private mapRowToRecord(row: any): ChunkRecord {
    return {
      id: row.id,
      filePath: row.file_path,
      fileHash: row.file_hash,
      resourceName: row.resource_name,
      resourceType: row.resource_type,
      chunkType: row.chunk_type,
      chunkIndex: row.chunk_index,
      startLine: row.start_line,
      endLine: row.end_line,
      parentChunkId: row.parent_chunk_id,
      timestamp: row.timestamp,
      embedding: row.embedding,
      contentHash: row.content_hash,
      semanticType: row.semantic_type,
      semanticIntent: row.semantic_intent,
      context: JSON.parse(row.context_json),
      sequenceKey: row.sequence_key,
      isSequenceDefinition: row.is_sequence_definition === 1,
      referencedSequences: row.referenced_sequences ? JSON.parse(row.referenced_sequences) : undefined,
    };
  }

  /**
   * Returns the latest file hash for each file path stored in the DB.
   * Used to seed the Watcher on startup so unchanged files are not re-processed.
   */
  getLatestFileHashes(): Map<string, string> {
    const stmt = this.db.prepare(`SELECT DISTINCT file_path, file_hash FROM chunks`);
    const rows = stmt.all() as Array<{ file_path: string; file_hash: string }>;
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.file_path, row.file_hash);
    }
    return map;
  }

  /**
   * Returns the total number of chunks in the database.
   * Lightweight alternative to getAllChunks().length — uses COUNT(*) without
   * loading all rows into memory.
   */
  getChunkCount(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) AS cnt FROM chunks`);
    const row = stmt.get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Expose the underlying better-sqlite3 handle for advanced queries (e.g. FTS5 BM25).
   */
  getHandle(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
