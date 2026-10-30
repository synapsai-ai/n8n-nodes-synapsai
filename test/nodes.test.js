'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NodeApiError } = require('n8n-workflow');

const { verifySynapsaiSignature } = require('../dist/nodes/shared/signature');
const { SynapsAi, replyItem } = require('../dist/nodes/SynapsAi/SynapsAi.node');
const { SynapsAiTool } = require('../dist/nodes/SynapsAiTool/SynapsAiTool.node');
const {
	SynapsAiTrigger,
	TRIGGER_EVENTS,
	rememberWebhookId,
} = require('../dist/nodes/SynapsAiTrigger/SynapsAiTrigger.node');
const { SynapsAiApi } = require('../dist/credentials/SynapsAiApi.credentials');
const pkg = require('../package.json');
const {
	CREDENTIALS,
	sign,
	executeContext,
	webhookContext,
	hookContext,
	httpError,
	loadOptionsContext,
} = require('./helpers');
const transport = require('../dist/nodes/shared/transport');

const NOW = Math.floor(Date.now() / 1000);

test('package: zero runtime dependencies, community keyword, both nodes and the credential registered', () => {
	assert.equal(pkg.dependencies, undefined);
	assert.ok(pkg.keywords.includes('n8n-community-node-package'));
	assert.equal(pkg.license, 'MIT');
	assert.deepEqual(pkg.n8n.credentials, ['dist/credentials/SynapsAiApi.credentials.js']);
	assert.equal(pkg.n8n.nodes.length, 3);
});

test('read-only AI Agent tool exposes only the approved read operations', () => {
	const description = new SynapsAiTool().description;
	assert.equal(description.usableAsTool, true);
	const operations = description.properties
		.filter((property) => property.name === 'operation')
		.flatMap((property) => property.options.map((option) => option.value));
	assert.deepEqual(operations.sort(), ['get', 'get', 'get', 'getAll', 'getAll', 'getAll', 'getAll', 'getDeliveries'].sort());
	assert.ok(!operations.some((operation) => ['ask', 'send', 'cancel', 'upsert'].includes(operation)));
});

test('signature: the SynapsAI docs test vector', () => {
	const body = Buffer.from('{"id":"evt_0123456789abcdef","type":"conversation.ended"}');
	assert.equal(
		sign('whsec_test_7f3a9c', 1761220800, 'evt_0123456789abcdef', body),
		'sha256=8e78712ba57db2cc8d77c2e38c6537b496f24b2952e859afb8ddc2043979f032',
	);
	assert.equal(
		verifySynapsaiSignature({
			secret: 'whsec_test_7f3a9c',
			timestamp: '1761220800',
			webhookId: 'evt_0123456789abcdef',
			signature: 'sha256=8e78712ba57db2cc8d77c2e38c6537b496f24b2952e859afb8ddc2043979f032',
			rawBody: body,
			nowSeconds: 1761220800,
		}),
		true,
	);
});

test('path segments reject dot traversal and ASCII control characters before requests', async () => {
	for (const value of ['.', '..', 'x\u0000y', 'x\u007fy']) {
		assert.throws(() => transport.segment(value, 'ID'), /invalid path segment/);
	}
	const ctx = executeContext({ params: { resource: 'conversation', operation: 'get', conversationId: '..' } });
	await assert.rejects(new SynapsAi().execute.call(ctx), /invalid path segment/);
	assert.equal(ctx.http.calls.length, 0);
});

test('signature: refuses a changed byte, another secret, a stale or future timestamp and any missing part', () => {
	const body = Buffer.from('{"type":"message.replied"}');
	const base = {
		secret: 's1',
		timestamp: String(NOW),
		webhookId: 'd1',
		rawBody: body,
		nowSeconds: NOW,
	};
	const good = sign('s1', NOW, 'd1', body);
	assert.equal(verifySynapsaiSignature({ ...base, signature: good }), true);
	assert.equal(
		verifySynapsaiSignature({ ...base, signature: good, rawBody: Buffer.from('{"type":"x"}') }),
		false,
	);
	assert.equal(verifySynapsaiSignature({ ...base, signature: good, secret: 's2' }), false);
	assert.equal(verifySynapsaiSignature({ ...base, signature: good, nowSeconds: NOW + 301 }), false);
	assert.equal(verifySynapsaiSignature({ ...base, signature: good, nowSeconds: NOW - 301 }), false);
	assert.equal(verifySynapsaiSignature({ ...base, signature: good, nowSeconds: NOW + 300 }), true);
	assert.equal(verifySynapsaiSignature({ ...base, signature: undefined }), false);
	assert.equal(verifySynapsaiSignature({ ...base, signature: good, secret: '' }), false);
	assert.equal(verifySynapsaiSignature({ ...base, signature: good, webhookId: undefined }), false);
	assert.equal(verifySynapsaiSignature({ ...base, signature: good, timestamp: '1e3' }), false);
	assert.equal(verifySynapsaiSignature({ ...base, signature: 'sha256=00' }), false);
});

