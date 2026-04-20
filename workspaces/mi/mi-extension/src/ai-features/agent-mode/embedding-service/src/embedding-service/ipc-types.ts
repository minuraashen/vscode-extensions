export type IpcProtocolVersion = '1.0';

export const IPC_PROTOCOL_VERSION: IpcProtocolVersion = '1.0';

export type IpcRequestMethod =
	| 'init'
	| 'health'
	| 'index.initial'
	| 'index.incremental'
	| 'notify.fileChange'
	| 'search.semantic'
	| 'shutdown'
	| 'status.get';

export type IpcEventMethod =
	| 'status.changed'
	| 'index.progress'
	| 'worker.log';

export type IpcErrorCode =
	| 'TIMEOUT'
	| 'INVALID_PAYLOAD'
	| 'MODEL_NOT_READY'
	| 'DB_ERROR'
	| 'INDEX_ERROR'
	| 'WORKER_NOT_READY'
	| 'INTERNAL';

export interface IpcMessageBase {
	v: IpcProtocolVersion;
	id: string;
	ts: number;
}

export interface IpcRequestMessage<TPayload = unknown> extends IpcMessageBase {
	type: 'request';
	method: IpcRequestMethod;
	payload: TPayload;
}

export interface IpcErrorShape {
	code: IpcErrorCode;
	message: string;
	retryable: boolean;
	details?: Record<string, unknown>;
}

export interface IpcResponseMessage<TResult = unknown> extends IpcMessageBase {
	type: 'response';
	method: IpcRequestMethod;
	ok: boolean;
	payload?: TResult;
	error?: IpcErrorShape;
}

export interface IpcEventMessage<TPayload = unknown> extends IpcMessageBase {
	type: 'event';
	method: IpcEventMethod;
	payload: TPayload;
}

export type IpcInboundMessage = IpcRequestMessage;
export type IpcOutboundMessage = IpcResponseMessage | IpcEventMessage;

export interface InitRequestPayload {
	projectPath: string;
	artifactsSubPath: string;
	dbPath: string;
	modelRootPath: string;
	pollIntervalMs: number;
	maxTokens: number;
	nativeRuntime?: {
		enabled?: boolean;
		runtimeDir?: string;
		manifestUrl?: string;
		bundleUrl?: string;
		bundleSha256?: string;
	};
}

export interface HealthRequestPayload {
	ping?: true;
}

export interface IndexInitialRequestPayload {
	directories: string[];
}

export interface IndexIncrementalRequestPayload {
	directories?: string[];
	changedFiles?: string[];
}

export interface NotifyFileChangeRequestPayload {
	filePath: string;
}

export interface SemanticSearchRequestPayload {
	query: string;
	topK: number;
	scoreThreshold: number;
}

export interface ShutdownRequestPayload {
	reason?: string;
}

export interface WorkerStatusPayload {
	available: boolean;
	initializing: boolean;
	chunkCount: number;
	projectPath?: string;
	reason?: string;
}

export interface SemanticSearchHit {
	id: number;
	filePath: string;
	chunkType: string;
	startLine: number;
	endLine: number;
	context: Record<string, unknown>;
	score: number;
}

export interface SemanticSearchResponsePayload {
	query: string;
	latencyMs: number;
	totalChunksScanned: number;
	hits: SemanticSearchHit[];
}

export interface IndexProgressEventPayload {
	stage: 'scanning' | 'embedding' | 'updating' | 'complete';
	detail: string;
	fileIndex: number;
	totalFiles: number;
}

export interface WorkerLogEventPayload {
	level: 'debug' | 'info' | 'warn' | 'error';
	message: string;
}

export function createIpcMessageBase(id: string): IpcMessageBase {
	return {
		v: IPC_PROTOCOL_VERSION,
		id,
		ts: Date.now(),
	};
}
