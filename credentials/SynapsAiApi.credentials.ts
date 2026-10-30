import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class SynapsAiApi implements ICredentialType {
	name = 'synapsAiApi';

	displayName = 'SynapsAI API';

	icon: Icon = { light: 'file:synapsai.svg', dark: 'file:synapsai.dark.svg' };

	documentationUrl = 'https://docs.synapsai.app/workflows/n8n-cloud/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'sk_live_…',
			description:
				'An API key minted in the SynapsAI console (Account → API keys). Ask agent needs the messages:write scope.',
		},
		{
			displayName: 'Agent Signing Secret',
			name: 'signingSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'The signing secret of your agent: agent → Extensions → Workflow API (n8n · Make). Required to wait for a reply: the reply is accepted only when its signature matches.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// GET /v1/me answers 403 PLAN_FEATURE_UNAVAILABLE below GROWTH and 503 when SynapsAI is briefly unavailable.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://connect.synapsai.app',
			url: '/v1/me',
			method: 'GET',
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message: 'INVALID_KEY: the API key is unknown, revoked or expired.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						'PLAN_FEATURE_UNAVAILABLE: the API is part of the GROWTH, PRO and ENTERPRISE plans. Upgrade the SynapsAI account, then test again.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 503,
					message:
						'SynapsAI is temporarily unavailable (503). The key was not checked; test again in a minute.',
				},
			},
		],
	};
}
