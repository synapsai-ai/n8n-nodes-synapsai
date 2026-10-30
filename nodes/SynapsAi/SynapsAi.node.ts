import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { createHash, createHmac } from 'node:crypto';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { headerValue, rawBodyOf, verifySynapsaiSignature } from '../shared/signature';
import {
	asObject,
	collectCursor,
	collectNumbered,
	compact,
	CREDENTIAL_NAME,
	loadAgents,
	segment,
	synapsAiRequest,
} from '../shared/transport';

/** The CRM lead outcomes `GET /v1/leads?outcome=` accepts (the platform's CrmLeadOutcome). */
export const LEAD_OUTCOMES = [
	'WRITTEN_CONTACT',
	'WRITTEN_DEAL',
	'WRITTEN_TASK',
	'SKIPPED_BELOW_THRESHOLD',
	'SKIPPED_NO_IDENTITY',
	'SKIPPED_DISABLED',
	'DISABLED_NO_CONFIG',
	'ERROR_TOKEN',
	'ERROR_TRANSIENT',
	'ERROR_VENDOR_UNRESOLVED',
];

/** The channels `GET /v1/contacts?inWindow=` accepts. */
export const IN_WINDOW_CHANNELS = [
	{ name: 'Instagram', value: 'INSTAGRAM' },
	{ name: 'Messenger', value: 'MESSENGER' },
	{ name: 'WhatsApp', value: 'WHATSAPP' },
];

/** The channels a campaign can be sent on (SPEC-848). */
export const CAMPAIGN_CHANNELS = [
	{ name: 'Instagram (Inside 24h Window)', value: 'INSTAGRAM' },
	{ name: 'Messenger (Inside 24h Window)', value: 'MESSENGER' },
	{ name: 'WhatsApp Session Message (Inside 24h Window)', value: 'WHATSAPP_SESSION' },
	{ name: 'WhatsApp Template', value: 'WHATSAPP_TEMPLATE' },
];

/** The events that end a wait: the agent answered, or the turn failed (SPEC-842 CONTRACT §7). */
export const RESUME_EVENTS = ['message.replied', 'message.failed'];

const show = (resource: string, operation: string) => ({
	show: { resource: [resource], operation: [operation] },
});

const agentKeyField = (resource: string, operation: string): INodeProperties => ({
	displayName: 'Agent Name or ID',
	name: 'agentKey',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getAgents' },
	required: true,
	default: '',
	description:
		'The agent to use. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	displayOptions: show(resource, operation),
});

