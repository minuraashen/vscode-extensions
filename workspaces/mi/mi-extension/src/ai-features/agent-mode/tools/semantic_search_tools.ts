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
import * as fs from 'fs';
import {
    ToolResult,
    SemanticSearchResult,
    SemanticSearchResponse,
    SemanticSearchConfidence,
    SemanticScoreDistribution,
    SemanticSearchExecuteFn,
    SEMANTIC_SEARCH_TOOL_NAME,
} from './types';
import { ChunkRecord } from '../embedding-service/src/db/sqlite';
import { getEmbeddingService } from '../embedding-service/src/embedding-service/vscode-service';

// ============================================================================
// Constants
// ============================================================================

/** Default number of results to return */
const DEFAULT_TOP_K = 12;

/** Maximum results allowed per query */
const MAX_TOP_K = 50;

/** Default minimum similarity score threshold */
const DEFAULT_SCORE_THRESHOLD = 0.25;

/** MMR diversity lambda (0 = pure relevance, 1 = pure diversity) */
const MMR_LAMBDA = 0.7;

/** Overlap threshold for deduplication (fraction of line range overlap) */
const OVERLAP_THRESHOLD = 0.5;


/** Score above which confidence is considered "high" */
const HIGH_CONFIDENCE_THRESHOLD = 0.50;

/** Score above which confidence is considered "medium" */
const MEDIUM_CONFIDENCE_THRESHOLD = 0.38;

/** Score above which confidence is considered "low" */
const LOW_CONFIDENCE_THRESHOLD = 0.30;

/** Ratio above which low-signal structural fragments should trigger a grep hint */
const HIGH_FRAGMENT_RATIO_THRESHOLD = 0.30;

/** Ratio below which returned chunks are considered clean enough for direct answering */
const CLEAN_FRAGMENT_RATIO_THRESHOLD = 0.20;

/** XML local tag names that are often structural wrappers when standalone */
const LOW_SIGNAL_STRUCTURAL_TAGS = new Set([
    'then',
    'else',
    'respond',
]);

/** Attributes that indicate semantic value even for short chunks */
const MEANINGFUL_ATTRIBUTE_NAMES = new Set([
    'name',
    'key',
    'value',
    'expression',
    'source',
    'target',
    'uri-template',
    'method',
    'sequence',
    'operation',
    'template',
    'endpoint',
    'scope',
    'regex',
]);

// ============================================================================
// Confidence directives (emitted in tool response — not in system prompt)
// Each directive is a clear, actionable instruction for the agent.
// ============================================================================

const CONFIDENCE_DIRECTIVES: Record<SemanticSearchConfidence, string> = {
    'high':        'CONFIDENCE: HIGH — answer directly from chunks. Do not run grep for the same query in this round.',
    'medium':      'CONFIDENCE: MEDIUM — answer from chunks if they can be confidently answerable with retrieved chunks. Use targeted grep and/or file_read if any selected chunk appears unclear or structurally incomplete/truncated.',
    'low':         'CONFIDENCE: LOW — skip semantic follow-up and switch directly to grep.',
    'very-low':    'CONFIDENCE: VERY LOW — fall back to grep immediately.',
};

// ============================================================================
// File Content Reader
// ============================================================================

/**
 * Read specific line range from a file (1-based, inclusive).
 * Returns the extracted lines as a string, or an empty string on error.
 */
function readFileLines(filePath: string, startLine: number, endLine: number): string {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        // Convert 1-based to 0-based index
        const start = Math.max(0, startLine - 1);
        const end = Math.min(lines.length - 1, endLine - 1);
        return lines.slice(start, end + 1).join('\n');
    } catch {
        return '';
    }
}

/**
 * Determine confidence level based on top result score.
 */
function computeConfidence(topScore: number, fragmentChunkRatio: number): SemanticSearchConfidence {
    if (topScore >= HIGH_CONFIDENCE_THRESHOLD) {
        return 'high';
    }

    if (topScore >= MEDIUM_CONFIDENCE_THRESHOLD) {
        return 'medium';
    }

    if (topScore >= LOW_CONFIDENCE_THRESHOLD) {
        return 'low';
    }
    return 'very-low';
}

