import { createHmac, timingSafeEqual } from 'crypto';

/** How far the X-Synapsai-Timestamp may be from this clock, in seconds (SPEC-842 B). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface SignatureInput {
	secret: string;
	timestamp: string | undefined;
	webhookId: string | undefined;
	signature: string | undefined;
	/** The exact bytes received, never a re-serialised object. */
	rawBody: Buffer;
	nowSeconds?: number;
	toleranceSeconds?: number;
}

/**
 * Checks a SynapsAI webhook: `sha256=hex(HMAC-SHA256(secret, timestamp + "." + webhookId + "." + rawBody))`, compared in
 * constant time, with a timestamp at most five minutes from this clock. Any missing part is a refusal.
 */
export function verifySynapsaiSignature(input: SignatureInput): boolean {
	const { secret, timestamp, webhookId, signature, rawBody } = input;
	if (!secret || !timestamp || !webhookId || !signature) return false;
	if (!/^\d{1,12}$/.test(timestamp)) return false;
	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
	if (Math.abs(now - Number(timestamp)) > tolerance) return false;
	const expected =
		'sha256=' +
		createHmac('sha256', secret).update(`${timestamp}.${webhookId}.`).update(rawBody).digest('hex');
	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(signature, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Lower-cased single header value; a repeated header is a refusal (returns undefined). */
export function headerValue(
	headers: Record<string, string | string[] | undefined>,
	name: string,
): string | undefined {
	const value = headers[name.toLowerCase()];
	return typeof value === 'string' ? value : undefined;
}

/** The raw body n8n keeps on the request; undefined when it is not available (then the request is refused). */
export function rawBodyOf(request: unknown): Buffer | undefined {
	const raw = (request as { rawBody?: unknown } | undefined)?.rawBody;
	if (Buffer.isBuffer(raw)) return raw;
	if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
	return undefined;
}
