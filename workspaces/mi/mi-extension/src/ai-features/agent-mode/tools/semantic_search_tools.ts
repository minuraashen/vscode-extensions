/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com/) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { tool } from 'ai';
import { z } from 'zod';
import {
    ToolResult,
    SemanticSearchResult,
    SemanticSearchResponse,
    SemanticSearchExecuteFn,
    SEMANTIC_SEARCH_TOOL_NAME,
} from './types';
import { SQLiteDB, ChunkRecord } from '../embedding-service/src/db/sqlite';
import { getEmbeddingService } from '../embedding-service/src/embedding-service/vscode-service';

// ============================================================================
// Constants
// ============================================================================

/** Default number of results to return */
const DEFAULT_TOP_K = 10;

/** Maximum results allowed per query */
const MAX_TOP_K = 50;

/** Default minimum similarity score threshold */
const DEFAULT_SCORE_THRESHOLD = 0.25;

/** BM25 weight relative to semantic score in hybrid search */
const BM25_WEIGHT = 0.15;

/** Semantic score weight in hybrid search */
const SEMANTIC_WEIGHT = 0.85;

/** MMR diversity lambda (0 = pure relevance, 1 = pure diversity) */
const MMR_LAMBDA = 0.7;

/** Overlap threshold for deduplication (fraction of line range overlap) */
const OVERLAP_THRESHOLD = 0.5;

// ============================================================================
// Core Search Logic
// ============================================================================

/**
 * Compute cosine similarity between two Float32Arrays.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

interface ScoredChunk {
    chunk: ChunkRecord;
    semanticScore: number;
    bm25Score: number;
    hybridScore: number;
}

/**
 * Perform BM25 keyword search using the FTS5 index.
 * Returns a map of chunk_id → BM25 rank score (normalized 0–1).
 */
function bm25Search(db: SQLiteDB, query: string, limit: number): Map<number, number> {
    const scores = new Map<number, number>();
    try {
        const handle = db.getHandle();
        const stmt = handle.prepare(`
            SELECT chunk_id, rank
            FROM chunks_fts
            WHERE chunks_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        `);
        const rows = stmt.all(query, limit * 3) as Array<{ chunk_id: number; rank: number }>;

        if (rows.length === 0) {
            return scores;
        }

        // FTS5 rank is negative; ORDER BY rank ASC means rows[0] is the BEST match
        // (most negative value). Normalize to 0–1 where 1 = best match.
        const bestRank = rows[0].rank;                 // most negative = best match
        const worstRank = rows[rows.length - 1].rank; // least negative = worst match
        const range = worstRank - bestRank || 1;       // always positive

        for (const row of rows) {
            // bestRank → 1.0, worstRank → 0.0
            const normalized = 1 - (row.rank - bestRank) / range;
            scores.set(row.chunk_id, normalized);
        }
    } catch {
        // FTS5 query failed (e.g. syntax error in query) — return empty
    }
    return scores;
}

/**
 * MMR (Maximal Marginal Relevance) reranking for result diversity.
 * Iteratively selects chunks that are both relevant and diverse.
 */
function mmrRerank(
    candidates: ScoredChunk[],
    queryEmbedding: Float32Array,
    k: number,
    lambda: number
): ScoredChunk[] {
    if (candidates.length <= k) {
        return candidates;
    }

    const selected: ScoredChunk[] = [];
    const remaining = new Set(candidates.map((_, i) => i));

    for (let step = 0; step < k && remaining.size > 0; step++) {
        let bestIdx = -1;
        let bestMmrScore = -Infinity;

        for (const idx of remaining) {
            const candidate = candidates[idx];
            const relevance = candidate.hybridScore;

            // Max similarity to already-selected chunks
            let maxSim = 0;
            for (const sel of selected) {
                const selEmb = new Float32Array(sel.chunk.embedding.buffer);
                const candEmb = new Float32Array(candidate.chunk.embedding.buffer);
                const sim = cosineSimilarity(selEmb, candEmb);
                if (sim > maxSim) {
                    maxSim = sim;
                }
            }

            const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
            if (mmrScore > bestMmrScore) {
                bestMmrScore = mmrScore;
                bestIdx = idx;
            }
        }

        if (bestIdx >= 0) {
            selected.push(candidates[bestIdx]);
            remaining.delete(bestIdx);
        }
    }

    return selected;
}

/**
 * Remove overlapping chunks: if two results cover the same file and their
 * line ranges overlap significantly, keep only the higher-scored one.
 */