test('trigger replay cache is bounded to 500 ids and expires entries after ten minutes', () => {
	const state = {};
	assert.equal(rememberWebhookId(state, 'same', 0), true);
	assert.equal(rememberWebhookId(state, 'same', 1), false);
	for (let i = 0; i < 501; i++) rememberWebhookId(state, `id-${i}`, 2);
	assert.ok(Object.keys(state.seenWebhookIds).length <= 500);
	assert.equal(rememberWebhookId(state, 'same', 10 * 60_000), true);
});

test('credential: bearer header and the /v1/me test request', () => {
	const credential = new SynapsAiApi();
	assert.equal(credential.name, 'synapsAiApi');
	assert.equal(
		credential.authenticate.properties.headers.Authorization,
		'=Bearer {{$credentials.apiKey}}',
	);
	assert.equal(credential.test.request.url, '/v1/me');
	const byStatus = Object.fromEntries(
		credential.test.rules.map((r) => [r.properties.value, r.properties.message]),
	);
	assert.match(byStatus[403], /^PLAN_FEATURE_UNAVAILABLE: .*GROWTH/);
	assert.match(byStatus[401], /^INVALID_KEY/);
	assert.match(byStatus[503], /temporarily unavailable/);
	assert.equal(credential.properties.some((p) => p.name === 'baseUrl'), false);
	assert.equal(credential.test.request.baseURL, 'https://connect.synapsai.app');
});

test('Ask (no wait): one POST to /v1/agents/{agentKey}/messages with the documented body', async () => {
	const ctx = executeContext({
		params: {
			resource: 'agent',
			operation: 'ask',
			agentKey: 'shop bot',
			externalUserId: 'crm-123',
			text: 'Olá, tem em estoque?',
			waitForReply: false,
			options: {
				name: 'Ana',
				metadata: '{"dealId":"D-9"}',
				idempotencyKey: 'k1',
				callbackUrl: 'https://hooks.example.com/r',
			},
		},
		responder: () => ({ messageId: 'msg_abc', status: 'QUEUED' }),
	});
	const [out] = await new SynapsAi().execute.call(ctx);
	assert.deepEqual(out[0].json, { messageId: 'msg_abc', status: 'QUEUED' });
	assert.equal(ctx.http.calls.length, 1);
	const { credentialName, options } = ctx.http.calls[0];
	assert.equal(credentialName, 'synapsAiApi');
	assert.equal(options.method, 'POST');
	assert.equal(options.url, 'https://connect.synapsai.app/v1/agents/shop%20bot/messages');
	assert.deepEqual(options.body, {
		externalUserId: 'crm-123',
		text: 'Olá, tem em estoque?',
		contact: { name: 'Ana' },
		metadata: { dealId: 'D-9' },
		idempotencyKey: 'k1',
		callbackUrl: 'https://hooks.example.com/r',
	});
	assert.equal(ctx.state.waitTill, undefined);
});

test('Ask: default idempotency key survives a new execution id for identical input', async () => {
	const ctx = executeContext({
		params: {
			resource: 'agent',
			operation: 'ask',
			agentKey: 'k',
			externalUserId: 'u',
			text: 'hi',
			waitForReply: false,
			options: {},
		},
		responder: () => ({ messageId: 'msg_a', status: 'QUEUED' }),
	});
	await new SynapsAi().execute.call(ctx);
	const first = ctx.http.calls[0].options.body.idempotencyKey;
	ctx.getExecutionId = () => 'manual-retry-exec-99';
	const retry = executeContext({
		params: { resource: 'agent', operation: 'ask', agentKey: 'k', externalUserId: 'u', text: 'hi', waitForReply: false, options: {} },
	});
	await new SynapsAi().execute.call(retry);
	assert.equal(retry.http.calls[0].options.body.idempotencyKey, first);
	assert.match(first, /^n8n-[a-f0-9]{40}$/);
});

test('default idempotency keys vary by workflow and campaign recipient list', async () => {
	const first = executeContext({ params: campaignParams() });
	await new SynapsAi().execute.call(first);
	const second = executeContext({ params: campaignParams({ recipients: ['c3'] }) });
	await new SynapsAi().execute.call(second);
	assert.notEqual(first.http.calls[0].options.headers['Idempotency-Key'], second.http.calls[0].options.headers['Idempotency-Key']);
	const otherWorkflow = executeContext({ params: campaignParams() });
	otherWorkflow.getWorkflow = () => ({ id: 'wf-other' });
	await new SynapsAi().execute.call(otherWorkflow);
	assert.notEqual(first.http.calls[0].options.headers['Idempotency-Key'], otherWorkflow.http.calls[0].options.headers['Idempotency-Key']);
});

