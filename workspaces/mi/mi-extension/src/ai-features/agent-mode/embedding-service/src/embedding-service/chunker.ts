import * as fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import { computeChunkHash } from '../db/merkle';
import { ArtifactRegistry, artifactRegistry, ArtifactMetadata } from './artifact-registry';

/**
 * Semantic, Hierarchical, Structure-Aware XML Chunker for WSO2 MI artifacts
 * 
 * Uses plugin-based ArtifactRegistry for extensible artifact detection.
 */

export interface XMLChunk {
  filePath: string;
  resourceName: string;
  resourceType: string;
  chunkType: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  content: string;
  parentChunkId: number | null;
  embeddingText: string;
  semanticType: string;
  semanticIntent: string;
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
 *   - `artifact`: Root-level artifact metadata (detected via registry or heuristics)
 *   - `references`: Cross-artifact references extracted from content
 * 
 * All other context (resource boundaries, sequence names, filters, etc.) is stored
 * dynamically via the `[key: string]: any` index signature. This means the chunker
 * works identically for `<api>/<resource>/<inSequence>` and `<aaappp>/<reesss>/<insq>`.
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
  private registry: ArtifactRegistry;

  constructor(embedder?: any, registry?: ArtifactRegistry) {
    this.embedder = embedder;
    this.registry = registry || artifactRegistry;
    this.maxTokens = 256;
  }