function deduplicateOverlapping(results: ScoredChunk[]): ScoredChunk[] {
    const kept: ScoredChunk[] = [];

    for (const candidate of results) {
        let dominated = false;
        for (const existing of kept) {
            if (candidate.chunk.filePath !== existing.chunk.filePath) {
                continue;
            }
            // Compute overlap fraction
            const overlapStart = Math.max(candidate.chunk.startLine, existing.chunk.startLine);
            const overlapEnd = Math.min(candidate.chunk.endLine, existing.chunk.endLine);
            const overlapLines = Math.max(0, overlapEnd - overlapStart + 1);

            const candidateSpan = candidate.chunk.endLine - candidate.chunk.startLine + 1;
            const existingSpan = existing.chunk.endLine - existing.chunk.startLine + 1;
            const minSpan = Math.min(candidateSpan, existingSpan);

            if (minSpan > 0 && overlapLines / minSpan > OVERLAP_THRESHOLD) {
                dominated = true;
                break;
            }
        }
        if (!dominated) {
            kept.push(candidate);
        }
    }

    return kept;
}

/**
 * Build XML element hierarchy from chunk metadata context.
 */
function buildXmlHierarchy(chunk: ChunkRecord): string[] {
    const hierarchy: string[] = [];
    const ctx = chunk.context as Record<string, any>;

    if (ctx.artifact) {
        hierarchy.push(`${ctx.artifact.type}:${ctx.artifact.name}`);
    }
    if (ctx.resource) {
        const method = ctx.resource.method || ctx.resource.methods || '';
        const uri = ctx.resource.uriTemplate || ctx.resource['uri-template'] || '';
        hierarchy.push(`resource:${method} ${uri}`.trim());
    }

    // Add any sequence context
    if (ctx.sequence) {
        const seqName = typeof ctx.sequence === 'string'
            ? ctx.sequence
            : ctx.sequence?.name || 'sequence';
        hierarchy.push(`sequence:${seqName}`);
    }

    hierarchy.push(`${chunk.chunkType}:${chunk.resourceName}`);

    return hierarchy;
}

/**
 * Dynamically determine K based on query characteristics.
 * Short/specific queries get fewer results; broad queries get more.
 */
function adaptiveTopK(query: string, requestedK: number): number {
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length <= 2) {
        return Math.min(requestedK, 8);
    }
    if (words.length <= 5) {
        return requestedK;
    }
    // Broad queries benefit from more results
    return Math.min(requestedK + 5, MAX_TOP_K);
}

// ============================================================================
// Execute Function
// ============================================================================

/**
 * Creates the execute function for the semantic_code_search tool.
 *
 * @param projectPath - Absolute path to the MI project
 * @returns Async execute function conforming to SemanticSearchExecuteFn
 */
