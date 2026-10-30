import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

export const CREDENTIAL_NAME = 'synapsAiApi';
export const SYNAPSAI_BASE_URL = 'https://connect.synapsai.app';

/**
 * SynapsAI answers 503 (`UPSTREAM_UNAVAILABLE`, `AUTH_UNAVAILABLE`, …) when it could not complete a call. Only an
 * idempotent request is retried: a GET, or `POST /v1/agents/{agentKey}/messages` or `/campaigns` (always sent with an idempotency key).
 * A contact upsert or a hook create/delete may have committed before the 503, so it is never retried here.
 */
export const RETRYABLE_STATUS = 503;

const MESSAGE_POST = /^\/v1\/agents\/[^/]+\/messages$/;
/** A campaign send is always sent with an `Idempotency-Key`, so a replay returns the same campaign (SPEC-848). */
const CAMPAIGN_POST = /^\/v1\/agents\/[^/]+\/campaigns$/;

/** True when repeating the request cannot apply it twice. */
export function isIdempotent(method: IHttpRequestMethods, path: string): boolean {
	return (
		method === 'GET' || (method === 'POST' && (MESSAGE_POST.test(path) || CAMPAIGN_POST.test(path)))
	);
}
/** Attempts in total for a 503, and the wait before each retry (ms). */
export const RETRY_DELAYS_MS = [1000, 3000];

/** The page size of every SynapsAI list (`ApiPaths.MAX_PAGE_SIZE`). */
export const MAX_PAGE_SIZE = 100;

type Context = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions;

/** A 429 answers `Retry-After` in seconds; a wait longer than this fails instead of blocking the execution. */
export const MAX_RETRY_AFTER_MS = 60_000;
export const RATE_LIMITED_STATUS = 429;

export interface RequestOptions {
	/** Delays between attempts on a 503; tests pass [] or [0]. */
	retryDelaysMs?: number[];
	/** Upper bound of a 429 `Retry-After` wait; tests pass a small one. */
	maxRetryAfterMs?: number;
	/** Extra request headers, e.g. the `Idempotency-Key` of a campaign send. */
	headers?: Record<string, string>;
}

/** The `Retry-After` of a 429 in ms (seconds form only); undefined when absent or unreadable. */
export function retryAfterMs(error: unknown): number | undefined {
	const e = error as {
		response?: { headers?: Record<string, unknown> };
		cause?: { response?: { headers?: Record<string, unknown> } };
	};
	const headers = e?.response?.headers ?? e?.cause?.response?.headers ?? {};
	const raw = headers['retry-after'] ?? headers['Retry-After'];
	const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Encodes one path segment; an empty value is rejected so a request never reaches a different route. */
export function segment(value: string, label: string): string {
	const trimmed = String(value ?? '').trim();
	if (!trimmed) throw new Error(`${label} is required`);
	if (/^\.+$/.test(trimmed) || /[\x00-\x1f\x7f]/.test(trimmed)) {
		throw new Error(`${label} contains an invalid path segment`);
	}
	return encodeURIComponent(trimmed);
}

/** Drops undefined, null and empty-string values so optional filters are not sent. */
export function compact(values: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined || value === null || value === '') continue;
		out[key] = value;
	}
	return out;
}

/**
 * One authenticated call to connect.synapsai.app. On an idempotent request a 503 is retried after a short delay and a
 * 429 after its `Retry-After` (at most a minute); any other error — and either one on a write — becomes a
 * NodeApiError carrying the SynapsAI `code: message` and the HTTP status.
 */
export async function synapsAiRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
	options: RequestOptions = {},
): Promise<IDataObject | IDataObject[]> {
	const credentials = await this.getCredentials(CREDENTIAL_NAME);
	const request: IHttpRequestOptions = {
		method,
		url: `${SYNAPSAI_BASE_URL}${path}`,
		json: true,
		headers: { Accept: 'application/json', ...options.headers },
	};
	if (body !== undefined) request.body = body;
	if (qs !== undefined && Object.keys(qs).length > 0) request.qs = qs;
	const delays = isIdempotent(method, path) ? (options.retryDelaysMs ?? RETRY_DELAYS_MS) : [];
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await this.helpers.httpRequestWithAuthentication.call(
				this,
				CREDENTIAL_NAME,
				request,
			);
			return (response ?? {}) as IDataObject | IDataObject[];
		} catch (error) {
			const status = statusOf(error);
			if (status === RETRYABLE_STATUS && attempt < delays.length) {
				await sleep(delays[attempt]);
				continue;
			}
			if (status === RATE_LIMITED_STATUS && attempt < delays.length) {
				const wait = retryAfterMs(error) ?? delays[attempt];
				if (wait <= (options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS)) {
					await sleep(wait);
					continue;
				}
			}
			const message = synapsAiErrorMessage(error);
			throw new NodeApiError(this.getNode(), error as JsonObject, {
				message:
					status === RETRYABLE_STATUS
						? delays.length > 0
							? `${message} — SynapsAI is temporarily unavailable; retried ${attempt} time(s). Run again later.`
							: `${message} — SynapsAI is temporarily unavailable. This write may have been applied: check before running it again.`
						: message,
				httpCode: status === undefined ? undefined : String(status),
			});
		}
	}
}