test('transport ignores a legacy credential Base URL and always sends to SynapsAI', async () => {
	const ctx = executeContext({
		params: { resource: 'conversation', operation: 'getAll' },
		credentials: { ...CREDENTIALS, baseUrl: 'http://evil.example' },
		responder: () => ({ items: [], page: 0, size: 50, total: 0 }),
	});
	await new SynapsAi().execute.call(ctx);
	assert.match(ctx.http.calls[0].options.url, /^https:\/\/connect\.synapsai\.app\//);
	assert.doesNotMatch(ctx.http.calls[0].options.url, /evil\.example/);
});

test('Ask (wait): the signed resume URL is the callbackUrl and the execution waits', async () => {
	const ctx = executeContext({
		params: {
			resource: 'agent',
			operation: 'ask',
			agentKey: 'k',
			externalUserId: 'u',
			text: 'hi',
			waitForReply: true,
			waitMinutes: 3,
			options: { callbackUrl: 'https://ignored.example.com' },
		},
		responder: () => ({ messageId: 'msg_w', status: 'QUEUED' }),
	});
	const before = Date.now();
	await new SynapsAi().execute.call(ctx);
	assert.equal(ctx.http.calls[0].options.body.callbackUrl, ctx.state.resumeUrl);
	const waitMs = ctx.state.waitTill.getTime() - before;
	assert.ok(waitMs >= 3 * 60_000 - 50 && waitMs <= 3 * 60_000 + 5_000, `waited ${waitMs}`);
});

test('Ask (wait): refused without the agent signing secret, and for more than one item', async () => {
	const params = {
		resource: 'agent',
		operation: 'ask',
		agentKey: 'k',
		externalUserId: 'u',
		text: 'hi',
		waitForReply: true,
	};
	const noSecret = executeContext({ params, credentials: { ...CREDENTIALS, signingSecret: '' } });
	await assert.rejects(new SynapsAi().execute.call(noSecret), /Signing Secret/);
	assert.equal(noSecret.http.calls.length, 0);
	const twoItems = executeContext({ params, items: [{ json: {} }, { json: {} }] });
	await assert.rejects(new SynapsAi().execute.call(twoItems), /one item per execution/);
	assert.equal(twoItems.http.calls.length, 0);
});

test('Ask: metadata that is not a JSON object is refused before any request', async () => {
	const ctx = executeContext({
		params: {
			resource: 'agent',
			operation: 'ask',
			agentKey: 'k',
			externalUserId: 'u',
			text: 'hi',
			waitForReply: false,
			options: { metadata: '[1,2]' },
		},
	});
	await assert.rejects(new SynapsAi().execute.call(ctx), /JSON object/);
	assert.equal(ctx.http.calls.length, 0);
});

test('resume webhook: a signed message.replied resumes with the flattened reply', async () => {
	const body = {
		id: 'evt_00000000000000000000000000000001',
		type: 'message.replied',
		conversation: { id: 'c1', channel: 'API' },
		message: {
			id: 'msg_w',
			text: 'Sim, temos!',
			components: [{ type: 'buttons' }],
			metadata: { dealId: 'D-9', _n8n: 'nonce-1' },
		},
	};
	const raw = Buffer.from(JSON.stringify(body));
	const ctx = webhookContext({
		body,
		rawBody: raw,
		staticData: { waitingMessageId: 'msg_request', waitingNonce: 'nonce-1' },
		headers: {
			'x-synapsai-timestamp': String(NOW),
			'x-synapsai-webhook-id': 'evt_00000000000000000000000000000001',
			'x-synapsai-signature': sign(
				CREDENTIALS.signingSecret,
				NOW,
				'evt_00000000000000000000000000000001',
				raw,
			),
		},
	});
	const result = await new SynapsAi().webhook.call(ctx);
	const item = result.workflowData[0][0].json;
	assert.equal(item.status, 'REPLIED');
	assert.equal(item.text, 'Sim, temos!');
	assert.equal(item.messageId, 'msg_w');
	assert.equal(item.conversationId, 'c1');
	assert.deepEqual(item.metadata, { dealId: 'D-9', _n8n: 'nonce-1' });
});

test('resume webhook rejects a validly signed reply with a different wait nonce', async () => {
	const body = { type: 'message.replied', message: { id: 'reply', metadata: { _n8n: 'wrong' } } };
	const raw = Buffer.from(JSON.stringify(body));
	const id = 'evt_reply_mismatch';
	const ctx = webhookContext({
		body,
		rawBody: raw,
		staticData: { waitingMessageId: 'msg_expected', waitingNonce: 'expected' },
		headers: {
			'x-synapsai-timestamp': String(NOW),
			'x-synapsai-webhook-id': id,
			'x-synapsai-signature': sign(CREDENTIALS.signingSecret, NOW, id, raw),
		},
	});
	const result = await new SynapsAi().webhook.call(ctx);
	assert.equal(ctx.res.statusCode, 401);
	assert.equal(result.workflowData, undefined);
});

test('resume webhook: a forged signature answers 401 and does not resume', async () => {
	const body = { type: 'message.replied', message: {} };
	const raw = Buffer.from(JSON.stringify(body));
	const ctx = webhookContext({
		body,
		rawBody: raw,
		headers: {
			'x-synapsai-timestamp': String(NOW),
			'x-synapsai-webhook-id': 'evt_00000000000000000000000000000001',
			'x-synapsai-signature': sign(
				'another-secret',
				NOW,
				'evt_00000000000000000000000000000001',
				raw,
			),
		},
	});
	const result = await new SynapsAi().webhook.call(ctx);
	assert.equal(ctx.res.statusCode, 401);
	assert.equal(result.noWebhookResponse, true);
	assert.equal(result.workflowData, undefined);
});

test('resume webhook: no raw body means no verification, so it is refused', async () => {
	const ctx = webhookContext({
		body: { type: 'message.replied' },
		rawBody: undefined,
		headers: {},
	});
	const result = await new SynapsAi().webhook.call(ctx);
	assert.equal(ctx.res.statusCode, 401);
	assert.equal(result.workflowData, undefined);
});

test('replyItem: message.failed carries the error code', () => {
	const item = replyItem({
		type: 'message.failed',
		message: { id: 'm' },
		error: { code: 'INSUFFICIENT_CREDITS' },
	});
	assert.equal(item.status, 'FAILED');
	assert.equal(item.errorCode, 'INSUFFICIENT_CREDITS');
});

test('List conversations: filters reach the query string; pages are counted here, not read back', async () => {
	const pages = [];
	const ctx = executeContext({
		params: {
			resource: 'conversation',
			operation: 'getAll',
			filters: { csatMin: 1, csatMax: 2, agentKey: '', origin: 'API' },
			returnAll: true,
		},
		responder: (options) => {
			pages.push(options.qs.page);
			const rows = options.qs.page < 2 ? 100 : 30;
			// The echoed page is wrong on purpose (always 0): the node must not depend on it.
			return {
				items: Array.from({ length: rows }, (_, n) => ({ chatId: `c${options.qs.page}-${n}` })),
				page: 0,
				size: 100,
				total: 230,
			};
		},
	});
	const [out] = await new SynapsAi().execute.call(ctx);
	assert.equal(out.length, 230);
	assert.deepEqual(pages, [0, 1, 2]);
	assert.deepEqual(ctx.http.calls[0].options.qs, {
		csatMin: 1,
		csatMax: 2,
		origin: 'API',
		page: 0,
		size: 100,
	});
	assert.equal(ctx.http.calls[0].options.url, 'https://connect.synapsai.app/v1/conversations');
});

test('List conversations: a limit asks for one page of that size and stops', async () => {
	const ctx = executeContext({
		params: {
			resource: 'conversation',
			operation: 'getAll',
			filters: {},
			returnAll: false,
			limit: 7,
		},
		responder: () => ({
			items: Array.from({ length: 7 }, (_, n) => ({ chatId: `c${n}` })),
			page: 0,
			size: 7,
			total: 500,
		}),
	});
	const [out] = await new SynapsAi().execute.call(ctx);
	assert.equal(out.length, 7);
	assert.equal(ctx.http.calls.length, 1);
	assert.deepEqual(ctx.http.calls[0].options.qs, { page: 0, size: 7 });
});

test('List conversations: a bare array (not the documented page) is an error, not silently accepted', async () => {
	const ctx = executeContext({
		params: {
			resource: 'conversation',
			operation: 'getAll',
			filters: {},
			returnAll: false,
			limit: 5,
		},
		responder: () => [{ chatId: 'c1' }],
	});
	await assert.rejects(
		new SynapsAi().execute.call(ctx),
		/expected an object|expected \{items, page, size, total\}/,
	);
});

test('NodeApiError rethrow preserves the failing input item index', async () => {
	let calls = 0;
	const ctx = executeContext({
		params: { resource: 'conversation', operation: 'get', conversationId: 'c1' },
		items: [{ json: { i: 0 } }, { json: { i: 1 } }],
		responder: () => {
			calls++;
			if (calls === 2) throw httpError(409, { code: 'CONFLICT', message: 'conflict' });
			return { id: 'c1' };
		},
	});
	await assert.rejects(new SynapsAi().execute.call(ctx), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.context.itemIndex, 1);
		return true;
	});
});

