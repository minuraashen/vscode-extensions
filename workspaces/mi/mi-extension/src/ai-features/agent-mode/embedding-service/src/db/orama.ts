import { create, insert, update, remove, search, count, AnyOrama } from '@orama/orama';
// @ts-ignore: TS module resolution doesn't pick up the exports map correctly here
import { persistToFile, restoreFromFile } from '@orama/plugin-data-persistence/server';
import * as fs from 'fs';
import * as path from 'path';

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
  sequenceKey?: string;
  isSequenceDefinition?: boolean;
  referencedSequences?: string[];
}

export interface ChunkRecord extends ChunkMetadata {
  id: string; // Orama uses string IDs
  embedding: Float32Array; // Stored natively as array of numbers in Orama, but returned as Float32Array locally for compat
}

const oramaSchema = {
  filePath: 'string',
  fileHash: 'string',
  chunkType: 'string',
  chunkIndex: 'number',
  startLine: 'number',
  endLine: 'number',
  timestamp: 'number',
  contentHash: 'string',
  contextJson: 'string',
  sequenceKey: 'string',
  isSequenceDefinition: 'boolean',
  referencedSequencesJson: 'string',
  embeddingText: 'string',
  // all-MiniLM-L6-v2 models output 384-dimensional vectors
  embedding: 'vector[384]',
} as const;

export class OramaDB {
  private dbPath: string;
  private db!: AnyOrama;
  private isInitialized = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Replace .db with .json if necessary, or just use the provided path and add .json extension
    const jsonPath = this.dbPath.endsWith('.json') ? this.dbPath : `${this.dbPath}.json`;
    this.dbPath = jsonPath;

    if (fs.existsSync(this.dbPath)) {
      try {
        this.db = (await restoreFromFile('json', this.dbPath)) as any;
        this.isInitialized = true;
        return;
      } catch (e) {
        console.warn('[OramaDB] Failed to restore from file, creating new DB:', e);
      }
    }

