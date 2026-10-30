'use strict';
// Minimal fakes of the n8n execution contexts, enough to drive the nodes' own code without a running n8n.
const crypto = require('node:crypto');

const CREDENTIALS = {
	apiKey: 'sk_live_fake',
	baseUrl: 'https://connect.synapsai.app/',
	signingSecret: 'whsec_agent_test',
};

function sign(secret, timestamp, id, body) {
	return (
		'sha256=' +
		crypto.createHmac('sha256', secret).update(`${timestamp}.${id}.`).update(body).digest('hex')
	);
}

function fakeNode() {
	return {
		id: 'node-1',
		name: 'SynapsAI',
		type: 'n8n-nodes-synapsai.synapsAi',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
}

/** One HTTP fake: records every request and answers from `responder(options)`. */
function httpFake(responder) {
	const calls = [];
	return {
		calls,
		async httpRequestWithAuthentication(credentialName, options) {
			calls.push({ credentialName, options });
			return responder(options);
		},
	};
}

function executeContext({
	params,
	items = [{ json: {} }],
	credentials = CREDENTIALS,
	responder = () => ({}),
	staticData = {},
}) {
	const http = httpFake(responder);
	const state = {
		waitTill: undefined,
		resumeUrl: 'https://n8n.example.com/webhook-waiting/42/node-1?signature=abc',
	};
	const ctx = {
		http,
		state,
		staticData,
		getInputData: () => items,
		getNodeParameter: (name, i, fallback) => {
			const value = params[name];
			return value === undefined ? fallback : value;
		},
		getCredentials: async () => credentials,
		getNode: fakeNode,
		getExecutionId: () => 'exec-42',
		getWorkflow: () => ({ id: 'wf-7' }),
		getWorkflowStaticData: () => staticData,
		continueOnFail: () => false,
		getSignedResumeUrl: () => state.resumeUrl,
		putExecutionToWait: async (date) => {
			state.waitTill = date;
		},
		helpers: http,
	};
	return ctx;
}

function webhookContext({ body, headers, rawBody, credentials = CREDENTIALS, staticData = {}, executionId = 'exec-42' }) {
	const res = {
		statusCode: 200,
		sent: undefined,
		status(code) {
			this.statusCode = code;
			return this;
		},
		json(payload) {
			this.sent = payload;
			return this;
		},
		end() {
			return this;
		},
	};
	return {
		res,
		getRequestObject: () => ({ rawBody }),
		getResponseObject: () => res,
		getHeaderData: () => headers,
		getBodyData: () => body,
		getCredentials: async () => credentials,
		getWorkflowStaticData: () => staticData,
		getExecutionId: () => executionId,
		getNode: fakeNode,
	};
}

function hookContext({
	params,
	staticData = {},
	url = 'https://n8n.example.com/webhook/abc/webhook',
	responder,
}) {
	const http = httpFake(responder);
	return {
		http,
		staticData,
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name, fallback) => (params[name] === undefined ? fallback : params[name]),
		getNodeWebhookUrl: () => url,
		getWorkflow: () => ({ id: 'wf-7', active: true }),
		getCredentials: async () => CREDENTIALS,
		getNode: fakeNode,
		helpers: http,
	};
}

/** An error shaped like n8n's request helper failure. */
function httpError(status, body) {
	return Object.assign(new Error(`Request failed with status code ${status}`), {
		httpCode: String(status),
		response: { status, body },
	});
}

function loadOptionsContext({ responder }) {
	const http = httpFake(responder);
	return { http, getCredentials: async () => CREDENTIALS, getNode: fakeNode, helpers: http };
}

module.exports = {
	CREDENTIALS,
	sign,
	executeContext,
	webhookContext,
	hookContext,
	httpError,
	loadOptionsContext,
};
