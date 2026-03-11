import * as fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'crypto';

/**
 * Semantic, Hierarchical, Structure-Aware XML Chunker for WSO2 MI artifacts
 *
 * Pure parsed-tree traversal — no external registry or heuristic rules.
 * Token count alone drives chunk boundaries; artifact metadata is read
 * directly from the XML root element's attributes.
 */

export interface XMLChunk {
  filePath: string;
  chunkType: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  content: string;
  embeddingText: string;
  contentHash: string;
  context: SemanticContext;
  sequenceKey?: string;
  isSequenceDefinition?: boolean;
  referencedSequences?: string[];
}

/**
 * Semantic context — fully generic, schema-agnostic.
 *
 * DESIGN: Only two explicit fields exist:
 *   - `artifact`: Root-level artifact metadata (read from the XML root element)
 *   - `references`: Cross-artifact references extracted from content
 *
 * All other context is stored dynamically via the `[key: string]: any` index
 * signature — making the chunker work identically for any XML schema.
 */
export interface SemanticContext {
  // Root-level artifact metadata (always present)
  artifact?: {
    type: string;
    name: string;
    xmlns?: string;
    [key: string]: any;
  };
  // Cross-artifact references extracted from chunk content
  references?: string[];
  // DYNAMIC: All element-level contexts are stored here automatically
  // Examples: { resource: { method: 'GET', uriTemplate: '/' }, filter: { source: '...' } }
  [key: string]: any;
}

interface LineRange {
  start: number;
  end: number;
}

export class XMLChunker {
  private chunkCounter = 0;
  private lastSearchPosition: number = 0;
  private readonly maxTokens: number;
  private embedder: any;

  constructor(embedder?: any, maxTokens?: number) {
    this.embedder = embedder;
    this.maxTokens = maxTokens ?? 256;
  }