export const properties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: [
			{ name: 'Agent', value: 'agent' },
			{ name: 'Campaign', value: 'campaign' },
			{ name: 'Contact', value: 'contact' },
			{ name: 'Conversation', value: 'conversation' },
			{ name: 'Lead', value: 'lead' },
			{ name: 'Message', value: 'message' },
			{ name: 'Template', value: 'template' },
		],
		default: 'agent',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['agent'] } },
		options: [
			{
				name: 'Ask',
				value: 'ask',
				description: 'Send a message to an agent and optionally wait for its reply',
				action: 'Ask an agent',
			},
		],
		default: 'ask',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['conversation'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				description: 'Get one conversation',
				action: 'Get a conversation',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List conversations',
				action: 'Get many conversations',
			},
		],
		default: 'getAll',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['contact'] } },
		options: [
			{
				name: 'Create or Update',
				value: 'upsert',
				description: 'Create a new record, or update the current one if it already exists (upsert)',
				action: 'Upsert a contact',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List contacts, optionally only those inside a channel’s 24-hour window',
				action: 'Get many contacts',
			},
		],
		default: 'upsert',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['campaign'] } },
		options: [
			{
				name: 'Cancel',
				value: 'cancel',
				description: 'Cancel a scheduled campaign',
				action: 'Cancel a campaign',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get one campaign with its sent, delivered, read and failed counts',
				action: 'Get a campaign',
			},
			{
				name: 'Get Deliveries',
				value: 'getDeliveries',
				description: 'List the per-recipient delivery rows of a campaign',
				action: 'Get campaign deliveries',
			},
			{
				name: 'Send',
				value: 'send',
				description: 'Send a WhatsApp template, or a session message, to contacts as a campaign',
				action: 'Send a campaign',
			},
		],
		default: 'send',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['template'] } },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List the approved WhatsApp templates of an agent',
				action: 'Get many templates',
			},
		],
		default: 'getAll',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['lead'] } },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List captured leads',
				action: 'Get many leads',
			},
		],
		default: 'getAll',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['message'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				description: 'Get the status and reply of a message sent with Ask',
				action: 'Get a message',
			},
		],
		default: 'get',
	},

	// ── Agent: Ask ─────────────────────────────────────────────────────────────
	agentKeyField('agent', 'ask'),
	{
		displayName: 'External User ID',
		name: 'externalUserId',
		type: 'string',
		required: true,
		default: '',
		description:
			'Your stable ID for the person this conversation is with (1–128 characters). The same ID continues the same conversation.',
		displayOptions: show('agent', 'ask'),
	},
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		description: 'The message for the agent (up to 4000 characters)',
		displayOptions: show('agent', 'ask'),
	},
	{
		displayName: 'Wait for Reply',
		name: 'waitForReply',
		type: 'boolean',
		default: true,
		description:
			'Whether to pause this execution until the agent replies. Needs the agent signing secret in the credential and an n8n instance reachable over HTTPS.',
		displayOptions: show('agent', 'ask'),
	},
	{
		displayName: 'Limit Wait Time (Minutes)',
		name: 'waitMinutes',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 1440 },
		default: 10,
		description:
			'After this time the execution continues without a reply; use Message → Get to read it later',
		displayOptions: { show: { resource: ['agent'], operation: ['ask'], waitForReply: [true] } },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: show('agent', 'ask'),
		options: [
			{
				displayName: 'Callback URL',
				name: 'callbackUrl',
				type: 'string',
				default: '',
				description:
					'Where SynapsAI posts the reply when Wait for Reply is off (HTTPS, port 443). Ignored while waiting.',
			},
			{
				displayName: 'Contact Email',
				name: 'email',
				type: 'string',
				placeholder: 'name@email.com',
				default: '',
				description: 'Fills a blank e-mail on this conversation’s contact; never merges contacts',
			},
			{
				displayName: 'Contact ID',
				name: 'contactId',
				type: 'string',
				default: '',
				description:
					'Attach the conversation to this existing contact. Needs the contacts:write scope.',
			},
			{
				displayName: 'Contact Name',
				name: 'name',
				type: 'string',
				default: '',
				description: 'Fills a blank name on this conversation’s contact',
			},
			{
				displayName: 'Contact Phone',
				name: 'phone',
				type: 'string',
				default: '',
				description:
					'Fills a blank phone (E.164) on this conversation’s contact; never merges contacts',
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				description:
					'Retrying with the same key and body within 24 h returns the same message instead of a second turn. For a recurring send with byte-identical input, provide an explicit Idempotency Key expression because campaign keys do not expire.',
			},
			{
				displayName: 'Metadata',
				name: 'metadata',
				type: 'json',
				default: '{}',
				description:
					'Up to 20 keys (2 KB) echoed back in the reply webhook. Never shown to the agent.',
			},
		],
	},

	// ── Conversation ──────────────────────────────────────────────────────────
	{
		displayName: 'Conversation ID',
		name: 'conversationId',
		type: 'string',
		required: true,
		default: '',
		description: 'The chatId of a conversation (from Get Many, a reply or a trigger event)',
		displayOptions: show('conversation', 'get'),
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add filter',
		default: {},
		displayOptions: show('conversation', 'getAll'),
		options: [
			{ displayName: 'Agent Key', name: 'agentKey', type: 'string', default: '' },
			{
				displayName: 'Channel',
				name: 'origin',
				type: 'options',
				default: 'API',
				options: [
					{ name: 'API', value: 'API' },
					{ name: 'App', value: 'APP' },
					{ name: 'E-Mail', value: 'EMAIL' },
					{ name: 'Instagram', value: 'INSTAGRAM' },
					{ name: 'Messenger', value: 'MESSENGER' },
					{ name: 'Telegram', value: 'TELEGRAM' },
					{ name: 'Web Chat', value: 'CHAT' },
					{ name: 'WhatsApp', value: 'WHATSAPP' },
				],
			},
			{
				displayName: 'CSAT Maximum',
				name: 'csatMax',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 5 },
				default: 5,
				description:
					'Only conversations rated at most this score; unrated conversations are left out. The score itself is on Get.',
			},
			{
				displayName: 'CSAT Minimum',
				name: 'csatMin',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 5 },
				default: 1,
				description:
					'Only conversations rated at least this score; unrated conversations are left out',
			},
			{ displayName: 'From', name: 'from', type: 'dateTime', default: '' },
			{ displayName: 'Status', name: 'status', type: 'string', default: '' },
			{ displayName: 'To', name: 'to', type: 'dateTime', default: '' },
		],
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: {
			show: { resource: ['conversation', 'lead', 'contact'], operation: ['getAll'] },
		},
	},
	{
		displayName: 'Return All',
		name: 'returnAllDeliveries',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: show('campaign', 'getDeliveries'),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: {
			show: {
				resource: ['conversation', 'lead', 'contact'],
				operation: ['getAll'],
				returnAll: [false],
			},
		},
	},

	// ── Contact: Upsert ───────────────────────────────────────────────────────
	{
		displayName: 'Match and Fill Fields',
		name: 'contact',
		type: 'collection',
		placeholder: 'Add field',
		default: {},
		description:
			'SynapsAI matches by contact ID, then phone, then e-mail, then external user ID — the first hit wins',
		displayOptions: show('contact', 'upsert'),
		options: [
			{ displayName: 'Contact ID', name: 'contactId', type: 'string', default: '' },
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				placeholder: 'name@email.com',
				default: '',
			},
			{ displayName: 'External User ID', name: 'externalUserId', type: 'string', default: '' },
			{ displayName: 'Name', name: 'name', type: 'string', default: '' },
			{
				displayName: 'Phone',
				name: 'phone',
				type: 'string',
				default: '',
				description: 'E.164, e.g. +5071234567',
			},
		],
	},
	{
		displayName: 'Mode',
		name: 'mode',
		type: 'options',
		default: 'fill',
		options: [
			{
				name: 'Fill Blanks',
				value: 'fill',
				description: 'Only set fields that are empty on the contact',
			},
			{
				name: 'Overwrite',
				value: 'overwrite',
				description: 'Replace the contact’s fields with these values',
			},
		],
		displayOptions: show('contact', 'upsert'),
	},

	// ── Lead ──────────────────────────────────────────────────────────────────
	agentKeyField('lead', 'getAll'),
	{
		displayName: 'Filters',
		name: 'leadFilters',
		type: 'collection',
		placeholder: 'Add filter',
		default: {},
		displayOptions: show('lead', 'getAll'),
		options: [
			{
				displayName: 'CRM Outcome',
				name: 'outcome',
				type: 'options',
				default: 'WRITTEN_DEAL',
				options: LEAD_OUTCOMES.map((value) => ({ name: value, value })),
			},
		],
	},

	// ── Template ──────────────────────────────────────────────────────────────
	agentKeyField('template', 'getAll'),

	// ── Contact: Get Many ─────────────────────────────────────────────────────
	{
		displayName: 'Filters',
		name: 'contactFilters',
		type: 'collection',
		placeholder: 'Add filter',
		default: {},
		displayOptions: show('contact', 'getAll'),
		options: [
			{
				displayName: 'In Window',
				name: 'inWindow',
				type: 'options',
				default: 'WHATSAPP',
				description:
					'Only contacts whose last message on this channel is under 24 hours old — the ones a session message can reach. Each contact then carries windowExpiresAt.',
				options: IN_WINDOW_CHANNELS,
			},
			{ displayName: 'Search', name: 'search', type: 'string', default: '' },
		],
	},

	// ── Campaign: Send ────────────────────────────────────────────────────────
	agentKeyField('campaign', 'send'),
	{
		displayName: 'Channel',
		name: 'campaignChannel',
		type: 'options',
		required: true,
		default: 'WHATSAPP_TEMPLATE',
		description:
			'WhatsApp Template reaches any contact with an approved template; the other channels send free text and reach only contacts inside the 24-hour window',
		options: CAMPAIGN_CHANNELS,
		displayOptions: show('campaign', 'send'),
	},
	{
		displayName: 'Template Name',
		name: 'templateName',
		type: 'string',
		required: true,
		default: '',
		description: 'The name of an approved template (from Template → Get Many)',
		displayOptions: {
			show: { resource: ['campaign'], operation: ['send'], campaignChannel: ['WHATSAPP_TEMPLATE'] },
		},
	},
	{
		displayName: 'Template Language',
		name: 'templateLanguage',
		type: 'string',
		required: true,
		default: 'en_US',
		description: 'The language code of that template, e.g. pt_BR',
		displayOptions: {
			show: { resource: ['campaign'], operation: ['send'], campaignChannel: ['WHATSAPP_TEMPLATE'] },
		},
	},
	{
		displayName: 'Message',
		name: 'campaignMessage',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		description: 'The free-text message for a session channel',
		displayOptions: {
			show: {
				resource: ['campaign'],
				operation: ['send'],
				campaignChannel: ['WHATSAPP_SESSION', 'MESSENGER', 'INSTAGRAM'],
			},
		},
	},
	{
		displayName: 'Recipients',
		name: 'recipients',
		type: 'json',
		required: true,
		default: '[]',
		description:
			'Up to 1,000 contacts, as a list of contact IDs or of {contactId, variables} objects, e.g. [{"contactId":"c1","variables":{"1":"Ana"}}]. Contacts that cannot be reached come back under skipped and are not charged.',
		displayOptions: show('campaign', 'send'),
	},
	{
		displayName: 'Options',
		name: 'campaignOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: show('campaign', 'send'),
		options: [
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				description:
					'Retrying with the same key and body returns the same campaign and never charges twice. For a recurring send with byte-identical input, provide an explicit Idempotency Key expression because campaign keys do not expire.',
			},
			{
				displayName: 'Merge Field Fallbacks',
				name: 'mergeFieldFallbacks',
				type: 'json',
				default: '{}',
				description: 'Value to use when a contact lacks a merge field, e.g. {"name":"customer"}',
			},
			{ displayName: 'Name', name: 'name', type: 'string', default: '' },
			{
				displayName: 'Schedule At',
				name: 'scheduledAt',
				type: 'dateTime',
				default: '',
				description: 'Send later (at least 5 minutes ahead) instead of now',
			},
			{
				displayName: 'Variables',
				name: 'variables',
				type: 'json',
				default: '{}',
				description:
					'Template variables for every recipient, e.g. {"1":"10%"}; a recipient’s own values win',
			},
		],
	},

	// ── Campaign: Get / Get Deliveries / Cancel ───────────────────────────────
	{
		displayName: 'Campaign ID',
		name: 'campaignId',
		type: 'string',
		required: true,
		default: '',
		description: 'The campaignId returned by Send',
		displayOptions: {
			show: { resource: ['campaign'], operation: ['get', 'getDeliveries', 'cancel'] },
		},
	},
	{
		displayName: 'Status',
		name: 'deliveryStatus',
		type: 'options',
		default: '',
		options: [
			{ name: 'Any', value: '' },
			{ name: 'Delivered', value: 'DELIVERED' },
			{ name: 'Failed', value: 'FAILED' },
			{ name: 'Pending', value: 'PENDING' },
			{ name: 'Read', value: 'READ' },
			{ name: 'Sent', value: 'SENT' },
		],
		displayOptions: show('campaign', 'getDeliveries'),
	},

	// ── Message ───────────────────────────────────────────────────────────────
	{
		displayName: 'Message ID',
		name: 'messageId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'msg_…',
		displayOptions: show('message', 'get'),
	},
];