function computeScoreDistribution(results: SemanticSearchResult[]): SemanticScoreDistribution {
    if (results.length === 0) {
        return { min: 0, max: 0, mean: 0, top_score: 0 };
    }

    const scores = results.map((r) => r.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const mean = scores.reduce((acc, v) => acc + v, 0) / scores.length;

    return {
        min:       Math.round(min  * 10000) / 10000,
        max:       Math.round(max  * 10000) / 10000,
        mean:      Math.round(mean * 10000) / 10000,
        top_score: Math.round(max  * 10000) / 10000,
    };
}

/**
 * Fraction of returned chunks that are low-signal structural fragments.
 * A high ratio (> HIGH_FRAGMENT_RATIO_THRESHOLD) hints that grep may be more precise.
 */
function parseXmlOpeningTag(content: string): {
    tagName: string;
    attributes: Record<string, string>;
} | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith('<') || trimmed.startsWith('<?') || trimmed.startsWith('<!--')) {
        return null;
    }

    const opening = trimmed.match(/^<([A-Za-z_][\w:.-]*)([^>]*)>/);
    if (!opening) {
        return null;
    }

    const tagName = opening[1];
    const attrBlock = opening[2] || '';
    const attributes: Record<string, string> = {};

    const attrRegex = /([:@A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrBlock)) !== null) {
        const attrName = attrMatch[1];
        const attrValue = attrMatch[3] ?? attrMatch[4] ?? '';
        attributes[attrName] = attrValue;
    }

    return { tagName, attributes };
}

function isLowSignalFragmentChunk(result: SemanticSearchResult): boolean {
    const content = result.content?.trim();
    if (!content) {
        return false;
    }

    const opening = parseXmlOpeningTag(content);
    if (!opening) {
        return false;
    }

    const localTag = (opening.tagName.split(':').pop() || opening.tagName).toLowerCase();
    if (!LOW_SIGNAL_STRUCTURAL_TAGS.has(localTag)) {
        return false;
    }

    const attributeNames = Object.keys(opening.attributes)
        .map((n) => n.toLowerCase())
        .filter((n) => !n.startsWith('xmlns'));

    const hasMeaningfulAttribute = attributeNames.some((name) =>
        MEANINGFUL_ATTRIBUTE_NAMES.has(name) || /(key|name|uri|method|expression|source|target|path|scope|value)/.test(name)
    );

    const textOnly = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const hasMeaningfulText = textOnly.length >= 3;

    return !hasMeaningfulAttribute && !hasMeaningfulText;
}

function computeFragmentChunkRatio(results: SemanticSearchResult[]): number {
    if (results.length === 0) {
        return 0;
    }
    const fragmentCount = results.filter(isLowSignalFragmentChunk).length;
    return Math.round((fragmentCount / results.length) * 10000) / 10000;
}

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
        dot   += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

interface ScoredChunk {
    chunk: ChunkRecord;
    semanticScore: number;
}

/**
 * MMR (Maximal Marginal Relevance) reranking for result diversity.
 * Iteratively selects chunks that are both relevant and dissimilar to already-selected ones.
 *
 * NOTE: We fetch (effectiveK * 3) candidates before calling this so MMR has enough
 * room to select diverse results without being constrained by a tight candidate pool.
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

    // Pre-compute Float32Array embeddings once to avoid repeated Buffer→Float32Array
    // conversions inside the O(k × n) inner loop.
    const embeddingCache = new Map<number, Float32Array>();
    for (let i = 0; i < candidates.length; i++) {
        embeddingCache.set(i, new Float32Array(candidates[i].chunk.embedding.buffer));
    }

    const selected: ScoredChunk[] = [];
    const selectedIndices: number[] = [];
    const remaining = new Set(candidates.map((_, i) => i));

    for (let step = 0; step < k && remaining.size > 0; step++) {
        let bestIdx = -1;
        let bestMmrScore = -Infinity;

        for (const idx of remaining) {
            const relevance = candidates[idx].semanticScore;
            const candEmb = embeddingCache.get(idx)!;

            // Max similarity to already-selected chunks (penalises redundancy)
            let maxSim = 0;
            for (const selIdx of selectedIndices) {
                const sim = cosineSimilarity(embeddingCache.get(selIdx)!, candEmb);
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
            selectedIndices.push(bestIdx);
            remaining.delete(bestIdx);
        }
    }

    return selected;
}

/**
 * Remove overlapping chunks: if two results cover the same file and their
 * line ranges overlap by more than OVERLAP_THRESHOLD, keep only the first-seen one.
 *
 * IMPORTANT: This function relies on `reranked` being ordered by MMR score (highest first).
 * MMR always selects the most relevant chunk when the selected set is empty, so the
 * highest-relevance chunk from each overlapping group is encountered first and retained.
 * Do not call this on an unsorted slice.
 */
