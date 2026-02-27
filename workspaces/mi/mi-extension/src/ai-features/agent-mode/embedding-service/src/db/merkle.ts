import { createHash } from 'crypto';

/**
 * Merkle Tree Implementation for Embedding Storage
 * 
 * Purpose:
 * - Detect chunk changes efficiently without re-embedding unchanged content
 * - Enable incremental updates by comparing content hashes
 * - Maintain semantic grouping at API/Resource/Sequence levels
 */

export interface MerkleLeaf {
  chunkId: string;        // Unique identifier (filePath:chunkIndex)
  contentHash: string;    // SHA-256 hash of (xml + metadata)
  embedding: Float32Array | null;
  metadata: {
    type: string;         // filter | payloadFactory | sequence | resource | api
    intent: string;       // validation | transformation | delegation | response
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
  };
}

export interface MerkleNode {
  hash: string;           // Hash of children hashes
  level: string;          // 'artifact' | 'resource' | 'sequence' | 'root'
  children: (MerkleNode | MerkleLeaf)[];
  label: string;          // Human-readable label (artifact name, resource path, etc.)
}

/**
 * Compute content hash for a chunk
 * Includes XML content + semantic metadata to detect meaningful changes
 */
export function computeChunkHash(
  xmlContent: string,
  metadata: MerkleLeaf['metadata']
): string {
  const hashInput = JSON.stringify({
    xml: xmlContent,
    type: metadata.type,
    intent: metadata.intent,
    context: metadata.context,
  });
  return createHash('sha256').update(hashInput).digest('hex');
}

/**
 * Compute hash for a Merkle node based on its children
 * This allows efficient change detection at any level of the tree
 */
export function computeNodeHash(children: (MerkleNode | MerkleLeaf)[]): string {
  if (children.length === 0) {
    throw new Error("Cannot compute a node hash with zero children.");
  }
  const childHashes = children.map(child =>
    'hash' in child ? child.hash : child.contentHash
  );
  const combined = childHashes.sort().join('|');
  return createHash('sha256').update(combined).digest('hex');
}

/**
 * Dynamically resolve artifact name from context
 * Works with any artifact type - no hardcoded checks needed
 */
function resolveArtifactName(ctx: MerkleLeaf['metadata']['context']): string {
  // Try common patterns first
  if (ctx.api?.name) return ctx.api.name;
  if (ctx.resource?.uriTemplate) return `resource:${ctx.resource.uriTemplate}`;

  // Handle sequence (can be string or object)
  if (ctx.sequence) {
    if (typeof ctx.sequence === 'string') return ctx.sequence;
    if (ctx.sequence.name) return ctx.sequence.name;
  }

  // Generic artifact context (from plugin-based detection)
  if ((ctx as any).artifact?.name) return (ctx as any).artifact.name;

  // Try all known context keys dynamically
  const knownKeys = ['localEntry', 'endpoint', 'template', 'proxyService',
    'messageStore', 'messageProcessor', 'dataService', 'task'];
  for (const key of knownKeys) {
    const value = (ctx as any)[key];
    if (value?.name) return value.name;
    if (value?.key) return value.key;
  }

  return 'unknown';
}

/**
 * Build Merkle tree from flat list of chunks
 * Groups chunks hierarchically: Artifact → Resource → Sequence → Leaf
 */
