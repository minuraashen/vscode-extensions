/**
 * Artifact Plugin Interface
 * 
 * Plugins define how to detect and process specific WSO2 MI artifact types.
 * This enables extensibility without modifying core chunking logic.
 */
export interface ArtifactPlugin {
    /** Unique identifier for this artifact type (e.g., "api", "sequence", "endpoint") */
    id: string;

    /** XML root tags that identify this artifact type */
    rootTags: string[];

    /** Tags within this artifact that create semantic chunk boundaries */
    semanticBoundaries: string[];

    /** Optional: mediator-specific tags for this artifact */
    mediatorTags?: string[];

    /** Optional: tags that should remain atomic (not split further) */
    atomicTags?: string[];

    /**
     * Extract metadata from parsed XML
     * @param rootTag The detected root tag name
     * @param attrs Attributes from the root element
     * @param parsed Full parsed XML structure (for complex extraction)
     */
    extractMetadata: (rootTag: string, attrs: Record<string, string>, parsed?: any) => ArtifactMetadata;
}

/**
 * Metadata extracted from an artifact
 */
export interface ArtifactMetadata {
    type: string;
    name: string;
    xmlns?: string;
    additionalInfo?: Record<string, any>;
}

/**
 * Built-in WSO2 MI Artifact Plugins
 * 
 * These cover the standard WSO2 Micro Integrator artifact types.
 * Custom plugins can extend this set for organization-specific artifacts.
 */