function deduplicateOverlapping(results: ScoredChunk[]): ScoredChunk[] {
    const kept: ScoredChunk[] = [];

    for (const candidate of results) {
        let dominated = false;
        for (const existing of kept) {
            if (candidate.chunk.filePath !== existing.chunk.filePath) {
                continue;
            }
            const overlapStart = Math.max(candidate.chunk.startLine, existing.chunk.startLine);
            const overlapEnd   = Math.min(candidate.chunk.endLine,   existing.chunk.endLine);
            const overlapLines = Math.max(0, overlapEnd - overlapStart + 1);

            const candidateSpan = candidate.chunk.endLine - candidate.chunk.startLine + 1;
            const existingSpan  = existing.chunk.endLine  - existing.chunk.startLine  + 1;
            const minSpan       = Math.min(candidateSpan, existingSpan);

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
        const uri    = ctx.resource.uriTemplate || ctx.resource['uri-template'] || '';
        hierarchy.push(`resource:${method} ${uri}`.trim());
    }
    if (ctx.sequence) {
        const seqName = typeof ctx.sequence === 'string'
            ? ctx.sequence
            : ctx.sequence?.name || 'sequence';
        hierarchy.push(`sequence:${seqName}`);
    }

    const localCtx  = ctx[chunk.chunkType];
    const localName = typeof localCtx === 'string'
        ? ''
        : (localCtx?.name || localCtx?.key || localCtx?.['@_name'] || localCtx?.['@_key'] || '');
    hierarchy.push(localName ? `${chunk.chunkType}:${localName}` : chunk.chunkType);

    return hierarchy;
}

/**
 * Adjust effective K based on query breadth.
 *
 * Short/specific queries need fewer candidates; broad queries benefit from more
 * to give MMR enough room for diversity selection.
 * The final output is always capped at effectiveK via the trailing slice.
 */
function adaptiveTopK(query: string, requestedK: number): number {
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length <= 2) {
        return Math.min(requestedK, 8);      // targeted — fewer candidates needed
    }
    if (words.length <= 5) {
        return requestedK;                   // moderate — use requested K as-is
    }
    return Math.min(requestedK + 5, MAX_TOP_K); // broad — give MMR more room
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
        const { query, score_threshold } = args;
        const topK = Math.min(args.top_k ?? DEFAULT_TOP_K, MAX_TOP_K);

        try {
            // Get the embedding service (singleton per project)
            const service = getEmbeddingService(projectPath);

            // The embedding service initialises in the background when the agent starts.
            // Wait here if it hasn't finished yet.
            if (service.isInitializing) {
                await service.waitForReady();
            }

            if (!service.isAvailable) {
                return {
                    success: false,
                    message:
                        'Semantic search is not available (embedding index not built). ' +
                        'FALLBACK: Use grep to search by keyword/pattern, glob to find files by name, ' +
                        'and file_read to inspect specific files. ' +
                        `Original query: "${args.query}"`,
                    error: 'EMBEDDING_SERVICE_UNAVAILABLE',
                };
            }

            const effectiveK  = adaptiveTopK(query, topK);
            const threshold   = score_threshold ?? DEFAULT_SCORE_THRESHOLD;

            let results: SemanticSearchResult[] = [];
            let searchedChunkCount = 0;
            let latencyMs = Date.now() - startTime;

            const workerSearch = await service.semanticSearchWithWorker(query, effectiveK, threshold);
            if (workerSearch) {
                searchedChunkCount = workerSearch.totalChunksScanned;
                latencyMs = workerSearch.latencyMs || (Date.now() - startTime);
                results = workerSearch.hits.map((hit) => {
                    const pseudoChunk = {
                        chunkType: hit.chunkType,
                        context: hit.context,
                    } as unknown as ChunkRecord;

                    return {
                        file_path:             hit.filePath,
                        line_range:            [hit.startLine, hit.endLine] as [number, number],
                        xml_element_hierarchy: buildXmlHierarchy(pseudoChunk),
                        score:                 Math.round(hit.score * 10000) / 10000,
                        chunk_id:              `${hit.id}`,
                        content:               readFileLines(hit.filePath, hit.startLine, hit.endLine),
                    } satisfies SemanticSearchResult;
                });
            } else {
                const db       = service.database;
                const embedder = service.embedderInstance;

                if (!db || !embedder) {
                    return {
                        success: false,
                        message:
                            'Semantic search components are not initialised. ' +
                            'FALLBACK: Use grep and file_read tools to search the project. ' +
                            `Original query: "${args.query}"`,
                        error: 'EMBEDDING_SERVICE_NOT_READY',
                    };
                }

                // 1. Embed the query
                const queryEmbedding = await embedder.embed(query);

                // 2. Retrieve all chunk embeddings for scoring (lightweight DB query)
                const allChunkEmbeddings = db.getAllChunkEmbeddings();
                searchedChunkCount = allChunkEmbeddings.length;

                if (allChunkEmbeddings.length === 0) {
                    return {
                        success: true,
                        message:
                            'No indexed content found — the project may not have been indexed yet. ' +
                            'FALLBACK: Use grep and file_read to search the project. ' +
                            `Original query: "${query}"`,
                    };
                }

                // 3. Score all chunks via cosine similarity
                let scored: ScoredChunk[] = allChunkEmbeddings.map(chunk => ({
                    chunk: chunk as any as ChunkRecord,
                    semanticScore: cosineSimilarity(queryEmbedding, new Float32Array(chunk.embedding.buffer)),
                }));

                // 4. Filter by score threshold
                scored = scored.filter(s => s.semanticScore >= threshold);

                // 5. Sort descending by semantic score
                scored.sort((a, b) => b.semanticScore - a.semanticScore);

                // 6. Take top candidates for MMR (3x effectiveK gives diversity room)
                const mmrCandidates = scored.slice(0, effectiveK * 3);

                // 7. MMR reranking for diversity
                const reranked = mmrRerank(mmrCandidates, queryEmbedding, effectiveK, MMR_LAMBDA);

                // 8. Deduplicate overlapping chunks (relies on MMR ordering — see function doc)
                const deduplicated = deduplicateOverlapping(reranked);

                // 9. Build final results with inline source snippets
                results = deduplicated.slice(0, effectiveK).map(s => ({
                    file_path:             s.chunk.filePath,
                    line_range:            [s.chunk.startLine, s.chunk.endLine] as [number, number],
                    xml_element_hierarchy: buildXmlHierarchy(s.chunk),
                    score:                 Math.round(s.semanticScore * 10000) / 10000,
                    chunk_id:              `${s.chunk.id}`,
                    content:               readFileLines(s.chunk.filePath, s.chunk.startLine, s.chunk.endLine),
                }));

                latencyMs = Date.now() - startTime;
            }

            const scoreDistribution  = computeScoreDistribution(results);
            const fragmentChunkRatio = computeFragmentChunkRatio(results);
            const confidence         = computeConfidence(scoreDistribution.top_score, fragmentChunkRatio);

            const response: SemanticSearchResponse = {
                results,
                confidence_threshold: threshold,
                query_latency_ms:     latencyMs,
                confidence,
                score_distribution:  scoreDistribution,
                fragment_chunk_ratio: fragmentChunkRatio,
                query,
            };

            if (results.length === 0) {
                return {
                    success: true,
                    message:
                        `No results above threshold ${threshold} for query "${query}" ` +
                        `(${latencyMs}ms, ${searchedChunkCount} chunks searched). ` +
                        'FALLBACK: Use grep with keywords from your query to find matching code.',
                };
            }

            // Build result blocks containing inline source snippets
            const xmlArtifacts = results.map((r, i) => {
                const hierarchy     = r.xml_element_hierarchy.join(' → ');
                const contentBlock  = r.content
                    ? `\n<source_content>\n${r.content}\n</source_content>`
                    : '';
                return (
                    `<code_chunk index="${i + 1}" score="${r.score}" file="${r.file_path}" ` +
                    `lines="${r.line_range[0]}-${r.line_range[1]}" hierarchy="${hierarchy}">${contentBlock}\n</code_chunk>`
                );
            }).join('\n\n');

            const directive = CONFIDENCE_DIRECTIVES[confidence];

            // Directive note: computed from actual scores, tells the agent exactly what to do next.
            const confidenceNote = `\n\n${directive}`;

            // Fragment ratio hint: only emitted when ratio is high enough to matter.
            const fragmentRatioNote = fragmentChunkRatio > HIGH_FRAGMENT_RATIO_THRESHOLD
                ? '\nHigh low-signal fragment ratio — prefer grep for exact literals/patterns.'
                : '';

            if (confidence === 'medium' && results.length > 0) {
                console.debug('[SemanticSearch] Medium confidence query', {
                    query,
                    topScore: scoreDistribution.top_score,
                    fragmentChunkRatio,
                    resultCount: results.length,
                    topScores: results.slice(0, 3).map((r) => r.score),
                });
            }

            return {
                success: true,
                message:
                    `Found ${results.length} result(s) for "${query}" ` +
                    `(${latencyMs}ms, threshold: ${threshold}, confidence: ${confidence}):\n\n` +
                    `<search_results>\n${xmlArtifacts}\n</search_results>` +
                    confidenceNote +
                    fragmentRatioNote,
                semanticSearchData: response,
            } as any;

        } catch (error) {
            const latencyMs = Date.now() - startTime;
            const errorMsg  = error instanceof Error ? error.message : String(error);
            console.error(`[SemanticSearch] Query failed (${latencyMs}ms):`, error);

            return {
                success: false,
                message:
                    `Semantic search failed: ${errorMsg}. ` +
                    'FALLBACK: Use grep and file_read tools to search the project. ' +
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
 * Decision logic (score interpretation, fragment rules, top_k guidance) lives here
 * in the tool description — paid only when the model is selecting tools — rather
 * than in the system prompt, which is paid on every request.
 *
 * @param execute - The execute function (from createSemanticSearchExecute)
 * @returns Tool definition compatible with the AI SDK streamText API
 */
export function createSemanticSearchTool(execute: SemanticSearchExecuteFn) {
    const inputSchema = z.object({
        query: z.string().describe(
            'Natural language query describing what you are looking for. ' +
            'Be specific: e.g. "hotel booking POST endpoint" or "error handling sequence for payment".'
        ),
        top_k: z.number().optional().describe(
            'Maximum results to return (default: 12, max: 50). ' +
            'Use 6 for targeted single-artifact lookup, 12 for general exploration, 20 for broad architecture synthesis.'
        ),
        score_threshold: z.number().optional().describe(
            'Minimum similarity score 0–1 (default: 0.25). ' +
            'Use 0.28 for Synapse XML projects. Use 0.35 for targeted single-artifact queries. ' +
            'In Synapse XML, scores ≥ 0.38 are medium-band matches; scores < 0.30 should generally fall back to grep.'
        ),
    });

    return (tool as any)({
        description:
            'Semantic similarity search over the MI project codebase. ' +
            'Returns file paths, line ranges, XML element hierarchy, and inline source snippets for matching chunks. ' +
            'Token-efficiency objective: use this tool primarily for conceptual/natural-language queries to retrieve only the most relevant chunks. ' +
            'Use as the PRIMARY search tool for conceptual or cross-cutting queries where the artifact name, ' +
            'key, or file path is not already known. ' +
            'Skip and use grep directly for: known exact literals (artifact names, endpoint keys, API context paths, ' +
            'sequence names, mediator attributes, property/variable names such as camelCase/snake_case/SCREAMING_SNAKE_CASE tokens), known file paths, or new-file creation tasks. ' +
            'Use one primary search tool per query round: if semantic search is used, do not also call grep for the same query unless confidence/fragment hints require escalation. ' +
            'Each result includes a confidence label and actionable fallback directive — follow them without further interpretation. ' +
            'Falls back gracefully when the semantic index is unavailable.',
        inputSchema,
        execute,
    });
}