  async chunkFile(filePath: string): Promise<XMLChunk[]> {
    this.chunkCounter = 0;
    this.lastSearchPosition = 0;
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const lines = xmlContent.split('\n');

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      removeNSPrefix: false, // Must preserve namespace for accurate heuristics (e.g., wsp:Policy)
      preserveOrder: true,
      alwaysCreateTextNode: false,
    });

    const parsed = parser.parse(xmlContent);
    const chunks: XMLChunk[] = [];

    // Detect artifact type using registry
    const rootContext = this.buildRootContext(parsed, filePath);

    this.processNode(parsed, lines, filePath, chunks, null, rootContext);

    return chunks;
  }

  /**
   * Build root context by detecting artifact type from XML
   * Uses registry instead of path-based detection
   */
  private buildRootContext(parsed: any, filePath: string): SemanticContext {
    const context: SemanticContext = {};

    // Try to detect artifact type from XML structure
    const detected = this.registry.detectArtifactType(parsed);

    if (detected) {
      const { metadata } = detected;

      // UNIFORM: All artifact types stored in context.artifact
      // No special-casing for api/proxy/sequence — fully generic
      context.artifact = {
        type: metadata.type,
        name: metadata.name,
        xmlns: metadata.xmlns,
        ...metadata.additionalInfo,
      };
    } else {
      // Fallback: detect any artifact (including custom/unregistered types)
      // Pass filePath to infer type from folder structure
      const anyArtifact = this.registry.detectAnyArtifact(parsed, filePath);
      if (anyArtifact) {
        context.artifact = {
          type: anyArtifact.type,
          name: anyArtifact.name,
          xmlns: anyArtifact.xmlns,
          ...anyArtifact.additionalInfo,
        };
      } else {
        // Ultimate fallback if parsing completely fails
        context.artifact = {
          type: 'unknown',
          name: 'unknown',
        };
      }
    }

    return context;
  }

  /**
   * SEMANTIC BOUNDARY DETECTION (Registry-Based)
   * 
   * Queries the artifact registry instead of hardcoded lists.
   * Falls back to heuristics for unknown tags.
   */
  private isSemanticBoundary(tagName: string, attrs: Record<string, string> = {}, element?: any, parentTagName?: string): boolean {
    const localName = tagName.split(':').pop() || tagName;

    // 1. Registry Lookup (Explicit)
    // Check both full name (wsp:Policy) and local name (Policy)
    if (this.registry.isSemanticBoundary(tagName) || this.registry.isSemanticBoundary(localName)) {
      return true;
    }

    // 2. Dot Notation Rule (Mediators & Connectors)
    // e.g., http.post, google.spreadsheet, ENTC.agent
    // The dot is part of the tag name, NOT a namespace separator in this context
    if (tagName.includes('.')) {
      return true;
    }

    // 3. Namespace Pattern Rule (WS-* & Extensions)
    // Matches: lowercase_prefix:CamelCaseLocalName
    // e.g., wsp:Policy, throttle:ThrottleAssertion
    if (tagName.includes(':')) {
      const [prefix, localNamePart] = tagName.split(':', 2);
      // Heuristic: Prefix is lowercase alpha, LocalName starts with Uppercase
      const isNamespacePattern = /^[a-z]+$/.test(prefix) && /^[A-Z]/.test(localNamePart);
      if (isNamespacePattern) {
        return true;
      }
    }

    // 4. CamelCase Config Rule (Declarative Configuration)
    // e.g., Filter, ThrottleAssertion, MaximumConcurrentAccess
    // Legacy support for tags that behave like classes/objects
    // Exclude simple lowercase tags unless they match specific keywords
    if (/^[A-Z]/.test(localName) && !localName.includes('.')) {
      return true;
    }

    // 5. Standard Data Service / Flow Keywords
    const standardKeywords = ['query', 'operation', 'resource', 'config', 'validate', 'header'];
    if (standardKeywords.includes(localName)) {
      return true;
    }

    // 6. Universal Fallback (The Safety Net)
    // Rule A: Has identifying attributes (name, key, id, etc.)
    const attrCount = Object.keys(attrs).filter(k => !k.startsWith('#')).length;
    if (attrCount > 0) {
      return true;
    }

    // Rule B: Structural Complexity (Has multiple distinct children)
    // If it contains logic/structure, it's likely a container we want to chunk
    if (element && this.hasComplexStructure(element)) {
      return true;
    }

    // 7. Connector Child Rule (General)
    // If the immediate parent is a connector/mediator with a dot in its tag name
    // (e.g., <ai.agent>, <http.post>, <email.send>), ALL direct children are
    // configuration properties of that connector and should be chunked together.
    // This is purely structural — no hardcoded tag names anywhere.
    if (parentTagName && parentTagName.includes('.')) {
      return true;
    }

    return false;
  }

  /**
   * Check if element has complex nested structure (multiple distinct child tags)
   */
  private hasComplexStructure(element: any): boolean {
    if (!element || typeof element !== 'object') return false;

    // Count distinct child tags (exclude attributes, text, processing instructions)
    const childTags = Object.keys(element).filter(key =>
      !key.startsWith(':@') &&
      !key.startsWith('#') &&
      !key.startsWith('?')
    );

    return childTags.length >= 2;
  }

  /**
   * Check if tag is a resource type (uses registry)
   */
  private isResourceType(tagName: string): boolean {
    const localName = tagName.split(':').pop() || tagName;
    return this.registry.isResourceType(tagName) || this.registry.isResourceType(localName);
  }

  /**
   * Check if tag is a mediator type (uses registry)
   */
  private isMediatorType(tagName: string): boolean {
    const localName = tagName.split(':').pop() || tagName;
    // Query registry
    if (this.registry.isMediatorTag(tagName) || this.registry.isMediatorTag(localName)) {
      return true;
    }
    // Heuristic: http.* patterns are mediators
    return tagName.startsWith('http.');
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
   * EXCLUSIVE TOP-DOWN CHUNKING with token gating
   * 
   * Fully structure-based: chunkability is determined by registry + heuristics,
   * never by hardcoded tag names. Includes oversized leaf fallback.
   */
  private processNode(
    node: any,
    lines: string[],
    filePath: string,
    chunks: XMLChunk[],
    parentChunkId: number | null,
    context: SemanticContext,
    parentTagName?: string  // Tag name of the element that triggered this descent
  ): void {
    if (!Array.isArray(node)) return;

    for (const item of node) {
      const tagName = Object.keys(item).find(key => key !== ':@') || '';
      if (!tagName) continue;

      // Skip XML declaration and other processing instructions
      if (tagName.startsWith('?xml')) continue;

      const element = item[tagName];
      const nodeAttrs = item[':@'] || {};

      // Update context for THIS node (will be passed to children)
      const updatedContext = this.updateContext(tagName, nodeAttrs, context);

      // Check if this is a chunkable node
      // Pass parentTagName so Rule 7 (Connector Child) can fire for scalar children of connectors
      const isChunkable = this.isResourceType(tagName) ||
        this.isSemanticBoundary(tagName, nodeAttrs, element, parentTagName) ||
        this.isMediatorType(tagName);

      if (isChunkable) {
        // Token gating: Check if subtree fits within limit
        const range = this.findElementRange(tagName, this.getNodeName(tagName, element), lines);
        const content = this.extractContent(lines, range);
        // CRITICAL: Use parent context (not updatedContext) to avoid duplication
        // The chunk's own attributes are already in the content, so we should NOT include them in metadata
        const metadata = this.formatMetadata(context);
        const tokenCount = this.countTokens(content, metadata);

        if (tokenCount <= this.maxTokens) {
          // Subtree fits → Emit chunk with parent context (not updatedContext)
          this.createChunk(tagName, nodeAttrs, content, range, filePath, chunks, parentChunkId, context);
        } else {
          // Subtree too large → Descend to children with updated context, passing THIS tag as parent
          if (Array.isArray(element)) {
            const childChunksBefore = chunks.length;
            this.processNode(element, lines, filePath, chunks, parentChunkId, updatedContext, tagName);

            // OVERSIZED LEAF FALLBACK: If no children produced any chunks,
            // this is a leaf-like node that exceeds maxTokens.
            // Force-emit it as a chunk rather than silently dropping content.
            if (chunks.length === childChunksBefore) {
              this.createChunk(tagName, nodeAttrs, content, range, filePath, chunks, parentChunkId, context);
            }
          } else {
            // Atomic node with no children that exceeds maxTokens → force-emit
            const range = this.findElementRange(tagName, this.getNodeName(tagName, element), lines);
            const content = this.extractContent(lines, range);
            this.createChunk(tagName, nodeAttrs, content, range, filePath, chunks, parentChunkId, context);
          }
        }
      } else if (Array.isArray(element)) {
        // Non-chunkable container → traverse children, passing THIS tag as the parent
        this.processNode(element, lines, filePath, chunks, parentChunkId, updatedContext, tagName);
      } else if (typeof element === 'string' && element.trim().length > 0 && parentTagName && parentTagName.includes('.')) {
        // LEAF TEXT NODE inside a connector (e.g., <role> inside <ai.agent>):
        // The parent connector made this node chunkable via Rule 7, but fast-xml-parser
        // returns the text content as a raw string, not an array — so the normal
        // isChunkable path never fires for it. Handle it explicitly here.
        // We find its range and emit a chunk so no config property is ever silently dropped.
        const range = this.findElementRange(tagName, tagName, lines);
        const content = this.extractContent(lines, range);
        if (content.trim().length > 0) {
          this.createChunk(tagName, nodeAttrs, content, range, filePath, chunks, parentChunkId, context);
        }
      }
    }
  }

  /**
   * Update semantic context as we traverse the tree
   * FULLY GENERIC: No hardcoded tag names. Uses registry for artifact roots,
   * attribute-based heuristics for all other elements.
   */
  private updateContext(tagName: string, attrs: Record<string, string>, parentContext: SemanticContext): SemanticContext {
    const newContext = { ...parentContext };
    const localName = tagName.split(':').pop() || tagName;

    // 1. Check if this is a REGISTERED ARTIFACT ROOT TAG (via registry)
    //    e.g., api, proxy, sequence, endpoint, inboundEndpoint, data, etc.
    const plugin = this.registry.getPluginForRootTag(tagName) || this.registry.getPluginForRootTag(localName);
    if (plugin) {
      // Extract metadata using the plugin's own extractor
      const metadata = plugin.extractMetadata(tagName, attrs);
      const allAttrs = this.extractAllAttributes(attrs);
      newContext.artifact = {
        type: metadata.type,
        name: metadata.name,
        xmlns: metadata.xmlns,
        ...metadata.additionalInfo,
        ...allAttrs,
      };
    } else {
      // 2. GENERIC CONTEXT: For ALL other elements
      //    Capture ALL attributes (not just a whitelist) — any attribute could be
      //    semantically important in arbitrary XML (e.g., methods, uri-template, href)
      const allAttrs = this.extractAllAttributes(attrs);

      if (Object.keys(allAttrs).length > 0) {
        // Has attributes → store as object (e.g., resource: { methods: 'POST', 'uri-template': '/deposit' })
        newContext[localName] = allAttrs;
      } else {
        // No attributes (e.g., <then>, <else>, <onAccept>, <inSequence>)
        // Always add as string context — every element in the traversal path is meaningful.
        // updateContext is only called for element nodes, never for text/leaf content.
        newContext[localName] = localName;
      }
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
   * Extract identifying attributes from any element
   * These are attributes that help identify or describe what the element does
   */
  private extractIdentifyingAttributes(attrs: Record<string, string>): Record<string, any> {
    const identifyingAttrs: Record<string, any> = {};

    // Common identifying attribute patterns
    const identifyingKeys = [
      'name', '@_name',
      'id', '@_id',
      'key', '@_key',
      'xpath', '@_xpath',
      'source', '@_source',
      'regex', '@_regex',
      'type', '@_type',
      'expression', '@_expression',
      'value', '@_value',
      'media-type', '@_media-type',
      'category', '@_category',
      'level', '@_level',
      'target', '@_target',
      'uri', '@_uri',
      'method', '@_method',
    ];

    // Extract all identifying attributes that are present
    for (const key of identifyingKeys) {
      if (attrs[key]) {
        // Remove the '@_' prefix for cleaner context keys
        const cleanKey = key.startsWith('@_') ? key.substring(2) : key;
        identifyingAttrs[cleanKey] = attrs[key];
      }
    }

    // Also capture namespaced attributes (e.g., throttle:type)
    for (const [key, value] of Object.entries(attrs)) {
      if (key.includes(':') && !key.startsWith(':@')) {
        identifyingAttrs[key] = value;
      }
    }

    return identifyingAttrs;
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
    parentChunkId: number | null,
    context: SemanticContext
  ): void {
    const resourceName = attrs.name || attrs['@_name'] || attrs.key || attrs['@_key'] ||
      attrs.context || attrs['@_context'] || tagName;
    const chunkIndex = this.chunkCounter++;

    const embeddingText = this.createEmbeddingText(tagName, resourceName, content, attrs, context);
    const semanticType = this.mapToSemanticType(tagName);
    const semanticIntent = this.inferIntent(tagName, attrs, content);
    const contentHash = computeChunkHash(content, {
      type: semanticType,
      intent: semanticIntent,
      context,
    });

    // Extract references from this chunk's content
    const chunkReferences = this.extractReferencesFromContent(content);
    if (chunkReferences.length > 0) {
      context.references = chunkReferences;
    }

    // Detect if this is a standalone artifact definition
    const standaloneTypes = ['sequence', 'localEntry', 'endpoint', 'template'];
    const isStandalone = standaloneTypes.includes(tagName);
    const sequenceKey = isStandalone ? (attrs.name || attrs['@_name'] || attrs.key || attrs['@_key']) : undefined;

    // For custom artifacts, use the type inferred from context (folder-based)
    // Otherwise, use registered resource types or fallback to path-based inference
    const resourceType = context.artifact?.type ||
      (this.isResourceType(tagName) ? tagName : this.getResourceType(filePath));

    chunks.push({
      filePath,
      resourceName,
      resourceType,
      chunkType: tagName,
      chunkIndex,
      startLine: range.start,
      endLine: range.end,
      content,
      parentChunkId,
      embeddingText,
      semanticType,
      semanticIntent,
      contentHash,
      context: { ...context, references: chunkReferences.length > 0 ? chunkReferences : undefined },
      sequenceKey,
      isSequenceDefinition: isStandalone,
      referencedSequences: chunkReferences,
    });
  }

  /**
   * Map XML tag to semantic type
   * 
   * STRATEGY: Registry lookup first, then structural heuristics, then fallback.
   * No hardcoded tag-name-to-type mapping — works for arbitrary tags.
   */
  private mapToSemanticType(tagName: string): string {
    const localName = tagName.split(':').pop() || tagName;

    // 1. Registry: Check if it's a known root tag → use plugin id as type
    const plugin = this.registry.getPluginForRootTag(tagName) || this.registry.getPluginForRootTag(localName);
    if (plugin) return plugin.id;

    // 2. Registry: Check if it's a known mediator
    if (this.registry.isMediatorTag(tagName) || this.registry.isMediatorTag(localName)) return 'mediator';

    // 3. Registry: Check if it's a known semantic boundary
    if (this.registry.isSemanticBoundary(tagName) || this.registry.isSemanticBoundary(localName)) return 'boundary';

    // 4. Structural heuristics (tag-name-agnostic)
    if (tagName.includes('.')) return 'connector';           // http.post, google.sheets, etc.
    if (tagName.includes(':') && /^[A-Z]/.test(localName)) return 'policy';  // wsp:Policy, etc.
    if (/^[A-Z]/.test(localName)) return 'configuration';   // CamelCase → config element

    // 5. Generic fallback
    return 'component';
  }

  /**
   * Infer semantic intent from tag, attributes, and content
   * 
   * STRATEGY: Registry-aware checks first, then attribute-based heuristics.
   * Falls back to 'processing' for truly unknown elements.
   */
  private inferIntent(tagName: string, attrs: Record<string, string>, content: string): string {
    const localName = tagName.split(':').pop() || tagName;

    // 1. Registry: Check known mediator patterns
    if (this.registry.isMediatorTag(tagName) || this.registry.isMediatorTag(localName)) {
      // Sub-classify mediators by common patterns
      if (tagName.startsWith('http.') || localName === 'call' || localName === 'send') return 'delegation';
      if (localName === 'enrich' || localName === 'payloadFactory' || localName === 'xslt') return 'transformation';
      if (localName === 'log') return 'logging';
      if (localName === 'respond' || localName === 'drop') return 'response';
      return 'mediation';  // Generic mediator intent
    }

    // 2. Attribute-based heuristics (fully tag-name-agnostic)
    const attrKeys = Object.keys(attrs).map(k => k.replace(/^@_/, ''));
    if (attrKeys.includes('expression') || attrKeys.includes('xpath')) return 'transformation';
    if (attrKeys.includes('key') || attrKeys.includes('target')) return 'delegation';
    if (attrKeys.includes('source') || attrKeys.includes('regex')) return 'validation';

    // 3. Content-based heuristics
    if (content.includes('fault') || content.includes('error') || content.includes('Fault')) return 'error-handling';
    if (content.includes('SELECT') || content.includes('INSERT') || content.includes('sql')) return 'data-access';

    return 'processing';
  }

  /**
   * Count tokens using the model's tokenizer
   */
  private countTokens(content: string, metadata: string = ''): number {
    const fullText = metadata + ' ' + content;

    if (this.embedder && this.embedder.countTokens) {
      return this.embedder.countTokens(fullText);
    }
    // Fallback to character approximation (~4 chars per token)
    return Math.ceil(fullText.length / 4);
  }

  /**
   * Extract node name from element attributes
   */
  private getNodeName(tagName: string, element: any): string {
    const attrs = this.extractAttributes(element);
    return attrs.name || attrs['@_name'] || attrs.key || attrs['@_key'] ||
      attrs.context || attrs['@_context'] || tagName;
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
        .filter(([k, v]) => v !== undefined && v !== null && v !== '' && k !== 'isCustom' && k !== 'rootTag' && k !== 'inferredFromPath')
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

  private extractAttributes(element: any): Record<string, string> {
    const attrs: Record<string, string> = {};

    if (Array.isArray(element)) {
      for (const item of element) {
        if (item[':@']) {
          Object.assign(attrs, item[':@']);
          break;
        }
      }
    } else if (element && element[':@']) {
      Object.assign(attrs, element[':@']);
    }

    return attrs;
  }

  /**
   * Find the line range for an XML element
   * Automatically includes structural wrapper elements (onAccept, onReject, then, else, etc.)
   */
  private findElementRange(tagName: string, resourceName: string, lines: string[]): LineRange {
    let startLine = -1;
    let endLine = -1;
    let depth = 0;

    for (let i = this.lastSearchPosition; i < lines.length; i++) {
      const line = lines[i];

      if (startLine === -1) {
        const openPattern = new RegExp(`<${tagName}[\\s>/]`);
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
        const openPattern = new RegExp(`<${tagName}[\\s>]`);
        const closePattern = new RegExp(`</${tagName}>`);

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

    // GENERALIZABLE WRAPPER DETECTION:
    // Expand range to include structural wrapper elements (onAccept, onReject, then, else, etc.)
    // These are parent elements that have minimal/no attributes and provide structural context
    const expandedRange = this.expandRangeForStructuralWrappers(startLine, endLine, lines);

    return expandedRange;
  }

  /**
   * Expand a range to include structural wrapper elements
   * Detects wrappers generically without hardcoding tag names
   */
  private expandRangeForStructuralWrappers(startLine: number, endLine: number, lines: string[]): LineRange {
    let newStart = startLine;
    let newEnd = endLine;

    // Look backwards for structural wrapper opening tags
    // A structural wrapper is typically:
    // - A simple opening tag with no or minimal attributes
    // - Located immediately before our element (with possible whitespace)
    if (startLine > 1) {
      for (let i = startLine - 2; i >= 0 && i >= startLine - 5; i--) {
        const line = lines[i].trim();

        // Check if this line is a simple opening tag (e.g., <onAccept>, <then>, <else>)
        // Pattern: <tagname> or <tagname >, but NOT tags with attributes like <tag attr="value">
        const simpleOpeningTag = /^<(\w+:?\w*)>\s*$/;
        const match = line.match(simpleOpeningTag);

        if (match) {
          // Found a structural wrapper, expand to include it
          newStart = i + 1;
          // Continue looking for more nested wrappers
        } else if (line && !line.startsWith('<!--') && line !== '') {
          // Hit a non-wrapper line, stop searching
          break;
        }
      }
    }

    // Look forwards for corresponding closing tags
    // Match each wrapper we found when expanding backwards
    if (newStart < startLine && endLine < lines.length) {
      const wrappersToClose = startLine - newStart;
      let closedWrappers = 0;

      for (let i = endLine; i < lines.length && i < endLine + 10; i++) {
        const line = lines[i].trim();

        // Check if this is a simple closing tag
        const simpleClosingTag = /^<\/(\w+:?\w*)>\s*$/;
        if (simpleClosingTag.test(line)) {
          closedWrappers++;
          newEnd = i + 1;

          if (closedWrappers >= wrappersToClose) {
            break;
          }
        } else if (line && !line.startsWith('<!--') && line !== '') {
          // Hit a non-wrapper line before closing all wrappers
          break;
        }
      }
    }

    return { start: newStart, end: newEnd };
  }

  private extractContent(lines: string[], range: LineRange): string {
    return lines.slice(range.start - 1, range.end).join('\n');
  }

  private getResourceType(filePath: string): string {
    if (filePath.includes('/apis/')) return 'api';
    if (filePath.includes('/sequences/')) return 'sequence';
    if (filePath.includes('/proxy-services/')) return 'proxy';
    if (filePath.includes('/endpoints/')) return 'endpoint';
    if (filePath.includes('/local-entries/')) return 'localEntry';
    if (filePath.includes('/templates/')) return 'template';
    if (filePath.includes('/data-services/')) return 'dataService';
    if (filePath.includes('/data-sources/')) return 'dataSource';
    if (filePath.includes('/tasks/')) return 'task';
    if (filePath.includes('/message-stores/')) return 'messageStore';
    if (filePath.includes('/message-processors/')) return 'messageProcessor';
    if (filePath.includes('/inbound-endpoints/')) return 'inboundEndpoint';
    return 'unknown';
  }


  /**
   * Create natural text representation for embedding
   * Format: [JSON Context] + [Cleaned XML Content]
   * 
   * Example:
   *   Context: {"api":{"name":"BankAPI","context":"/bankapi"},"resource":{"method":"GET","uriTemplate":"/"}}
   *   Content: <payloadFactory><format>{"greeting":"Hello"}</format></payloadFactory>
   *   → {"api":{"name":"BankAPI","context":"/bankapi"},"resource":{"method":"GET"}} payloadFactory format greeting Hello
   */
  private createEmbeddingText(
    tagName: string,
    resourceName: string,
    content: string,
    attrs: Record<string, string>,
    context: SemanticContext
  ): string {

    //  // Start with JSON context for structured representation
    //   const contextStr = JSON.stringify(context);

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

    // Increased limit from 150 to 200 for better context representation
    return tokens.slice().join(' ');
  }
}