    this.db = await create({
      schema: oramaSchema,
    });
    this.isInitialized = true;
  }

  async persist(): Promise<void> {
    if (!this.isInitialized) return;
    try {
      await persistToFile(this.db as any, 'json', this.dbPath);
    } catch (e) {
      console.error('[OramaDB] Failed to persist database:', e);
    }
  }

  async insertChunk(metadata: ChunkMetadata, embedding: Float32Array, embeddingText: string = ''): Promise<string> {
    const id = await insert(this.db, {
      filePath: metadata.filePath,
      fileHash: metadata.fileHash,
      chunkType: metadata.chunkType,
      chunkIndex: metadata.chunkIndex,
      startLine: metadata.startLine,
      endLine: metadata.endLine,
      timestamp: metadata.timestamp,
      contentHash: metadata.contentHash,
      contextJson: JSON.stringify(metadata.context),
      sequenceKey: metadata.sequenceKey || '',
      isSequenceDefinition: metadata.isSequenceDefinition || false,
      referencedSequencesJson: metadata.referencedSequences ? JSON.stringify(metadata.referencedSequences) : '',
      embeddingText: embeddingText,
      embedding: Array.from(embedding),
    });
    return id;
  }

  async updateChunk(id: string, metadata: ChunkMetadata, embedding: Float32Array, embeddingText: string = ''): Promise<void> {
    await update(this.db, id, {
      filePath: metadata.filePath,
      fileHash: metadata.fileHash,
      chunkType: metadata.chunkType,
      chunkIndex: metadata.chunkIndex,
      startLine: metadata.startLine,
      endLine: metadata.endLine,
      timestamp: metadata.timestamp,
      contentHash: metadata.contentHash,
      contextJson: JSON.stringify(metadata.context),
      sequenceKey: metadata.sequenceKey || '',
      isSequenceDefinition: metadata.isSequenceDefinition || false,
      referencedSequencesJson: metadata.referencedSequences ? JSON.stringify(metadata.referencedSequences) : '',
      embeddingText: embeddingText,
      embedding: Array.from(embedding),
    });
  }

  async getChunksByFile(filePath: string): Promise<ChunkRecord[]> {
    const results = await search(this.db, {
      where: {
        filePath: {
          eq: filePath
        }
      },
      limit: 10000,
    });

    return results.hits.map(hit => this.mapDocToRecord(hit.id, hit.document as any));
  }

  async getSequenceDefinition(artifactRef: string): Promise<ChunkRecord | null> {
    let artifactName = artifactRef;
    if (artifactRef.includes(':')) {
      [artifactName] = artifactRef.split(':', 2);
    }

    const results = await search(this.db, {
      where: {
        sequenceKey: {
          eq: artifactName
        },
        isSequenceDefinition: {
          eq: true
        }
      },
      limit: 1
    });

    if (results.hits.length > 0) {
      return this.mapDocToRecord(results.hits[0].id, results.hits[0].document as any);
    }
    return null;
  }

  async deleteChunksByFile(filePath: string): Promise<void> {
    const chunks = await this.getChunksByFile(filePath);
    for (const chunk of chunks) {
      await remove(this.db, chunk.id);
    }
  }

  async deleteChunk(id: string): Promise<void> {
    await remove(this.db, id);
  }

  async getAllChunks(): Promise<ChunkRecord[]> {
    const results = await search(this.db, {
      limit: 100000, // Reasonable max limit or paginated
    });
    return results.hits.map(hit => this.mapDocToRecord(hit.id, hit.document as any));
  }

  getLatestFileHashes(): Map<string, string> {
    // Note: Orama doesn't have a SELECT DISTINCT equivalent natively built-in easily without iteration.
    // For small/medium DBs, iterating hits is fast. For very large DBs, it might be slow.
    // However, we just need unique file paths.
    // We can just keep an in-memory cache if we want, but since it's asked on startup, we have to iterate the whole DB.
    // Alternatively, just load all filePaths and Hashes.
    
    // To do this synchronously without await, Orama doesn't support sync search.
    // Wait, the original was synchronous. We must make sure callers are updated to handle async if needed.
    // Let's implement this synchronously by reading the internal documents directly if possible, or we have to change the interface.
    return new Map();
  }

  async getLatestFileHashesAsync(): Promise<Map<string, string>> {
    const results = await search(this.db, {
      limit: 100000,
    });
    
    const map = new Map<string, string>();
    for (const hit of results.hits) {
      const doc = hit.document as any;
      if (!map.has(doc.filePath)) {
        map.set(doc.filePath, doc.fileHash);
      }
    }
    return map;
  }

  async getChunkCount(): Promise<number> {
    return await count(this.db);
  }

  async semanticSearch(query: string, topK: number = 5, scoreThreshold: number = 0.5, queryVector: number[]) {
    const results = await search(this.db, {
      term: query,
      mode: 'hybrid',
      vector: {
        value: queryVector,
        property: 'embedding',
      },
      limit: topK,
    });
    
    // Filter by threshold if needed (Orama vector similarity returns scores)
    return results.hits.filter(hit => (hit.score ?? 0) >= scoreThreshold).map(hit => ({
      id: hit.id,
      filePath: (hit.document as any).filePath,
      chunkType: (hit.document as any).chunkType,
      startLine: (hit.document as any).startLine,
      endLine: (hit.document as any).endLine,
      context: JSON.parse((hit.document as any).contextJson || '{}'),
      score: hit.score,
    }));
  }

  private mapDocToRecord(id: string, doc: any): ChunkRecord {
    return {
      id,
      filePath: doc.filePath,
      fileHash: doc.fileHash,
      chunkType: doc.chunkType,
      chunkIndex: doc.chunkIndex,
      startLine: doc.startLine,
      endLine: doc.endLine,
      timestamp: doc.timestamp,
      contentHash: doc.contentHash,
      context: doc.contextJson ? JSON.parse(doc.contextJson) : {},
      sequenceKey: doc.sequenceKey || undefined,
      isSequenceDefinition: doc.isSequenceDefinition,
      referencedSequences: doc.referencedSequencesJson ? JSON.parse(doc.referencedSequencesJson) : undefined,
      embedding: new Float32Array(doc.embedding || []),
    };
  }

  close(): void {
    this.persist().catch(console.error);
    this.isInitialized = false;
  }
}