test('Upsert contact: POST /v1/contacts:upsert with mode; refused with nothing to match on', async () => {
	const ctx = executeContext({
		params: {
			resource: 'contact',
			operation: 'upsert',
			contact: { phone: '+5071234567', name: 'Ana' },
			mode: 'overwrite',
		},
		responder: () => ({ contactId: 'ct1', created: false, matchedBy: 'PHONE' }),
	});
	const [out] = await new SynapsAi().execute.call(ctx);
	assert.equal(out[0].json.matchedBy, 'PHONE');
	assert.equal(ctx.http.calls[0].options.url, 'https://connect.synapsai.app/v1/contacts:upsert');
	assert.deepEqual(ctx.http.calls[0].options.body, {
		phone: '+5071234567',
		name: 'Ana',
		mode: 'overwrite',
	});

	const nameOnly = executeContext({
		params: { resource: 'contact', operation: 'upsert', contact: { name: 'Ana' }, mode: 'fill' },
	});
	await assert.rejects(new SynapsAi().execute.call(nameOnly), /at least one/);
	assert.equal(nameOnly.http.calls.length, 0);
});

test('List leads and Get message hit their documented paths', async () => {
	const cursors = [];
	const leads = executeContext({
		params: {
			resource: 'lead',
			operation: 'getAll',
			agentKey: 'k',
			leadFilters: { outcome: 'WRITTEN_DEAL' },
			returnAll: true,
		},
		responder: (options) => {
			cursors.push(options.qs.cursor ?? null);
			return options.qs.cursor
				? { items: [{ leadId: 'l2' }], nextCursor: null, total: 2, deliveryIssues: null }
				: { items: [{ leadId: 'l1' }], nextCursor: 'abc', total: 2, deliveryIssues: [] };
		},
	});
	const [rows] = await new SynapsAi().execute.call(leads);
	assert.deepEqual(
		rows.map((r) => r.json.leadId),
		['l1', 'l2'],
	);
	assert.deepEqual(cursors, [null, 'abc']);
	assert.equal(leads.http.calls[0].options.url, 'https://connect.synapsai.app/v1/leads');
	assert.deepEqual(leads.http.calls[0].options.qs, {
		agentKey: 'k',
		outcome: 'WRITTEN_DEAL',
		limit: 100,
	});

	const message = executeContext({
		params: { resource: 'message', operation: 'get', messageId: 'msg_1' },
		responder: () => ({ status: 'REPLIED' }),
	});
	await new SynapsAi().execute.call(message);
	assert.equal(message.http.calls[0].options.url, 'https://connect.synapsai.app/v1/messages/msg_1');
});

