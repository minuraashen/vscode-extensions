import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// Schema is inlined so the compiled JS bundle is self-contained
// (tsc watch / dev mode does not copy non-TS assets).
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  chunk_type TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  timestamp INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  context_json TEXT NOT NULL,
  sequence_key TEXT,
  is_sequence_definition INTEGER DEFAULT 0,
  referenced_sequences TEXT
);

CREATE INDEX IF NOT EXISTS idx_file_path ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_file_hash ON chunks(file_hash);
CREATE INDEX IF NOT EXISTS idx_content_hash ON chunks(content_hash);
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
  chunkType: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  timestamp: number;
  contentHash: string;
  context: Record<string, any>;
  // Cross-file artifact tracking
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

  // ── Cached prepared statements (lazy-initialized) ──────────────────
  private _stmtInsertChunk: Database.Statement | null = null;
  private _stmtUpdateChunk: Database.Statement | null = null;
  private _stmtGetChunksByFile: Database.Statement | null = null;
  private _stmtGetSeqDef: Database.Statement | null = null;
  private _stmtLinkSeqRef: Database.Statement | null = null;
  private _stmtDeleteChunksByFile: Database.Statement | null = null;
  private _stmtDeleteChunk: Database.Statement | null = null;
  private _stmtGetAllChunks: Database.Statement | null = null;
  private _stmtGetFileHashes: Database.Statement | null = null;
  private _stmtGetChunkCount: Database.Statement | null = null;
  private _stmtInsertFts: Database.Statement | null = null;
  private _stmtDeleteFts: Database.Statement | null = null;
  private _stmtGetIdsByFile: Database.Statement | null = null;
  private _stmtGetAllEmbeddings: Database.Statement | null = null;

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
    if (!this._stmtInsertFts) {
      this._stmtInsertFts = this.db.prepare(
        `INSERT INTO chunks_fts (chunk_id, embedding_text) VALUES (?, ?)`
      );
    }
    this._stmtInsertFts.run(chunkId, embeddingText);
  }

  private updateFts(chunkId: number, embeddingText: string): void {
    // FTS5 does not support UPDATE — delete then re-insert
    this.deleteFts(chunkId);
    this.insertFts(chunkId, embeddingText);
  }

  private deleteFts(chunkId: number): void {
    if (!this._stmtDeleteFts) {
      this._stmtDeleteFts = this.db.prepare(
        `DELETE FROM chunks_fts WHERE chunk_id = ?`
      );
    }
    this._stmtDeleteFts.run(chunkId);
  }

  // ── Chunk CRUD ────────────────────────────────────────────────────

  insertChunk(metadata: ChunkMetadata, embedding: Float32Array, embeddingText?: string): number {
    if (!this._stmtInsertChunk) {
      this._stmtInsertChunk = this.db.prepare(`
        INSERT INTO chunks (
          file_path, file_hash, chunk_type,
          chunk_index, start_line, end_line, embedding, timestamp,
          content_hash, context_json,
          sequence_key, is_sequence_definition, referenced_sequences
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    }

    const result = this._stmtInsertChunk.run(
      metadata.filePath,
      metadata.fileHash,
      metadata.chunkType,
      metadata.chunkIndex,
      metadata.startLine,
      metadata.endLine,
      Buffer.from(embedding.buffer),
      metadata.timestamp,
      metadata.contentHash,
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
    if (!this._stmtUpdateChunk) {
      this._stmtUpdateChunk = this.db.prepare(`
        UPDATE chunks SET
          file_hash = ?, chunk_type = ?,
          chunk_index = ?, start_line = ?, end_line = ?,
          embedding = ?, timestamp = ?,
          content_hash = ?, context_json = ?,
          sequence_key = ?, is_sequence_definition = ?, referenced_sequences = ?
        WHERE id = ?
      `);
    }

    this._stmtUpdateChunk.run(
      metadata.fileHash,
      metadata.chunkType,
      metadata.chunkIndex,
      metadata.startLine,
      metadata.endLine,
      Buffer.from(embedding.buffer),
      metadata.timestamp,
      metadata.contentHash,
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
    if (!this._stmtGetChunksByFile) {
      this._stmtGetChunksByFile = this.db.prepare(
        `SELECT * FROM chunks WHERE file_path = ?`
      );
    }
    const rows = this._stmtGetChunksByFile.all(filePath) as any[];
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

    if (!this._stmtGetSeqDef) {
      this._stmtGetSeqDef = this.db.prepare(`
        SELECT * FROM chunks 
        WHERE sequence_key = ? AND is_sequence_definition = 1 
        LIMIT 1
      `);
    }
    const row = this._stmtGetSeqDef.get(artifactName) as any;
    return row ? this.mapRowToRecord(row) : null;
  }

  /**
   * Link caller chunk to callee sequence definition
   */
  linkSequenceReference(callerChunkId: number, calleeChunkId: number, sequenceKey: string): void {
    if (!this._stmtLinkSeqRef) {
      this._stmtLinkSeqRef = this.db.prepare(`
        INSERT INTO sequence_references (caller_chunk_id, callee_chunk_id, sequence_key, timestamp)
        VALUES (?, ?, ?, ?)
      `);
    }
    this._stmtLinkSeqRef.run(callerChunkId, calleeChunkId, sequenceKey, Date.now());
  }

  deleteChunksByFile(filePath: string): void {
    // Delete FTS5 entries for all chunks in this file using a subquery (single statement)
    this.db.prepare(
      `DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)`
    ).run(filePath);

    if (!this._stmtDeleteChunksByFile) {
      this._stmtDeleteChunksByFile = this.db.prepare(
        `DELETE FROM chunks WHERE file_path = ?`
      );
    }
    this._stmtDeleteChunksByFile.run(filePath);
  }

  deleteChunk(id: number): void {
    this.deleteFts(id);
    if (!this._stmtDeleteChunk) {
      this._stmtDeleteChunk = this.db.prepare(`DELETE FROM chunks WHERE id = ?`);
    }
    this._stmtDeleteChunk.run(id);
  }

  getAllChunks(): ChunkRecord[] {
    if (!this._stmtGetAllChunks) {
      this._stmtGetAllChunks = this.db.prepare(`SELECT * FROM chunks`);
    }
    const rows = this._stmtGetAllChunks.all() as any[];
    return rows.map(this.mapRowToRecord);
  }

  private mapRowToRecord(row: any): ChunkRecord {
    return {
      id: row.id,
      filePath: row.file_path,
      fileHash: row.file_hash,
      chunkType: row.chunk_type,
      chunkIndex: row.chunk_index,
      startLine: row.start_line,
      endLine: row.end_line,
      timestamp: row.timestamp,
      embedding: row.embedding,
      contentHash: row.content_hash,
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
    if (!this._stmtGetFileHashes) {
      this._stmtGetFileHashes = this.db.prepare(`SELECT DISTINCT file_path, file_hash FROM chunks`);
    }
    const rows = this._stmtGetFileHashes.all() as Array<{ file_path: string; file_hash: string }>;
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
    if (!this._stmtGetChunkCount) {
      this._stmtGetChunkCount = this.db.prepare(`SELECT COUNT(*) AS cnt FROM chunks`);
    }
    const row = this._stmtGetChunkCount.get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Lightweight query for semantic search: returns only the fields needed for
   * scoring and ranking (id, embedding, filePath, chunkType, startLine, endLine, context).
   * Avoids deserializing full metadata (fileHash, contentHash, timestamps, etc.)
   * that is not needed at query time.
   */
  getAllChunkEmbeddings(): Array<{
    id: number;
    embedding: Buffer;
    filePath: string;
    chunkType: string;
    startLine: number;
    endLine: number;
    context: Record<string, any>;
  }> {
    if (!this._stmtGetAllEmbeddings) {
      this._stmtGetAllEmbeddings = this.db.prepare(
        `SELECT id, embedding, file_path, chunk_type, start_line, end_line, context_json FROM chunks`
      );
    }
    const rows = this._stmtGetAllEmbeddings.all() as any[];
    return rows.map(row => ({
      id: row.id,
      embedding: row.embedding,
      filePath: row.file_path,
      chunkType: row.chunk_type,
      startLine: row.start_line,
      endLine: row.end_line,
      context: JSON.parse(row.context_json),
    }));
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