/** The HTTP status of a failed request, wherever n8n's helper put it. */
export function statusOf(error: unknown): number | undefined {
	const e = error as {
		httpCode?: string | number;
		statusCode?: number;
		status?: number;
		response?: { status?: number; statusCode?: number };
		cause?: { response?: { status?: number; statusCode?: number } };
	};
	const raw =
		e?.response?.status ??
		e?.response?.statusCode ??
		e?.cause?.response?.status ??
		e?.cause?.response?.statusCode ??
		e?.statusCode ??
		e?.status ??
		e?.httpCode;
	const status = Number(raw);
	return Number.isInteger(status) && status > 0 ? status : undefined;
}

/** The SynapsAI error code and message, when the response carries them. */
export function synapsAiErrorMessage(error: unknown): string {
	const candidate = error as {
		response?: { body?: unknown; data?: unknown };
		cause?: { response?: { body?: unknown; data?: unknown } };
		message?: string;
	};
	const body =
		candidate?.response?.body ??
		candidate?.response?.data ??
		candidate?.cause?.response?.body ??
		candidate?.cause?.response?.data;
	const parsed = typeof body === 'string' ? safeJson(body) : body;
	if (parsed && typeof parsed === 'object') {
		const { code, message } = parsed as { code?: unknown; message?: unknown };
		if (typeof code === 'string') {
			return typeof message === 'string' ? `${code}: ${message}` : code;
		}
	}
	return candidate?.message ?? 'SynapsAI request failed';
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** An object response, or a NodeOperationError naming the endpoint that answered something else. */
export function asObject(
	this: Context,
	response: IDataObject | IDataObject[],
	what: string,
): IDataObject {
	if (Array.isArray(response) || typeof response !== 'object' || response === null) {
		throw new NodeOperationError(
			this.getNode(),
			`Unexpected response from ${what}: expected an object`,
		);
	}
	return response;
}

/**
 * A numbered page — `{items, page, size, total}` — the one list shape of `GET /v1/conversations`, `GET /v1/contacts`,
 * `GET /v1/agents` and `GET /v1/agents/{agentKey}/hooks` (the last two answer everything in one page).
 */
export interface NumberedPage {
	items: IDataObject[];
	total: number;
}

export function numberedPage(
	this: Context,
	response: IDataObject | IDataObject[],
	what: string,
): NumberedPage {
	const page = asObject.call(this, response, what);
	if (!Array.isArray(page.items) || typeof page.total !== 'number') {
		throw new NodeOperationError(
			this.getNode(),
			`Unexpected response from ${what}: expected {items, page, size, total}`,
		);
	}
	return { items: page.items as IDataObject[], total: page.total };
}

/** A page of `GET /v1/leads`: `{items, nextCursor, total, deliveryIssues}`. */
export interface CursorPage {
	items: IDataObject[];
	nextCursor: string | null;
}

export function cursorPage(
	this: Context,
	response: IDataObject | IDataObject[],
	what: string,
): CursorPage {
	const page = asObject.call(this, response, what);
	if (!Array.isArray(page.items)) {
		throw new NodeOperationError(
			this.getNode(),
			`Unexpected response from ${what}: expected {items, nextCursor}`,
		);
	}
	const next = page.nextCursor;
	return {
		items: page.items as IDataObject[],
		nextCursor: typeof next === 'string' && next !== '' ? next : null,
	};
}

/**
 * Reads `GET /v1/conversations` page by page — the page number is counted here, never read back — until `limit`
 * items (unless `returnAll`), an empty or short page, or `total`.
 */
export async function collectNumbered(
	this: Context,
	path: string,
	qs: IDataObject,
	returnAll: boolean,
	limit: number,
	options: RequestOptions = {},
): Promise<IDataObject[]> {
	const out: IDataObject[] = [];
	const size = returnAll ? MAX_PAGE_SIZE : Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
	for (let page = 0; ; page++) {
		const response = await synapsAiRequest.call(
			this,
			'GET',
			path,
			undefined,
			{ ...qs, page, size },
			options,
		);
		const { items, total } = numberedPage.call(this, response, `GET ${path}`);
		out.push(...items);
		if (!returnAll && out.length >= limit) return out.slice(0, limit);
		if (items.length < size || (page + 1) * size >= total) return out;
	}
}

/** Reads `GET /v1/leads` by cursor until `limit` items (unless `returnAll`) or the last page. */
export async function collectCursor(
	this: Context,
	path: string,
	qs: IDataObject,
	returnAll: boolean,
	limit: number,
	options: RequestOptions = {},
): Promise<IDataObject[]> {
	const out: IDataObject[] = [];
	let cursor: string | null = null;
	const pageLimit = returnAll ? MAX_PAGE_SIZE : Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
	do {
		const pageQs: IDataObject = { ...qs, limit: pageLimit };
		if (cursor) pageQs.cursor = cursor;
		const response = await synapsAiRequest.call(this, 'GET', path, undefined, pageQs, options);
		const page = cursorPage.call(this, response, `GET ${path}`);
		out.push(...page.items);
		if (!returnAll && out.length >= limit) return out.slice(0, limit);
		cursor = page.nextCursor;
	} while (cursor);
	return out;
}

/** Agent picker shared by both nodes: GET /v1/agents (scope agents:read) — a page whose items are `{key, title, …}`. */
export async function loadAgents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const { items: agents } = numberedPage.call(
		this,
		await synapsAiRequest.call(this, 'GET', '/v1/agents'),
		'GET /v1/agents',
	);
	return agents
		.map((agent) => {
			const key = String(agent.key ?? '');
			const title = String(agent.title ?? '').trim();
			return { name: title && title !== key ? `${title} (${key})` : key, value: key };
		})
		.filter((option) => option.value !== '')
		.sort((a, b) => a.name.localeCompare(b.name));
}