test('trigger: the documented events, including the four campaign events', () => {
	assert.deepEqual(TRIGGER_EVENTS.map((e) => e.value).sort(), [
		'campaign.completed',
		'campaign.message.delivered',
		'campaign.message.failed',
		'campaign.message.read',
		'conversation.ended',
		'handoff.requested',
		'lead.captured',
		'message.operator',
		'message.replied',
	]);
});

const campaignParams = (extra = {}, options = {}) => ({
	resource: 'campaign',
	operation: 'send',
	agentKey: 'velvet',
	campaignChannel: 'WHATSAPP_TEMPLATE',
	templateName: 'promo',
	templateLanguage: 'pt_BR',
	recipients: [{ contactId: 'c1', variables: { 1: 'Ana' } }, 'c2'],
	campaignOptions: options,
	...extra,
});

test('Campaign Send (template): Idempotency-Key header, template object, recipients normalised', async () => {
	const ctx = executeContext({
		params: campaignParams({}, { variables: '{"2":"10%"}', name: 'BF' }),
		responder: () => ({ campaignId: 'cmp_1', status: 'SENDING', recipients: 2, skipped: [] }),
	});
	const [[row]] = await new SynapsAi().execute.call(ctx);
	assert.equal(row.json.campaignId, 'cmp_1');
	const { options } = ctx.http.calls[0];
	assert.equal(options.url, 'https://connect.synapsai.app/v1/agents/velvet/campaigns');
	assert.match(options.headers['Idempotency-Key'], /^n8n-[a-f0-9]{40}$/);
	assert.deepEqual(options.body, {
		name: 'BF',
		channel: 'WHATSAPP_TEMPLATE',
		template: { name: 'promo', language: 'pt_BR' },
		recipients: [{ contactId: 'c1', variables: { 1: 'Ana' } }, { contactId: 'c2' }],
		variables: { 2: '10%' },
	});
});

test('Campaign Send (session channel): message, no template; own Idempotency-Key wins', async () => {
	const ctx = executeContext({
		params: campaignParams(
			{ campaignChannel: 'MESSENGER', campaignMessage: 'hello' },
			{ idempotencyKey: 'k-9' },
		),
		responder: () => ({ campaignId: 'cmp_2' }),
	});
	await new SynapsAi().execute.call(ctx);
	const { options } = ctx.http.calls[0];
	assert.equal(options.headers['Idempotency-Key'], 'k-9');
	assert.equal(options.body.message, 'hello');
	assert.equal(options.body.template, undefined);
	assert.equal(options.body.channel, 'MESSENGER');
});

test('Campaign Send: empty or malformed recipients are refused before any call', async () => {
	for (const recipients of [[], '[]', 'nope', [{ id: 'x' }]]) {
		const ctx = executeContext({ params: campaignParams({ recipients }), responder: () => ({}) });
		await assert.rejects(new SynapsAi().execute.call(ctx), /Recipients must be a non-empty list/);
		assert.equal(ctx.http.calls.length, 0);
	}
});

test('Campaign Send retries a 503 (idempotent by key); Cancel does not', async () => {
	assert.equal(transport.isIdempotent('POST', '/v1/agents/velvet/campaigns'), true);
	assert.equal(transport.isIdempotent('POST', '/v1/campaigns/cmp_1:cancel'), false);
});

test('Campaign Get, Get Deliveries (status filter, paged) and Cancel hit the public paths', async () => {
	const get = executeContext({
		params: { resource: 'campaign', operation: 'get', campaignId: 'cmp_1' },
		responder: () => ({ id: 'cmp_1' }),
	});
	await new SynapsAi().execute.call(get);
	assert.equal(get.http.calls[0].options.url, 'https://connect.synapsai.app/v1/campaigns/cmp_1');

	const deliveries = executeContext({
		params: {
			resource: 'campaign',
			operation: 'getDeliveries',
			campaignId: 'cmp_1',
			deliveryStatus: 'FAILED',
			returnAllDeliveries: true,
		},
		responder: () => ({ items: [{ id: 'd1' }], page: 0, size: 100, total: 1 }),
	});
	const [[row]] = await new SynapsAi().execute.call(deliveries);
	assert.equal(row.json.id, 'd1');
	assert.equal(
		deliveries.http.calls[0].options.url,
		'https://connect.synapsai.app/v1/campaigns/cmp_1/deliveries',
	);
	assert.equal(deliveries.http.calls[0].options.qs.status, 'FAILED');

	const cancel = executeContext({
		params: { resource: 'campaign', operation: 'cancel', campaignId: 'cmp_1' },
		responder: () => ({ id: 'cmp_1', status: 'CANCELLED' }),
	});
	await new SynapsAi().execute.call(cancel);
	assert.equal(cancel.http.calls[0].options.method, 'POST');
	assert.equal(
		cancel.http.calls[0].options.url,
		'https://connect.synapsai.app/v1/campaigns/cmp_1:cancel',
	);
});