const BUILTIN_PLUGINS: ArtifactPlugin[] = [
    // REST API
    {
        id: 'api',
        rootTags: ['api'],
        semanticBoundaries: ['resource', 'inSequence', 'outSequence', 'faultSequence'],
        mediatorTags: [
            'log', 'property', 'variable', 'call', 'send', 'drop',
            'enrich', 'clone', 'iterate', 'aggregate', 'cache',
            'throttle', 'validate', 'xslt', 'script',
            'http.post', 'http.get', 'http.put', 'http.delete', 'http.patch'
        ],
        atomicTags: ['payloadFactory', 'respond', 'log', 'property', 'variable'],
        extractMetadata: (rootTag, attrs) => ({
            type: 'api',
            name: attrs.name || attrs['@_name'] || 'unknown',
            xmlns: attrs.xmlns || attrs['@_xmlns'],
            additionalInfo: {
                context: attrs.context || attrs['@_context']
            }
        })
    },

    // Proxy Service
    {
        id: 'proxy',
        rootTags: ['proxy'],
        semanticBoundaries: ['target', 'inSequence', 'outSequence', 'faultSequence', 'endpoint'],
        mediatorTags: [
            'log', 'property', 'variable', 'call', 'send', 'drop',
            'enrich', 'clone', 'iterate', 'aggregate'
        ],
        atomicTags: ['payloadFactory', 'respond', 'log', 'property'],
        extractMetadata: (rootTag, attrs) => ({
            type: 'proxyService',
            name: attrs.name || attrs['@_name'] || 'unknown',
            xmlns: attrs.xmlns || attrs['@_xmlns'],
            additionalInfo: {
                transports: attrs.transports || attrs['@_transports'] || 'http https'
            }
        })
    },

    // Sequence
    {
        id: 'sequence',
        rootTags: ['sequence'],
        semanticBoundaries: ['filter', 'switch', 'sequence'],
        mediatorTags: [
            'log', 'property', 'variable', 'call', 'send', 'drop',
            'enrich', 'payloadFactory', 'respond'
        ],
        atomicTags: ['payloadFactory', 'respond', 'log', 'property', 'variable'],
        extractMetadata: (rootTag, attrs) => ({
            type: 'sequence',
            name: attrs.name || attrs['@_name'] || 'unknown',
            xmlns: attrs.xmlns || attrs['@_xmlns']
        })
    },

    // Endpoint
    {
        id: 'endpoint',
        rootTags: ['endpoint'],
        semanticBoundaries: ['http', 'address', 'loadbalance', 'failover'],
        atomicTags: ['http', 'address'],
        extractMetadata: (rootTag, attrs) => ({
            type: 'endpoint',
            name: attrs.name || attrs['@_name'] || attrs.key || attrs['@_key'] || 'unknown',
            xmlns: attrs.xmlns || attrs['@_xmlns']
        })
    },

    // Local Entry
    {
        id: 'localEntry',
        rootTags: ['localEntry'],
        semanticBoundaries: [],
        atomicTags: [],
        extractMetadata: (rootTag, attrs) => ({
            type: 'localEntry',
            name: attrs.key || attrs['@_key'] || 'unknown',
            xmlns: attrs.xmlns || attrs['@_xmlns']
        })
    },

    // Template
    {
        id: 'template',
        rootTags: ['template'],
        semanticBoundaries: ['sequence', 'endpoint'],
        mediatorTags: ['log', 'property', 'call', 'send'],
        extractMetadata: (rootTag, attrs) => ({
            type: 'template',
            name: attrs.name || attrs['@_name'] || 'unknown',
            xmlns: attrs.xmlns || attrs['@_xmlns']
        })
    },

    // Message Store
    {
        id: 'messageStore',
        rootTags: ['messageStore'],
        semanticBoundaries: ['parameter'],
        atomicTags: ['parameter'],
        extractMetadata: (rootTag, attrs) => {
            const className = attrs.class || attrs['@_class'] || '';
            let storeType = 'custom';
            if (className.includes('JmsStore')) storeType = 'jms';
            else if (className.includes('JDBCMessageStore')) storeType = 'jdbc';
            else if (className.includes('RabbitMQStore')) storeType = 'rabbitmq';
            else if (className.includes('InMemoryMessageStore')) storeType = 'in-memory';

            return {
                type: 'messageStore',
                name: attrs.name || attrs['@_name'] || 'unknown',
                xmlns: attrs.xmlns || attrs['@_xmlns'],
                additionalInfo: { storeType }
            };
        }
    },

    // Message Processor
    {
        id: 'messageProcessor',
        rootTags: ['messageProcessor'],
        semanticBoundaries: ['parameter'],
        atomicTags: ['parameter'],
        extractMetadata: (rootTag, attrs) => {
            const className = attrs.class || attrs['@_class'] || '';
            let processorType = 'custom';
            if (className.includes('MessageSamplingProcessor')) processorType = 'sampling';
            else if (className.includes('ScheduledMessageForwardingProcessor')) processorType = 'scheduled-forwarding';

            return {
                type: 'messageProcessor',
                name: attrs.name || attrs['@_name'] || 'unknown',
                xmlns: attrs.xmlns || attrs['@_xmlns'],
                additionalInfo: { processorType }
            };
        }
    },

    // Data Service
    {
        id: 'dataService',
        rootTags: ['data'],
        semanticBoundaries: ['config', 'query', 'operation', 'resource'],
        atomicTags: ['sql', 'result', 'param'],
        extractMetadata: (rootTag, attrs) => ({
            type: 'dataService',
            name: attrs.name || attrs['@_name'] || 'unknown',
            xmlns: attrs.xmlns || attrs['@_xmlns'],
            additionalInfo: {
                enableBatchRequests: attrs.enableBatchRequests === 'true' || attrs['@_enableBatchRequests'] === 'true'
            }
        })
    },

    // Data Source
    {
        id: 'dataSource',
        rootTags: ['datasource'],
        semanticBoundaries: ['property'],
        atomicTags: ['property'],
        extractMetadata: (rootTag, attrs) => ({
            type: 'dataSource',
            name: attrs.name || attrs['@_name'] || 'unknown',
            xmlns: attrs.xmlns || attrs['@_xmlns'],
            additionalInfo: {
                className: attrs.class || attrs['@_class']
            }
        })
    },

    // Scheduled Task
    {
        id: 'task',
        rootTags: ['task'],
        semanticBoundaries: ['trigger', 'property'],
        atomicTags: ['property'],
        extractMetadata: (rootTag, attrs) => ({
            type: 'task',
            name: attrs.name || attrs['@_name'] || 'unknown',
            xmlns: attrs.xmlns || attrs['@_xmlns'],
            additionalInfo: {
                group: attrs.group || attrs['@_group']
            }
        })
    },

    // Inbound Endpoint
    {
        id: 'inboundEndpoint',
        rootTags: ['inboundEndpoint'],
        semanticBoundaries: ['parameters'],
        atomicTags: ['parameter'],
        extractMetadata: (rootTag, attrs) => ({
            type: 'inboundEndpoint',
            name: attrs.name || attrs['@_name'] || 'unknown',
            xmlns: attrs.xmlns || attrs['@_xmlns'],
            additionalInfo: {
                protocol: attrs.protocol || attrs['@_protocol'],
                sequence: attrs.sequence || attrs['@_sequence']
            }
        })
    }
];

/**
 * Artifact Registry
 * 
 * Central registry for all artifact plugins. Provides lookup methods
 * for semantic boundaries, mediators, and metadata extraction.
 */
export class ArtifactRegistry {
    private plugins: Map<string, ArtifactPlugin> = new Map();
    private rootTagToPlugin: Map<string, ArtifactPlugin> = new Map();
    private allSemanticBoundaries: Set<string> = new Set();
    private allMediatorTags: Set<string> = new Set();
    private allAtomicTags: Set<string> = new Set();
    private allResourceTypes: Set<string> = new Set();

    constructor() {
        // Register all built-in plugins
        for (const plugin of BUILTIN_PLUGINS) {
            this.registerPlugin(plugin);
        }
    }

