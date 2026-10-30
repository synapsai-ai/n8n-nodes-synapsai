import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { headerValue, rawBodyOf, verifySynapsaiSignature } from '../shared/signature';
import {
	asObject,
	CREDENTIAL_NAME,
	loadAgents,
	segment,
	synapsAiRequest,
	numberedPage,
} from '../shared/transport';

/** The events this trigger can subscribe to (SPEC-842 C5 + SPEC-808). */
export const TRIGGER_EVENTS = [
	{
		name: 'Agent Replied',
		value: 'message.replied',
		description:
			'The agent answered an API-channel message, or the turn failed (needs conversations:read)',
	},
	{
		name: 'Campaign Completed',
		value: 'campaign.completed',
		description: 'A campaign finished, with its final counts (needs the campaigns:read scope)',
	},
	{
		name: 'Campaign Message Delivered',
		value: 'campaign.message.delivered',
		description: 'WhatsApp delivered a campaign message (needs the campaigns:read scope)',
	},
	{
		name: 'Campaign Message Failed',
		value: 'campaign.message.failed',
		description:
			'A campaign message failed, with the error source and code (needs the campaigns:read scope)',
	},
	{
		name: 'Campaign Message Read',
		value: 'campaign.message.read',
		description: 'The contact read a campaign message (needs the campaigns:read scope)',
	},
	{ name: 'Conversation Ended', value: 'conversation.ended', description: 'A conversation closed' },
	{
		name: 'Human Requested',
		value: 'handoff.requested',
		description: 'The customer asked for a person',
	},
	{
		name: 'Lead Captured',
		value: 'lead.captured',
		description: 'A lead was captured when a conversation closed (needs the leads:read scope)',
	},
	{
		name: 'Operator Replied',
		value: 'message.operator',
		description:
			'A console operator answered an API-channel conversation (needs conversations:read)',
	},
];

interface HookState extends IDataObject {
	hookId?: string;
	signingSecret?: string;
}

export class SynapsAiTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SynapsAI Trigger',
		name: 'synapsAiTrigger',
		icon: { light: 'file:synapsai.svg', dark: 'file:synapsai.dark.svg' },
		group: ['trigger'],
		version: [1],
		subtitle: '={{$parameter["events"].join(", ")}}',
		description:
			'Starts the workflow when a SynapsAI agent replies, a conversation ends or a lead is captured',
		defaults: { name: 'SynapsAI Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL_NAME, required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Agent Name or ID',
				name: 'agentKey',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getAgents' },
				required: true,
				default: '',
				description:
					'The agent whose events start this workflow. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: TRIGGER_EVENTS,
				default: ['message.replied'],
			},
			{
				displayName: 'Include',
				name: 'includes',
				type: 'multiOptions',
				default: [],
				description:
					'Extra sections in each event (none by default). Contact needs the contacts:read scope; messages, transcript and memory need conversations:read. Lead Captured needs leads:read, and its lead holds no personal data — include Contact to get the person.',
				options: [
					{ name: 'Contact', value: 'contact' },
					{ name: 'Memory', value: 'memory' },
					{ name: 'Messages', value: 'messages' },
					{ name: 'Transcript', value: 'transcript' },
				],
			},
		],
	};

	methods = {
		loadOptions: {
			getAgents: loadAgents,
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as HookState;
				if (!state.hookId) return false;
				const agentKey = segment(this.getNodeParameter('agentKey') as string, 'Agent');
				const url = this.getNodeWebhookUrl('default');
				const { items: hooks } = numberedPage.call(
					this,
					await synapsAiRequest.call(this, 'GET', `/v1/agents/${agentKey}/hooks`),
					'GET /v1/agents/{agentKey}/hooks',
				);
				const found = hooks.some((hook) => hook.id === state.hookId && hook.url === url);
				if (!found) {
					delete state.hookId;
					delete state.signingSecret;
				}
				return found;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const url = this.getNodeWebhookUrl('default');
				if (!url || !url.startsWith('https://')) {
					throw new NodeOperationError(
						this.getNode(),
						'SynapsAI delivers events over HTTPS only. Set WEBHOOK_URL to your public https:// address.',
					);
				}
				const agentKey = segment(this.getNodeParameter('agentKey') as string, 'Agent');
				const events = this.getNodeParameter('events') as string[];
				const includes = this.getNodeParameter('includes', []) as string[];
				const workflowId = this.getWorkflow().id ?? 'unsaved';
				const body: IDataObject = {
					url,
					events,
					externalSubscriptionId: `n8n:${workflowId}:${this.getNode().id}`,
				};
				if (includes.length > 0) {
					body.includes = Object.fromEntries(includes.map((name) => [name, true]));
				}
				const created = asObject.call(
					this,
					await synapsAiRequest.call(this, 'POST', `/v1/agents/${agentKey}/hooks`, body),
					'POST /v1/agents/{agentKey}/hooks',
				);
				if (!created.id || !created.signingSecret) {
					throw new NodeOperationError(
						this.getNode(),
						'SynapsAI did not return the subscription id and secret',
					);
				}
				const state = this.getWorkflowStaticData('node') as HookState;
				state.hookId = String(created.id);
				state.signingSecret = String(created.signingSecret);
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as HookState;
				if (state.hookId) {
					try {
						await synapsAiRequest.call(
							this,
							'DELETE',
							`/v1/hooks/${encodeURIComponent(state.hookId)}`,
						);
					} catch (error) {
						// Already gone (404) counts as deleted; anything else keeps the id for the next attempt.
						if (!isNotFound(error)) return false;
					}
				}
				delete state.hookId;
				delete state.signingSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const state = this.getWorkflowStaticData('node') as HookState;
		const headers = this.getHeaderData() as Record<string, string | string[] | undefined>;
		const rawBody = rawBodyOf(this.getRequestObject());
		const response = this.getResponseObject();
		const valid =
			rawBody !== undefined &&
			verifySynapsaiSignature({
				secret: String(state.signingSecret ?? ''),
				timestamp: headerValue(headers, 'x-synapsai-timestamp'),
				webhookId: headerValue(headers, 'x-synapsai-webhook-id'),
				signature: headerValue(headers, 'x-synapsai-signature'),
				rawBody,
			});
		if (!valid) {
			response.status(401).json({ code: 'INVALID_SIGNATURE' });
			return { noWebhookResponse: true };
		}
		const body = this.getBodyData();
		if (body.type === 'hook.ping') {
			response.status(204).end();
			return { noWebhookResponse: true };
		}
		return { workflowData: [[{ json: body }]] };
	}
}

function isNotFound(error: unknown): boolean {
	const e = error as { httpCode?: string | null };
	return e?.httpCode === '404';
}