test('Template Get Many lists the approved templates of the agent', async () => {
	const ctx = executeContext({
		params: { resource: 'template', operation: 'getAll', agentKey: 'velvet' },
		responder: () => ({
			items: [
				{ name: 'promo', language: 'pt_BR' },
				{ name: 'other', language: 'en_US' },
			],
			lastSyncedAt: 't',
		}),
	});
	const [rows] = await new SynapsAi().execute.call(ctx);
	assert.equal(rows.length, 2);
	assert.equal(
		ctx.http.calls[0].options.url,
		'https://connect.synapsai.app/v1/agents/velvet/templates',
	);
});

test('Contact Get Many passes inWindow and pages', async () => {
	const ctx = executeContext({
		params: {
			resource: 'contact',
			operation: 'getAll',
			returnAll: true,
			contactFilters: { inWindow: 'MESSENGER', search: '' },
		},
		responder: () => ({
			items: [{ id: 'c1', windowExpiresAt: 'x' }],
			page: 0,
			size: 100,
			total: 1,
		}),
	});
	const [[row]] = await new SynapsAi().execute.call(ctx);
	assert.equal(row.json.windowExpiresAt, 'x');
	assert.equal(ctx.http.calls[0].options.url, 'https://connect.synapsai.app/v1/contacts');
	assert.deepEqual(ctx.http.calls[0].options.qs, { inWindow: 'MESSENGER', page: 0, size: 100 });
});

test('trigger create: subscribes the https webhook URL and keeps the id and secret', async () => {
	const ctx = hookContext({
		params: { agentKey: 'k', events: ['message.replied', 'lead.captured'], includes: ['contact'] },
		responder: () => ({ id: 'hk_1', signingSecret: 'whsec_sub' }),
	});
	assert.equal(await new SynapsAiTrigger().webhookMethods.default.create.call(ctx), true);
	const { options } = ctx.http.calls[0];
	assert.equal(options.method, 'POST');
	assert.equal(options.url, 'https://connect.synapsai.app/v1/agents/k/hooks');
	assert.deepEqual(options.body, {
		url: 'https://n8n.example.com/webhook/abc/webhook',
		events: ['message.replied', 'lead.captured'],
		externalSubscriptionId: 'n8n:wf-7:node-1',
		includes: { contact: true },
	});
	assert.deepEqual(ctx.staticData, { hookId: 'hk_1', signingSecret: 'whsec_sub' });
});

test('trigger create: an http:// webhook URL is refused before calling SynapsAI', async () => {
	const ctx = hookContext({
		params: { agentKey: 'k', events: ['message.replied'] },
		url: 'http://localhost:5678/webhook/x',
	});
	await assert.rejects(new SynapsAiTrigger().webhookMethods.default.create.call(ctx), /HTTPS/);
	assert.equal(ctx.http.calls.length, 0);
});

test('trigger checkExists: true only when SynapsAI still lists the same id at the same URL', async () => {
	const url = 'https://n8n.example.com/webhook/abc/webhook';
	const present = hookContext({
		params: { agentKey: 'k' },
		staticData: { hookId: 'hk_1', signingSecret: 's' },
		responder: () => ({ items: [{ id: 'hk_1', url }], page: 0, size: 1, total: 1 }),
	});
	assert.equal(await new SynapsAiTrigger().webhookMethods.default.checkExists.call(present), true);
	const gone = hookContext({
		params: { agentKey: 'k' },
		staticData: { hookId: 'hk_1', signingSecret: 's' },
		responder: () => ({ items: [], page: 0, size: 0, total: 0 }),
	});
	assert.equal(await new SynapsAiTrigger().webhookMethods.default.checkExists.call(gone), false);
	assert.deepEqual(gone.staticData, {});
	// A bare array (the pre-page shape) is refused, not read.
	const bare = hookContext({
		params: { agentKey: 'k' },
		staticData: { hookId: 'hk_1' },
		responder: () => [{ id: 'hk_1', url }],
	});
	await assert.rejects(
		new SynapsAiTrigger().webhookMethods.default.checkExists.call(bare),
		/expected an object/,
	);
	const none = hookContext({ params: { agentKey: 'k' } });
	assert.equal(await new SynapsAiTrigger().webhookMethods.default.checkExists.call(none), false);
	assert.equal(none.http.calls.length, 0);
});