export function buildMerkleTree(leaves: MerkleLeaf[]): MerkleNode {
  // Group by artifact using dynamic resolution
  const artifactGroups = groupBy(leaves, leaf => resolveArtifactName(leaf.metadata.context));

  const artifactNodes: MerkleNode[] = [];

  // Sort entries for deterministic tree structure
  for (const [artifactName, artifactLeaves] of Object.entries(artifactGroups).sort(([a], [b]) => a.localeCompare(b))) {
    // Group by resource within artifact
    const resourceGroups = groupBy(artifactLeaves, leaf => {
      const resource = leaf.metadata.context.resource;
      return resource ? `${resource.method} ${resource.uriTemplate}` : 'root';
    });

    const resourceNodes: MerkleNode[] = [];

    // Sort entries for deterministic tree structure
    for (const [resourceName, resourceLeaves] of Object.entries(resourceGroups).sort(([a], [b]) => a.localeCompare(b))) {
      // Group by sequence within resource
      const sequenceGroups = groupBy(resourceLeaves, leaf => {
        const seq = leaf.metadata.context.sequence;
        if (typeof seq === 'string') return seq;
        if (seq && typeof seq === 'object') return seq.name || 'direct';
        return 'direct';
      });

      const sequenceNodes: (MerkleNode | MerkleLeaf)[] = [];

      // Sort entries for deterministic tree structure
      for (const [sequenceName, sequenceLeaves] of Object.entries(sequenceGroups).sort(([a], [b]) => a.localeCompare(b))) {
        if (sequenceLeaves.length === 1) {
          // Single leaf - add directly
          sequenceNodes.push(sequenceLeaves[0]);
        } else {
          // Multiple leaves - create sequence node
          const sequenceNode: MerkleNode = {
            hash: computeNodeHash(sequenceLeaves),
            level: 'sequence',
            children: sequenceLeaves,
            label: sequenceName,
          };
          sequenceNodes.push(sequenceNode);
        }
      }

      const resourceNode: MerkleNode = {
        hash: computeNodeHash(sequenceNodes),
        level: 'resource',
        children: sequenceNodes,
        label: resourceName,
      };
      resourceNodes.push(resourceNode);
    }

    const artifactNode: MerkleNode = {
      hash: computeNodeHash(resourceNodes),
      level: 'artifact',
      children: resourceNodes,
      label: artifactName,
    };
    artifactNodes.push(artifactNode);
  }

  // Root node
  return {
    hash: computeNodeHash(artifactNodes),
    level: 'root',
    children: artifactNodes,
    label: 'root',
  };
}

/**
 * Compare two Merkle trees and return changed leaf nodes
 * Only leaves with different contentHash need re-embedding
 */
export function findChangedLeaves(
  oldTree: MerkleNode | MerkleLeaf | null,
  newTree: MerkleNode | MerkleLeaf
): MerkleLeaf[] {
  if (!oldTree) {
    // No old tree - all leaves are new
    return collectAllLeaves(newTree);
  }

  // Both are leaves
  if ('chunkId' in oldTree && 'chunkId' in newTree) {
    return oldTree.contentHash !== newTree.contentHash ? [newTree] : [];
  }

  // Type mismatch - treat as changed
  if ('chunkId' in oldTree !== 'chunkId' in newTree) {
    return collectAllLeaves(newTree);
  }

  // Both are nodes
  const oldNode = oldTree as MerkleNode;
  const newNode = newTree as MerkleNode;

  // Same hash - no changes
  if (oldNode.hash === newNode.hash) {
    return [];
  }

  // Different hash - recurse into children
  const changed: MerkleLeaf[] = [];

  // Build map of old children by label
  const oldChildMap = new Map<string, MerkleNode | MerkleLeaf>();
  for (const child of oldNode.children) {
    const label = 'label' in child ? child.label : child.chunkId;
    oldChildMap.set(label, child);
  }

  // Compare each new child with old
  for (const newChild of newNode.children) {
    const label = 'label' in newChild ? newChild.label : newChild.chunkId;
    const oldChild = oldChildMap.get(label);
    changed.push(...findChangedLeaves(oldChild || null, newChild));
  }

  return changed;
}

/**
 * Collect all leaf nodes from a tree
 */
function collectAllLeaves(tree: MerkleNode | MerkleLeaf): MerkleLeaf[] {
  if ('chunkId' in tree) {
    return [tree];
  }

  const leaves: MerkleLeaf[] = [];
  for (const child of tree.children) {
    leaves.push(...collectAllLeaves(child));
  }
  return leaves;
}

/**
 * Group array by key function
 */
function groupBy<T>(array: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of array) {
    const key = keyFn(item);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(item);
  }
  return groups;
}