    /**
     * Register a new artifact plugin
     */
    registerPlugin(plugin: ArtifactPlugin): void {
        this.plugins.set(plugin.id, plugin);

        // Index root tags for quick lookup
        for (const tag of plugin.rootTags) {
            this.rootTagToPlugin.set(tag, plugin);
            this.allResourceTypes.add(tag);
        }

        // Aggregate semantic boundaries
        for (const boundary of plugin.semanticBoundaries) {
            this.allSemanticBoundaries.add(boundary);
        }

        // Aggregate mediator tags
        if (plugin.mediatorTags) {
            for (const tag of plugin.mediatorTags) {
                this.allMediatorTags.add(tag);
            }
        }

        // Aggregate atomic tags
        if (plugin.atomicTags) {
            for (const tag of plugin.atomicTags) {
                this.allAtomicTags.add(tag);
            }
        }
    }

    /**
     * Check if a tag represents a semantic boundary
     */
    isSemanticBoundary(tagName: string): boolean {
        return this.allSemanticBoundaries.has(tagName);
    }

    /**
     * Check if a tag is a known mediator
     */
    isMediatorTag(tagName: string): boolean {
        return this.allMediatorTags.has(tagName);
    }

    /**
     * Check if a tag is atomic (should not be split further)
     */
    isAtomicTag(tagName: string): boolean {
        return this.allAtomicTags.has(tagName);
    }

    /**
     * Check if a tag is a root resource type
     */
    isResourceType(tagName: string): boolean {
        return this.allResourceTypes.has(tagName);
    }

    /**
     * Get plugin for a given root tag
     */
    getPluginForRootTag(tagName: string): ArtifactPlugin | undefined {
        return this.rootTagToPlugin.get(tagName);
    }

    /**
     * Detect artifact type from parsed XML
     * Returns the plugin and extracted metadata
     */
    detectArtifactType(parsed: any): { plugin: ArtifactPlugin; metadata: ArtifactMetadata } | null {
        if (!Array.isArray(parsed)) return null;

        for (const item of parsed) {
            const tagName = Object.keys(item).find(key => key !== ':@');
            if (!tagName) continue;

            const plugin = this.rootTagToPlugin.get(tagName);
            if (plugin) {
                const attrs = item[':@'] || {};
                const metadata = plugin.extractMetadata(tagName, attrs, parsed);
                return { plugin, metadata };
            }
        }

        return null;
    }

    /**
     * Detect ANY artifact from parsed XML (including unregistered custom types)
     * This is the fallback when detectArtifactType returns null
     * Extracts metadata from the first non-processing-instruction root element
     * Uses filePath to infer WSO2 MI artifact type from folder structure
     */
    detectAnyArtifact(parsed: any, filePath?: string): ArtifactMetadata | null {
        if (!Array.isArray(parsed)) return null;

        for (const item of parsed) {
            const tagName = Object.keys(item).find(key => key !== ':@');
            if (!tagName || tagName === '?xml') continue; // Skip processing instructions

            const attrs = item[':@'] || {};
            
            // Extract name from common attribute patterns
            const name = attrs.key || attrs['@_key'] || 
                        attrs.name || attrs['@_name'] || 
                        attrs.id || attrs['@_id'] ||
                        attrs.context || attrs['@_context'] || 
                        tagName;

            // Infer artifact type from folder structure if filePath provided
            let inferredType = tagName; // Default to tag name
            if (filePath) {
                if (filePath.includes('/data-sources/')) inferredType = 'dataSource';
                else if (filePath.includes('/apis/')) inferredType = 'api';
                else if (filePath.includes('/proxy-services/')) inferredType = 'proxyService';
                else if (filePath.includes('/sequences/')) inferredType = 'sequence';
                else if (filePath.includes('/endpoints/')) inferredType = 'endpoint';
                else if (filePath.includes('/local-entries/')) inferredType = 'localEntry';
                else if (filePath.includes('/templates/')) inferredType = 'template';
                else if (filePath.includes('/data-services/')) inferredType = 'dataService';
                else if (filePath.includes('/tasks/')) inferredType = 'task';
                else if (filePath.includes('/message-stores/')) inferredType = 'messageStore';
                else if (filePath.includes('/message-processors/')) inferredType = 'messageProcessor';
                else if (filePath.includes('/inbound-endpoints/')) inferredType = 'inboundEndpoint';
            }

            return {
                type: inferredType,
                name: name,
                xmlns: attrs.xmlns || attrs['@_xmlns'],
                additionalInfo: {
                    isCustom: true,
                    rootTag: tagName,
                    inferredFromPath: inferredType !== tagName
                }
            };
        }

        return null;
    }
    /**
     * Get all registered plugins
     */
    getAllPlugins(): ArtifactPlugin[] {
        return Array.from(this.plugins.values());
    }
}

// Export singleton instance for use across modules
export const artifactRegistry = new ArtifactRegistry();