test('trigger delete: DELETE /v1/hooks/{id}; a 404 counts as deleted, another error keeps the id', async () => {
	const ok = hookContext({
		params: {},
		staticData: { hookId: 'hk_1', signingSecret: 's' },
		responder: () => ({}),
	});
	assert.equal(await new SynapsAiTrigger().webhookMethods.default.delete.call(ok), true);
	assert.equal(ok.http.calls[0].options.method, 'DELETE');
	assert.equal(ok.http.calls[0].options.url, 'https://connect.synapsai.app/v1/hooks/hk_1');
	assert.deepEqual(ok.staticData, {});

	const notFound = hookContext({
		params: {},
		staticData: { hookId: 'hk_1' },
		responder: () => {
			throw Object.assign(new Error('Not Found'), {
				httpCode: '404',
				response: { status: 404, body: { code: 'HOOK_NOT_FOUND' } },
			});
		},
	});
	assert.equal(await new SynapsAiTrigger().webhookMethods.default.delete.call(notFound), true);
	assert.deepEqual(notFound.staticData, {});

	const failing = hookContext({
		params: {},
		staticData: { hookId: 'hk_1' },
		responder: () => {
			throw Object.assign(new Error('boom'), { httpCode: '503', response: { status: 503 } });
		},
	});
	assert.equal(await new SynapsAiTrigger().webhookMethods.default.delete.call(failing), false);
	assert.equal(failing.staticData.hookId, 'hk_1');
});

test('trigger webhook: verified with the subscription secret; a ping is acknowledged without a run', async () => {
	const staticData = { hookId: 'hk_1', signingSecret: 'whsec_sub' };
	const body = {
		id: 'evt_00000000000000000000000000000009',
		type: 'lead.captured',
		lead: {
			score: 82,
			interest: '3 units',
			dealTitle: 'Drill',
			budget: { amount: 120, currency: 'USD' },
			timeframe: 'this week',
			contactDeclined: false,
		},
		contact: { id: 'c_91', name: 'Ana', email: 'ana@example.com', phone: '+5071234567' },
	};
	const raw = Buffer.from(JSON.stringify(body));
	const headers = {
		'x-synapsai-timestamp': String(NOW),
		'x-synapsai-webhook-id': 'evt_00000000000000000000000000000009',
		'x-synapsai-signature': sign('whsec_sub', NOW, 'evt_00000000000000000000000000000009', raw),
	};
	const run = await new SynapsAiTrigger().webhook.call(
		webhookContext({ body, rawBody: raw, headers, staticData }),
	);
	assert.deepEqual(run.workflowData[0][0].json, body);
	const duplicate = webhookContext({ body, rawBody: raw, headers, staticData });
	const duplicateResult = await new SynapsAiTrigger().webhook.call(duplicate);
	assert.equal(duplicate.res.statusCode, 200);
	assert.equal(duplicateResult.workflowData, undefined);

	const forged = webhookContext({
		body,
		rawBody: raw,
		headers: {
			...headers,
			'x-synapsai-signature': sign(
				CREDENTIALS.signingSecret,
				NOW,
				'evt_00000000000000000000000000000009',
				raw,
			),
		},
		staticData,
	});
	const refused = await new SynapsAiTrigger().webhook.call(forged);
	assert.equal(forged.res.statusCode, 401);
	assert.equal(refused.workflowData, undefined);

	const pingBody = { id: 'ping_1', type: 'hook.ping' };
	const pingRaw = Buffer.from(JSON.stringify(pingBody));
	const ping = webhookContext({
		body: pingBody,
		rawBody: pingRaw,
		headers: {
			'x-synapsai-timestamp': String(NOW),
			'x-synapsai-webhook-id': 'ping_1',
			'x-synapsai-signature': sign('whsec_sub', NOW, 'ping_1', pingRaw),
		},
		staticData,
	});
	const pinged = await new SynapsAiTrigger().webhook.call(ping);
	assert.equal(ping.res.statusCode, 204);
	assert.equal(pinged.workflowData, undefined);
});

test('agent picker: GET /v1/agents is a page whose items are {key, title}', async () => {
	const ctx = loadOptionsContext({
		responder: () => ({
			items: [
				{ key: 'b-bot', title: 'Sales' },
				{ key: 'a-bot', title: '' },
			],
			page: 0,
			size: 2,
			total: 2,
		}),
	});
	const options = await transport.loadAgents.call(ctx);
	assert.deepEqual(options, [
		{ name: 'a-bot', value: 'a-bot' },
		{ name: 'Sales (b-bot)', value: 'b-bot' },
	]);
	await assert.rejects(
		transport.loadAgents.call(loadOptionsContext({ responder: () => [{ key: 'a' }] })),
		/expected an object/,
	);
	await assert.rejects(
		transport.loadAgents.call(loadOptionsContext({ responder: () => ({ items: [] }) })),
		/expected \{items, page, size, total\}/,
	);
});

test('503 is retried and then succeeds; other errors are not retried', async () => {
	let calls = 0;
	const flaky = loadOptionsContext({
		responder: () => {
			calls++;
			if (calls < 3)
				throw httpError(503, {
					code: 'UPSTREAM_UNAVAILABLE',
					message: 'The service is unavailable. Retry later.',
				});
			return { accountId: 'a' };
		},
	});
	assert.deepEqual(
		await transport.synapsAiRequest.call(flaky, 'GET', '/v1/me', undefined, undefined, {
			retryDelaysMs: [0, 0],
		}),
		{ accountId: 'a' },
	);
	assert.equal(calls, 3);

	let denied = 0;
	const plan = loadOptionsContext({
		responder: () => {
			denied++;
			throw httpError(403, {
				code: 'PLAN_FEATURE_UNAVAILABLE',
				message: 'Your plan does not include the API.',
			});
		},
	});
	await assert.rejects(
		transport.synapsAiRequest.call(plan, 'GET', '/v1/me', undefined, undefined, {
			retryDelaysMs: [0, 0],
		}),
		(error) =>
			error.message === 'PLAN_FEATURE_UNAVAILABLE: Your plan does not include the API.' &&
			error.httpCode === '403',
	);
	assert.equal(denied, 1);
});