  async chunkFile(filePath: string): Promise<XMLChunk[]> {
    this.chunkCounter = 0;
    this.lastSearchPosition = 0;
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const lines = xmlContent.split('\n');

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      removeNSPrefix: false, // Must preserve namespace for accurate context (e.g., wsp:Policy)
      preserveOrder: true,
      alwaysCreateTextNode: false,
    });

    const parsed = parser.parse(xmlContent);
    const chunks: XMLChunk[] = [];

    // Build root context from the parsed tree
    const rootContext = this.buildRootContext(parsed);

    this.processNode(parsed, lines, filePath, chunks, rootContext);

    return chunks;
  }

  /**
   * Build root context directly from the parsed XML tree.
   * Reads the first real root element and captures its tag name + all attributes.
   * No registry — the tree already has everything we need.
   */
  private buildRootContext(parsed: any): SemanticContext {
    const context: SemanticContext = {};

    if (!Array.isArray(parsed)) {
      context.artifact = { type: 'unknown', name: 'unknown' };
      return context;
    }

    // Find the first real element (skip ?xml processing instructions)
    const rootItem = parsed.find(item => {
      const key = Object.keys(item).find(k => k !== ':@');
      return key && !key.startsWith('?');
    });

    if (rootItem) {
      const rootTag = Object.keys(rootItem).find(k => k !== ':@') || 'unknown';
      const rootAttrs = this.extractAllAttributes(rootItem[':@'] || {});
      const name = rootAttrs.name || rootAttrs.key || rootTag;
      context.artifact = { type: rootTag, name, ...rootAttrs };
    } else {
      context.artifact = { type: 'unknown', name: 'unknown' };
    }

    return context;
  }

  /**
   * Extract cross-artifact references from a chunk's XML content.
   * Detects: sequence key, configKey (local entries), endpoint key,
   *          call-template target, useConfig (data service), call-query href.
   */
  private extractReferencesFromContent(content: string): string[] {
    const refs = new Set<string>();
    let match;

    // <sequence key="Name"/> → sequence reference
    const sequenceRefPattern = /<sequence\s+key=["']([^"']+)["']\s*\/>/g;
    while ((match = sequenceRefPattern.exec(content)) !== null) {
      refs.add(`sequence:${match[1]}`);
    }

    // configKey="Name" → local entry reference (used by http.post, email.send, etc.)
    const configKeyPattern = /configKey=["']([^"']+)["']/g;
    while ((match = configKeyPattern.exec(content)) !== null) {
      refs.add(`localEntry:${match[1]}`);
    }

    // <endpoint key="Name"/> → endpoint reference
    const endpointRefPattern = /<endpoint\s+key=["']([^"']+)["']\s*\/>/g;
    while ((match = endpointRefPattern.exec(content)) !== null) {
      refs.add(`endpoint:${match[1]}`);
    }

    // <call-template target="Name"/> → template reference
    const templateRefPattern = /<call-template\s+target=["']([^"']+)["']/g;
    while ((match = templateRefPattern.exec(content)) !== null) {
      refs.add(`template:${match[1]}`);
    }

    // useConfig="Name" → data service config reference
    const useConfigPattern = /useConfig=["']([^"']+)["']/g;
    while ((match = useConfigPattern.exec(content)) !== null) {
      refs.add(`config:${match[1]}`);
    }

    // <call-query href="Name"> → data service query reference
    const callQueryPattern = /<call-query\s+href=["']([^"']+)["']/g;
    while ((match = callQueryPattern.exec(content)) !== null) {
      refs.add(`query:${match[1]}`);
    }

    return Array.from(refs);
  }

  /**
   * PURE TREE TRAVERSAL with token gating
   *
   * Every XML tag is a potential chunk boundary — no heuristics, no registry rules.
   * Token count alone decides: fits → chunk, too big → descend into children.
   */
  private processNode(
    node: any,
    lines: string[],
    filePath: string,
    chunks: XMLChunk[],
    context: SemanticContext
  ): void {
    if (!Array.isArray(node)) return;

    for (const item of node) {
      const tagName = Object.keys(item).find(key => key !== ':@') || '';
      if (!tagName) continue;

      // Skip XML declaration, processing instructions, and #text pseudo-nodes
      // (#text is created by fast-xml-parser for mixed content — not a real XML tag)
      if (tagName.startsWith('?xml') || tagName === '#text') continue;

      const element = item[tagName];
      const nodeAttrs = item[':@'] || {};

      // Update context for this node — passed to children if we descend
      const updatedContext = this.updateContext(tagName, nodeAttrs, context);

      // Token gate: measure the full subtree content as embeddingText
      // Use parent context (not updatedContext) — the chunk's own tag is already in content
      const range = this.findElementRange(tagName, lines);
      const content = this.extractContent(lines, range);
      const embeddingText = this.createEmbeddingText(content, context);
      const tokenCount = this.countTokens(embeddingText);

      if (tokenCount <= this.maxTokens) {
        // Fits → emit this node as a chunk, stop descending
        this.createChunk(tagName, nodeAttrs, content, range, filePath, chunks, context, embeddingText);
      } else if (Array.isArray(element)) {
        // Too large → descend into children
        const childChunksBefore = chunks.length;
        this.processNode(element, lines, filePath, chunks, updatedContext);

        // Oversized leaf fallback: if no children produced chunks, force-emit this node
        if (chunks.length === childChunksBefore) {
          this.createChunk(tagName, nodeAttrs, content, range, filePath, chunks, context, embeddingText);
        }
      } else {
        // Leaf node (no children) that exceeds token limit → force-emit
        this.createChunk(tagName, nodeAttrs, content, range, filePath, chunks, context, embeddingText);
      }
    }
  }

  /**
   * Update semantic context as we traverse the tree.
   * FULLY GENERIC: reads directly from the parsed tree — no registry.
   */
  private updateContext(tagName: string, attrs: Record<string, string>, parentContext: SemanticContext): SemanticContext {
    const newContext = { ...parentContext };
    const localName = tagName.split(':').pop() || tagName;

    // Skip the root artifact tag — context.artifact was already set by buildRootContext.
    // Re-adding it here would duplicate it as a dynamic context key.
    if (tagName === parentContext.artifact?.type || localName === parentContext.artifact?.type) {
      return newContext;
    }

    // Generic context: capture all attributes for any element encountered during traversal.
    // Any attribute could be semantically important (e.g., methods, uri-template, xpath).
    const allAttrs = this.extractAllAttributes(attrs);

    if (Object.keys(allAttrs).length > 0) {
      newContext[localName] = allAttrs;
    } else {
      // No attributes (e.g., <then>, <else>, <inSequence>) — store as a string marker
      newContext[localName] = localName;
    }

    return newContext;
  }

  /**
   * Extract ALL non-internal attributes from an element, cleaning prefixes.
   * Used for artifact-level elements where every attribute is configuration-critical.
   */
  private extractAllAttributes(attrs: Record<string, string>): Record<string, any> {
    const allAttrs: Record<string, any> = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (!key.startsWith(':@') && !key.startsWith('@_')) {
        allAttrs[key] = value;
      } else if (key.startsWith('@_')) {
        allAttrs[key.substring(2)] = value;
      }
    }
    return allAttrs;
  }

  /**
   * Create a chunk from the current node
   */
  private createChunk(
    tagName: string,
    attrs: Record<string, string>,
    content: string,
    range: LineRange,
    filePath: string,
    chunks: XMLChunk[],
    context: SemanticContext,
    precomputedEmbeddingText?: string
  ): void {
    const chunkIndex = this.chunkCounter++;

    const embeddingText = precomputedEmbeddingText ?? this.createEmbeddingText(content, context);

    // Simplified content hash — hash the raw XML content only.
    // Used by Pipeline for incremental embedding reuse.
    const contentHash = createHash('sha256').update(content).digest('hex');

    // Extract references from this chunk's content.
    // NOTE: We do NOT mutate the shared `context` object here — that would
    // pollute the context passed to any sibling nodes processed afterwards.
    const chunkReferences = this.extractReferencesFromContent(content);

    // A chunk is a standalone artifact definition when its tag IS the root artifact tag.
    // This is true exactly when this chunk represents the top-level element of the file.
    const isDefinition = tagName === context.artifact?.type;
    const sequenceKey = isDefinition
      ? (attrs.name || attrs['@_name'] || attrs.key || attrs['@_key'])
      : undefined;

    chunks.push({
      filePath,
      chunkType: tagName,
      chunkIndex,
      startLine: range.start,
      endLine: range.end,
      content,
      embeddingText,
      contentHash,
      context: { ...context, references: chunkReferences.length > 0 ? chunkReferences : undefined },
      sequenceKey,
      isSequenceDefinition: isDefinition,
      referencedSequences: chunkReferences,
    });
  }

  /**
   * Count tokens using the model's tokenizer.
   * Receives the already-built embeddingText so the gate operates on the
   * exact same text that will be sent to the embedding model.
   *
   * Falls back to character approximation (~4 chars per token) when no
   * embedder is available (e.g., in tests).
   */
  private countTokens(text: string): number {
    if (this.embedder && this.embedder.countTokens) {
      return this.embedder.countTokens(text);
    }
    // Fallback to character approximation (~4 chars per token)
    return Math.ceil(text.length / 4);
  }

  /**
   * Format context metadata into text for token counting and embedding.
   * FULLY GENERIC: Iterates all context keys uniformly.
   * No hardcoded field-specific formatting.
   */
  private formatMetadata(context: SemanticContext): string {
    const parts: string[] = [];

    // 1. Artifact context (root-level metadata)
    if (context.artifact) {
      const { type, name, xmlns, ...rest } = context.artifact;
      parts.push(`${this.formatContextKey(type)}: ${name}`);
      // Include additional artifact attrs (context, transports, etc.)
      const extraPairs = Object.entries(rest)
        .filter(([k, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      if (extraPairs) parts.push(extraPairs);
    }

    // 2. DYNAMIC CONTEXT: Format ALL other context fields uniformly
    //    This handles resource, sequence, filter, query, operation, and ANY arbitrary element
    const skipKeys = new Set(['artifact', 'references']);

    for (const [key, value] of Object.entries(context)) {
      if (skipKeys.has(key) || value === undefined || value === null) continue;

      const formattedKey = this.formatContextKey(key);

      if (typeof value === 'string') {
        // Simple string context (e.g., sequence name)
        parts.push(`${formattedKey}: ${value}`);
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        // Object context with attributes
        const attrPairs = Object.entries(value)
          .filter(([k, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        if (attrPairs) {
          parts.push(`${formattedKey}: ${attrPairs}`);
        }
      }
    }

    // 3. References (if any)
    if (context.references && context.references.length > 0) {
      parts.push(`Uses: ${context.references.join(', ')}`);
    }

    return parts.join(' ');
  }

  /**
   * Format context key for display (e.g., "filter" -> "Filter", "Policy" -> "Policy")
   */
  private formatContextKey(key: string): string {
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  /**
   * Find the line range for an XML element.
   */
  private findElementRange(tagName: string, lines: string[]): LineRange {
    let startLine = -1;
    let endLine = -1;
    let depth = 0;

    // Escape regex metacharacters in tagName (e.g. '.' in 'http.post' must not match any char)
    const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    for (let i = this.lastSearchPosition; i < lines.length; i++) {
      const line = lines[i];

      if (startLine === -1) {
        const openPattern = new RegExp(`<${escapedTag}[\\s>/]`);
        if (openPattern.test(line)) {
          startLine = i + 1;
          this.lastSearchPosition = i + 1;

          if (line.includes('/>')) {
            endLine = i + 1;
            break;
          }
          depth = 1;
        }
      } else {
        const openPattern = new RegExp(`<${escapedTag}[\\s>]`);
        const closePattern = new RegExp(`</${escapedTag}>`);

        if (openPattern.test(line) && !line.includes('/>')) {
          depth++;
        }
        if (closePattern.test(line)) {
          depth--;
          if (depth === 0) {
            endLine = i + 1;
            break;
          }
        }
      }
    }

    if (startLine === -1) startLine = 1;
    if (endLine === -1) endLine = startLine;

    return { start: startLine, end: endLine };
  }

  private extractContent(lines: string[], range: LineRange): string {
    return lines.slice(range.start - 1, range.end).join('\n');
  }

  /**
   * Create natural text representation for embedding.
   * Format: [Formatted Context Metadata] + [Cleaned XML Content tokens]
   *
   * Example:
   *   context → "Api: BankAPI context=/bankapi Resource: method=GET uriTemplate=/"
   *   content → <payloadFactory><format>{"greeting":"Hello"}</format></payloadFactory>
   *   → "Api: BankAPI context=/bankapi Resource: method=GET payloadFactory format greeting Hello"
   */
  private createEmbeddingText(
    content: string,
    context: SemanticContext
  ): string {

    // Start with formatted context metadata as text
    const contextStr = this.formatMetadata(context);
    const tokens: string[] = contextStr ? [contextStr] : [];

    // JSON BLOCK PROTECTION: Preserve JSON inside format/args tags before cleaning
    // This prevents breaking structured payloads in embedding text
    const jsonBlocks: string[] = [];
    const jsonProtectedContent = content.replace(
      /<(format|args)[^>]*>([\s\S]*?)<\/\1>/g,
      (match, tag, jsonContent) => {
        // Check if the content looks like JSON
        const trimmed = jsonContent.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          const placeholder = `__JSON_BLOCK_${jsonBlocks.length}__`;
          jsonBlocks.push(`${tag} ${trimmed}`);
          return placeholder;
        }
        return match;
      }
    );

    // Comprehensive XML preprocessing: Remove all angle brackets and create natural text
    const cleanedContent = jsonProtectedContent
      // Extract tag names and attributes from opening tags: <tag attr="val"> → tag attr="val"
      .replace(/<([^>\/\s]+)([^>]*)>/g, ' $1 $2 ')
      // Remove closing tags: </tag> → (empty)
      .replace(/<\/[^>]+>/g, ' ')
      // Extract from self-closing tags: <tag attr="val"/> → tag attr="val"
      .replace(/<([^>\/\s]+)([^>]*)\s*\/>/g, ' $1 $2 ')
      // Clean up attribute formatting: attr="value" → attr=value
      .replace(/="([^"]*)"/g, '=$1')
      .replace(/='([^']*)'/g, '=$1')
      // Restore JSON blocks
      .replace(/__JSON_BLOCK_(\d+)__/g, (_, idx) => ` ${jsonBlocks[parseInt(idx)]} `)
      // Remove remaining special characters but preserve $, {, }, [, ] for expressions and paths
      .replace(/[^\w\s=\$\{\}\[\]\/\-\.,:@]/g, ' ')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim();

    // Split into meaningful tokens
    const contentTokens = cleanedContent
      .split(/\s+/)
      .filter(t => (t.length > 1 || /^\d+$/.test(t)) && t.length < 100); // Preserve numeric values (e.g. 0, 1) and longer tokens

    tokens.push(...contentTokens);

    return tokens.join(' ');
  }
}