export function createSemanticSearchExecute(projectPath: string): SemanticSearchExecuteFn {
    return async (args) => {
        const startTime = Date.now();
        const { query, score_threshold, semantic_type } = args;
        const topK = Math.min(args.top_k ?? DEFAULT_TOP_K, MAX_TOP_K);

        try {
            // Get the embedding service (singleton per project)
            const service = getEmbeddingService(projectPath);

            // Wait for the service to finish initializing if it's still starting up.
            // The embedding service is kicked off in the background when the agent starts,
            // so it may still be loading the model / indexing when the first search arrives.
            if (service.isInitializing) {
                await service.waitForReady();
            }

            if (!service.isAvailable) {
                return {
                    success: false,
                    message:
                        'Semantic search is not available (embedding index not built). ' +
                        'FALLBACK REQUIRED: Use these tools instead:\n' +
                        '1. grep — search file contents by pattern/keyword\n' +
                        '2. glob — find files by name pattern\n' +
                        '3. file_read — read file contents at specific paths\n' +
                        `Original query: "${args.query}"`,
                    error: 'EMBEDDING_SERVICE_UNAVAILABLE',
                };
            }

            const db = service.database;
            const embedder = service.embedderInstance;

            if (!db || !embedder) {
                return {
                    success: false,
                    message:
                        'Semantic search components are not initialized. ' +
                        'FALLBACK REQUIRED: Use grep to search file contents and file_read to read files. ' +
                        `Original query: "${args.query}"`,
                    error: 'EMBEDDING_SERVICE_NOT_READY',
                };
            }

            // 1. Embed the query
            const queryEmbedding = await embedder.embed(query);

            // 2. Get all chunks and compute semantic similarity
            const allChunks = db.getAllChunks();

            if (allChunks.length === 0) {
                return {
                    success: true,
                    message:
                        'No indexed content found — the project may not have been indexed yet. ' +
                        'FALLBACK REQUIRED: Use grep and file_read tools to search the project. ' +
                        `Original query: "${query}"`,
                };
            }

            // 3. BM25 keyword scores
            const bm25Scores = bm25Search(db, query, topK);

            // 4. Score all chunks (semantic + BM25 hybrid)
            const effectiveK = adaptiveTopK(query, topK);
            const threshold = score_threshold ?? DEFAULT_SCORE_THRESHOLD;

            let scored: ScoredChunk[] = allChunks.map(chunk => {
                const chunkEmb = new Float32Array(chunk.embedding.buffer);
                const semScore = cosineSimilarity(queryEmbedding, chunkEmb);
                const bm25 = bm25Scores.get(chunk.id) ?? 0;
                const hybrid = SEMANTIC_WEIGHT * semScore + BM25_WEIGHT * bm25;

                return { chunk, semanticScore: semScore, bm25Score: bm25, hybridScore: hybrid };
            });

            // 5. Filter by score threshold
            scored = scored.filter(s => s.hybridScore >= threshold);

            // 6. Filter by semantic type if specified
            if (semantic_type) {
                scored = scored.filter(s => s.chunk.semanticType === semantic_type);
            }

            // 7. Sort by hybrid score descending
            scored.sort((a, b) => b.hybridScore - a.hybridScore);

            // 8. Take top candidates for MMR reranking (3x to give MMR room)
            const mmrCandidates = scored.slice(0, effectiveK * 3);

            // 9. MMR reranking for diversity
            const reranked = mmrRerank(mmrCandidates, queryEmbedding, effectiveK, MMR_LAMBDA);

            // 10. Deduplicate overlapping chunks
            const deduplicated = deduplicateOverlapping(reranked);

            // 11. Build response
            const results: SemanticSearchResult[] = deduplicated.slice(0, effectiveK).map(s => ({
                file_path: s.chunk.filePath,
                line_range: [s.chunk.startLine, s.chunk.endLine] as [number, number],
                xml_element_hierarchy: buildXmlHierarchy(s.chunk),
                score: Math.round(s.hybridScore * 10000) / 10000,
                chunk_id: `${s.chunk.id}`,
            }));

            const latencyMs = Date.now() - startTime;

            const response: SemanticSearchResponse = {
                results,
                confidence_threshold: threshold,
                query_latency_ms: latencyMs,
            };

            if (results.length === 0) {
                return {
                    success: true,
                    message:
                        `No results above threshold ${threshold} for query "${query}". ` +
                        `(${latencyMs}ms, ${allChunks.length} chunks searched). ` +
                        'FALLBACK REQUIRED: Use grep with relevant keywords and file_read to find matching code. ' +
                        'Try extracting key terms from your original query for the grep search.',
                };
            }

            // Format result for the agent (metadata only, no raw source)
            const formattedResults = results.map((r, i) =>
                `${i + 1}. [${r.score}] ${r.file_path}:${r.line_range[0]}-${r.line_range[1]}\n` +
                `   Hierarchy: ${r.xml_element_hierarchy.join(' → ')}`
            ).join('\n');

            return {
                success: true,
                message:
                    `Found ${results.length} result(s) for "${query}" ` +
                    `(${latencyMs}ms, threshold: ${threshold}):\n\n${formattedResults}\n\n` +
                    `Use file_read to inspect specific file contents at the indicated line ranges.`,
            };

        } catch (error) {
            const latencyMs = Date.now() - startTime;
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`[SemanticSearch] Query failed (${latencyMs}ms):`, error);

            return {
                success: false,
                message:
                    `Semantic search failed: ${errorMsg}. ` +
                    'FALLBACK REQUIRED: Use grep and file_read tools to search the project. ' +
                    `Original query: "${args.query}"`,
                error: 'SEMANTIC_SEARCH_ERROR',
            };
        }
    };
}

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * Creates the semantic_code_search tool for use with the Vercel AI SDK.
 *
 * @param execute - The execute function (from createSemanticSearchExecute)
 * @returns Tool definition compatible with the AI SDK streamText API
 */
export function createSemanticSearchTool(execute: SemanticSearchExecuteFn) {
    const inputSchema = z.object({
        query: z.string().describe(
            'Natural language search query describing what you are looking for. ' +
            'Be specific: e.g. "hotel booking POST endpoint" or "error handling sequence for payment".'
        ),
        top_k: z.number().optional().describe(
            'Maximum number of results to return (default: 10, max: 50). ' +
            'Use smaller values for targeted searches, larger for broad exploration.'
        ),
        score_threshold: z.number().optional().describe(
            'Minimum similarity score threshold (0-1, default: 0.25). ' +
            'Increase to get only highly relevant results.'
        ),
        semantic_type: z.string().optional().describe(
            'Filter results by semantic type. ' +
            'Common types: api, sequence, endpoint, proxy, mediator, connector, localEntry, template, dataService, task.'
        ),
    });

    return (tool as any)({
        description:
            'Search the MI project codebase using semantic similarity. ' +
            'Returns file paths, line ranges, and XML element hierarchy for matching code chunks. ' +
            'Use this as the PRIMARY code search tool for understanding project structure, ' +
            'finding relevant configurations, APIs, sequences, endpoints, and mediators. ' +
            'Results contain metadata only — use file_read with the returned line ranges to read actual content. ' +
            'Falls back gracefully if the semantic index is unavailable.',
        inputSchema,
        execute,
    });
}