export class SynapsAi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SynapsAI',
		name: 'synapsAi',
		icon: { light: 'file:synapsai.svg', dark: 'file:synapsai.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Ask a SynapsAI agent, send it WhatsApp template campaigns, and read its conversations, contacts and leads',
		defaults: { name: 'SynapsAI' },
		// n8n's published type omits false although the runtime checks the boolean value.
		usableAsTool: false as unknown as true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL_NAME, required: true }],
		// The reply resumes a waiting execution on this node's own webhook (the send-and-wait pattern).
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				responseData: '',
				path: '={{ $nodeId }}',
				restartWebhook: true,
				isFullPath: true,
			},
		],
		properties,
	};

	methods = {
		loadOptions: {
			getAgents: loadAgents,
		},
	};

	/**
	 * The resume webhook above is a restart webhook: n8n serves it only for an execution this node put to wait, and never
	 * registers it on activation, so there is nothing to create or delete at SynapsAI. The per-message callbackUrl is the
	 * registration. The lifecycle is declared so the lint rule for webhook nodes holds, and does nothing.
	 */
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject();
		const response = this.getResponseObject();
		const credentials = await this.getCredentials(CREDENTIAL_NAME);
		const headers = this.getHeaderData() as Record<string, string | string[] | undefined>;
		const rawBody = rawBodyOf(request);
		const valid =
			rawBody !== undefined &&
			verifySynapsaiSignature({
				secret: String(credentials.signingSecret ?? ''),
				timestamp: headerValue(headers, 'x-synapsai-timestamp'),
				webhookId: headerValue(headers, 'x-synapsai-webhook-id'),
				signature: headerValue(headers, 'x-synapsai-signature'),
				rawBody,
			});
		if (!valid) {
			// A forged or stale request never resumes the execution; it keeps waiting for the real reply.
			response.status(401).json({ code: 'INVALID_SIGNATURE' });
			return { noWebhookResponse: true };
		}
		const body = this.getBodyData();
		if (!RESUME_EVENTS.includes(String(body.type))) {
			response.status(204).end();
			return { noWebhookResponse: true };
		}
		const state = this.getWorkflowStaticData('node') as IDataObject;
		const message = body.message as IDataObject | undefined;
		const nonce = (message?.metadata as IDataObject | undefined)?._n8n;
		if (!state.waitingMessageId || nonce !== state.waitingNonce) {
			response.status(401).json({ code: 'REPLY_MISMATCH' });
			return { noWebhookResponse: true };
		}
		return { webhookResponse: '', workflowData: [[{ json: replyItem(body) }]] };
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'agent' && operation === 'ask') {
					const waitForReply = this.getNodeParameter('waitForReply', i) as boolean;
					if (waitForReply) {
						if (items.length > 1) {
							throw new NodeOperationError(
								this.getNode(),
								'Wait for Reply handles one item per execution. Split the items (Loop Over Items) or turn waiting off.',
								{ itemIndex: i },
							);
						}
						const credentials = await this.getCredentials(CREDENTIAL_NAME);
						if (!credentials.signingSecret) {
							throw new NodeOperationError(
								this.getNode(),
								'Wait for Reply needs the Agent Signing Secret in the SynapsAI credential',
								{ itemIndex: i },
							);
						}
						const accepted = await ask.call(this, i, this.getSignedResumeUrl());
						(this.getWorkflowStaticData('node') as IDataObject).waitingMessageId = accepted.messageId;
						const minutes = this.getNodeParameter('waitMinutes', i, 10) as number;
						await this.putExecutionToWait(new Date(Date.now() + minutes * 60_000));
						// Until the reply arrives the output is the accepted message; the webhook replaces it.
						return [[{ json: accepted, pairedItem: { item: i } }]];
					}
					returnData.push({ json: await ask.call(this, i, undefined), pairedItem: { item: i } });
					continue;
				}

				const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
				const limit = this.getNodeParameter('limit', i, 50) as number;

				let result: IDataObject | IDataObject[];
				if (resource === 'conversation' && operation === 'get') {
					const id = segment(
						this.getNodeParameter('conversationId', i) as string,
						'Conversation ID',
					);
					result = asObject.call(
						this,
						await synapsAiRequest.call(this, 'GET', `/v1/conversations/${id}`),
						'GET /v1/conversations/{id}',
					);
				} else if (resource === 'conversation' && operation === 'getAll') {
					const qs = compact(this.getNodeParameter('filters', i, {}) as IDataObject);
					result = await collectNumbered.call(this, '/v1/conversations', qs, returnAll, limit);
				} else if (resource === 'contact' && operation === 'upsert') {
					const fields = compact(this.getNodeParameter('contact', i, {}) as IDataObject);
					if (Object.keys(fields).filter((k) => k !== 'name').length === 0) {
						throw new NodeOperationError(
							this.getNode(),
							'Give at least one of Contact ID, Phone, Email or External User ID to match on',
							{ itemIndex: i },
						);
					}
					const mode = this.getNodeParameter('mode', i, 'fill') as string;
					result = asObject.call(
						this,
						await synapsAiRequest.call(this, 'POST', '/v1/contacts:upsert', { ...fields, mode }),
						'POST /v1/contacts:upsert',
					);
				} else if (resource === 'contact' && operation === 'getAll') {
					const qs = compact(this.getNodeParameter('contactFilters', i, {}) as IDataObject);
					result = await collectNumbered.call(this, '/v1/contacts', qs, returnAll, limit);
				} else if (resource === 'template' && operation === 'getAll') {
					const agentKey = segment(this.getNodeParameter('agentKey', i) as string, 'Agent');
					const page = asObject.call(
						this,
						await synapsAiRequest.call(this, 'GET', `/v1/agents/${agentKey}/templates`),
						'GET /v1/agents/{agentKey}/templates',
					);
					result = Array.isArray(page.items) ? (page.items as IDataObject[]) : [];
				} else if (resource === 'campaign' && operation === 'send') {
					result = await sendCampaign.call(this, i);
				} else if (resource === 'campaign' && operation === 'get') {
					const id = segment(this.getNodeParameter('campaignId', i) as string, 'Campaign ID');
					result = asObject.call(
						this,
						await synapsAiRequest.call(this, 'GET', `/v1/campaigns/${id}`),
						'GET /v1/campaigns/{id}',
					);
				} else if (resource === 'campaign' && operation === 'getDeliveries') {
					const id = segment(this.getNodeParameter('campaignId', i) as string, 'Campaign ID');
					const qs = compact({ status: this.getNodeParameter('deliveryStatus', i, '') as string });
					result = await collectNumbered.call(
						this,
						`/v1/campaigns/${id}/deliveries`,
						qs,
						this.getNodeParameter('returnAllDeliveries', i, false) as boolean,
						limit,
					);
				} else if (resource === 'campaign' && operation === 'cancel') {
					const id = segment(this.getNodeParameter('campaignId', i) as string, 'Campaign ID');
					result = asObject.call(
						this,
						await synapsAiRequest.call(this, 'POST', `/v1/campaigns/${id}:cancel`, {}),
						'POST /v1/campaigns/{id}:cancel',
					);
				} else if (resource === 'lead' && operation === 'getAll') {
					const qs = compact({
						agentKey: this.getNodeParameter('agentKey', i) as string,
						...(this.getNodeParameter('leadFilters', i, {}) as IDataObject),
					});
					result = await collectCursor.call(this, '/v1/leads', qs, returnAll, limit);
				} else if (resource === 'message' && operation === 'get') {
					const id = segment(this.getNodeParameter('messageId', i) as string, 'Message ID');
					result = asObject.call(
						this,
						await synapsAiRequest.call(this, 'GET', `/v1/messages/${id}`),
						'GET /v1/messages/{id}',
					);
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`Unsupported operation ${resource}:${operation}`,
						{
							itemIndex: i,
						},
					);
				}
				const rows = Array.isArray(result) ? result : [result];
				for (const row of rows) returnData.push({ json: row, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof NodeApiError) {
					// n8n-workflow 2.45.1 returns the same NodeApiError from its constructor.
					error.context.itemIndex = i;
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, {
						itemIndex: i,
						message: error.message,
						httpCode: error.httpCode ?? undefined,
					});
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

/** POST /v1/agents/{agentKey}/messages for item `i`. */
async function ask(
	this: IExecuteFunctions,
	i: number,
	resumeUrl: string | undefined,
): Promise<IDataObject> {
	const agentKey = segment(this.getNodeParameter('agentKey', i) as string, 'Agent');
	const options = this.getNodeParameter('options', i, {}) as IDataObject;
	const credentials = await this.getCredentials(CREDENTIAL_NAME);
	const state = this.getWorkflowStaticData('node') as IDataObject;
	const contact = compact({ name: options.name, phone: options.phone, email: options.email });
	const body = compact({
		externalUserId: this.getNodeParameter('externalUserId', i) as string,
		text: this.getNodeParameter('text', i) as string,
		contactId: options.contactId,
		contact: Object.keys(contact).length > 0 ? contact : undefined,
		metadata: parseMetadata.call(this, options.metadata, i),
		callbackUrl: resumeUrl ?? options.callbackUrl,
	});
	if (resumeUrl) {
		const nonce = createHmac('sha256', String(credentials.signingSecret))
			.update(String(this.getExecutionId()))
			.digest('hex');
		body.metadata = { ...((body.metadata as IDataObject | undefined) ?? {}), _n8n: nonce };
		state.waitingNonce = nonce;
	}
	body.idempotencyKey = options.idempotencyKey || defaultIdempotencyKey.call(this, i, agentKey, body);
	return asObject.call(
		this,
		await synapsAiRequest.call(this, 'POST', `/v1/agents/${agentKey}/messages`, body),
		'POST /v1/agents/{agentKey}/messages',
	);
}

/** POST /v1/agents/{agentKey}/campaigns for item `i` — create and send (or schedule) in one call. */
async function sendCampaign(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const agentKey = segment(this.getNodeParameter('agentKey', i) as string, 'Agent');
	const channel = this.getNodeParameter('campaignChannel', i) as string;
	const options = this.getNodeParameter('campaignOptions', i, {}) as IDataObject;
	const recipients = parseRecipients.call(this, this.getNodeParameter('recipients', i), i);
	const isTemplate = channel === 'WHATSAPP_TEMPLATE';
	const body = compact({
		name: options.name,
		channel,
		template: isTemplate
			? {
					name: this.getNodeParameter('templateName', i) as string,
					language: this.getNodeParameter('templateLanguage', i) as string,
				}
			: undefined,
		message: isTemplate ? undefined : (this.getNodeParameter('campaignMessage', i) as string),
		recipients,
		variables: parseObject.call(this, options.variables, 'Variables', i),
		mergeFieldFallbacks: parseObject.call(
			this,
			options.mergeFieldFallbacks,
			'Merge Field Fallbacks',
			i,
		),
		scheduledAt: options.scheduledAt
			? new Date(options.scheduledAt as string).toISOString()
			: undefined,
	});
	const key = String(options.idempotencyKey || defaultIdempotencyKey.call(this, i, agentKey, body));
	return asObject.call(
		this,
		await synapsAiRequest.call(this, 'POST', `/v1/agents/${agentKey}/campaigns`, body, undefined, {
			headers: { 'Idempotency-Key': key },
		}),
		'POST /v1/agents/{agentKey}/campaigns',
	);
}

function defaultIdempotencyKey(
	this: IExecuteFunctions,
	i: number,
	agentKey: string,
	body: IDataObject,
): string {
	const requestBody = { ...body };
	delete requestBody.callbackUrl;
	delete requestBody.idempotencyKey;
	const canonical = canonicalJson({
		workflowId: this.getWorkflow().id ?? 'unsaved',
		nodeId: this.getNode().id,
		agentKey,
		body: requestBody,
		input: this.getInputData()[i]?.json ?? {},
	});
	return `n8n-${createHash('sha256').update(canonical).digest('hex').slice(0, 40)}`;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as IDataObject)[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/** Recipients as a list of contact ids or `{contactId, variables?}` objects, normalised to the latter. */
export function normaliseRecipients(value: unknown): IDataObject[] | undefined {
	const parsed = typeof value === 'string' ? safeParse(value) : value;
	if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
	const out: IDataObject[] = [];
	for (const entry of parsed) {
		if (typeof entry === 'string' && entry.trim() !== '') out.push({ contactId: entry.trim() });
		else if (
			entry &&
			typeof entry === 'object' &&
			typeof (entry as IDataObject).contactId === 'string'
		) {
			const { contactId, variables } = entry as IDataObject;
			out.push(compact({ contactId, variables }));
		} else return undefined;
	}
	return out;
}

function parseRecipients(this: IExecuteFunctions, value: unknown, i: number): IDataObject[] {
	const recipients = normaliseRecipients(value);
	if (!recipients) {
		throw new NodeOperationError(
			this.getNode(),
			'Recipients must be a non-empty list of contact IDs or {contactId, variables} objects',
			{ itemIndex: i },
		);
	}
	return recipients;
}

function parseObject(
	this: IExecuteFunctions,
	value: unknown,
	label: string,
	i: number,
): IDataObject | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const parsed = typeof value === 'string' ? safeParse(value) : value;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new NodeOperationError(this.getNode(), `${label} must be a JSON object`, {
			itemIndex: i,
		});
	}
	return Object.keys(parsed).length > 0 ? (parsed as IDataObject) : undefined;
}

function parseMetadata(
	this: IExecuteFunctions,
	value: unknown,
	i: number,
): IDataObject | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const parsed = typeof value === 'string' ? safeParse(value) : value;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new NodeOperationError(this.getNode(), 'Metadata must be a JSON object', {
			itemIndex: i,
		});
	}
	return Object.keys(parsed).length > 0 ? (parsed as IDataObject) : undefined;
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The resumed output: the reply flattened for the next node, the full envelope kept under `event`. */
export function replyItem(body: IDataObject): IDataObject {
	const message = (body.message ?? {}) as IDataObject;
	const error = body.error as IDataObject | undefined;
	return {
		status: body.type === 'message.failed' ? 'FAILED' : 'REPLIED',
		messageId: message.id ?? null,
		conversationId: (body.conversation as IDataObject | undefined)?.id ?? null,
		text: message.text ?? null,
		components: message.components ?? [],
		metadata: message.metadata ?? null,
		errorCode: error?.code ?? null,
		event: body,
	};
}