test('503 on every attempt: the error says it was retried and keeps the SynapsAI code', async () => {
	let calls = 0;
	const down = loadOptionsContext({
		responder: () => {
			calls++;
			throw httpError(503, {
				code: 'UPSTREAM_UNAVAILABLE',
				message: 'The service is unavailable. Retry later.',
			});
		},
	});
	await assert.rejects(
		transport.synapsAiRequest.call(down, 'GET', '/v1/me', undefined, undefined, {
			retryDelaysMs: [0, 0],
		}),
		(error) =>
			/^UPSTREAM_UNAVAILABLE: .*retried 2 time\(s\)/.test(error.message) &&
			error.httpCode === '503',
	);
	assert.equal(calls, 3);
});

test('503 retry is for idempotent requests only: GETs and the message POST, never upsert or hook writes', async () => {
	const failing = (counter) =>
		loadOptionsContext({
			responder: () => {
				counter.n++;
				throw httpError(503, {
					code: 'UPSTREAM_UNAVAILABLE',
					message: 'The service is unavailable. Retry later.',
				});
			},
		});
	const fast = { retryDelaysMs: [0, 0] };
	for (const [method, path, expected] of [
		['GET', '/v1/conversations', 3],
		['POST', '/v1/agents/shop-bot/messages', 3],
		['POST', '/v1/contacts:upsert', 1],
		['POST', '/v1/agents/shop-bot/hooks', 1],
		['DELETE', '/v1/hooks/hk_1', 1],
	]) {
		const counter = { n: 0 };
		await assert.rejects(
			transport.synapsAiRequest.call(
				failing(counter),
				method,
				path,
				method === 'GET' ? undefined : {},
				undefined,
				fast,
			),
			(error) => error.httpCode === '503',
		);
		assert.equal(counter.n, expected, `${method} ${path}`);
	}
	assert.equal(transport.isIdempotent('POST', '/v1/agents/a/messages/extra'), false);
	assert.equal(transport.isIdempotent('PUT', '/v1/agents/a/messages'), false);
});

test('a non-retried 503 on a write says it may have been applied', async () => {
	const ctx = loadOptionsContext({
		responder: () => {
			throw httpError(503, {
				code: 'UPSTREAM_UNAVAILABLE',
				message: 'The service is unavailable. Retry later.',
			});
		},
	});
	await assert.rejects(
		transport.synapsAiRequest.call(
			ctx,
			'POST',
			'/v1/contacts:upsert',
			{ phone: '+5071' },
			undefined,
			{ retryDelaysMs: [0, 0] },
		),
		/may have been applied/,
	);
});

test('429 with Retry-After is retried for idempotent requests only, and only for a short wait', async () => {
	const limited = (counter, retryAfter) =>
		loadOptionsContext({
			responder: () => {
				counter.n++;
				if (counter.n === 1) {
					throw Object.assign(
						httpError(429, { code: 'RATE_LIMITED', message: 'Too many requests' }),
						{
							response: {
								status: 429,
								body: { code: 'RATE_LIMITED' },
								headers: { 'retry-after': retryAfter },
							},
						},
					);
				}
				return { items: [], page: 0, size: 0, total: 0 };
			},
		});
	const opts = { retryDelaysMs: [0, 0], maxRetryAfterMs: 50 };
	const get = { n: 0 };
	await transport.synapsAiRequest.call(
		limited(get, '0'),
		'GET',
		'/v1/conversations',
		undefined,
		undefined,
		opts,
	);
	assert.equal(get.n, 2, 'a GET waits Retry-After and retries');
	const post = { n: 0 };
	await transport.synapsAiRequest.call(
		limited(post, '0'),
		'POST',
		'/v1/agents/a/messages',
		{},
		undefined,
		opts,
	);
	assert.equal(post.n, 2, 'the message POST (idempotency key) retries');
	const upsert = { n: 0 };
	await assert.rejects(
		transport.synapsAiRequest.call(
			limited(upsert, '0'),
			'POST',
			'/v1/contacts:upsert',
			{},
			undefined,
			opts,
		),
		(e) => e.httpCode === '429',
	);
	assert.equal(upsert.n, 1, 'a write is never retried on 429');
	const long = { n: 0 };
	await assert.rejects(
		transport.synapsAiRequest.call(
			limited(long, '60'),
			'GET',
			'/v1/conversations',
			undefined,
			undefined,
			opts,
		),
		(e) => e.httpCode === '429',
	);
	assert.equal(long.n, 1, 'a Retry-After beyond the cap fails instead of blocking');
	assert.equal(transport.retryAfterMs({ response: { headers: { 'retry-after': '2' } } }), 2000);
	assert.equal(transport.retryAfterMs({ response: { headers: {} } }), undefined);
});
