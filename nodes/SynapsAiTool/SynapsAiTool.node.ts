import type { INodeProperties, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { SynapsAi, properties as mainProperties } from '../SynapsAi/SynapsAi.node';
import { CREDENTIAL_NAME } from '../shared/transport';

const allowed: Record<string, string[]> = {
	conversation: ['get', 'getAll'],
	contact: ['getAll'],
	lead: ['getAll'],
	message: ['get'],
	template: ['getAll'],
	campaign: ['get', 'getDeliveries'],
};

function toolProperties(): INodeProperties[] {
	return mainProperties.flatMap((property) => {
		const shown = property.displayOptions?.show;
		if (!shown?.resource) {
			if (property.name !== 'resource') return [];
			return [{
				...property,
				options: property.options?.filter((option) => Object.hasOwn(allowed, option.value as string)),
			}];
		}
		const resources = shown.resource.flatMap((resource) => {
			const operations = allowed[resource];
			if (!operations) return [];
			if (!shown.operation) return [resource];
			return shown.operation.some((operation) => operations.includes(operation)) ? [resource] : [];
		});
		if (!resources.length) return [];
		if (property.name === 'operation') {
			const resource = resources[0];
			return [{
				...property,
				options: property.options?.filter((option) => allowed[resource]?.includes(option.value as string)),
			}];
		}
		return [{ ...property, displayOptions: { ...property.displayOptions, show: { ...shown, resource: resources } } }];
	});
}

export class SynapsAiTool extends SynapsAi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SynapsAI Tool (read-only)',
		name: 'synapsAiTool',
		icon: { light: 'file:synapsai.svg', dark: 'file:synapsai.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Read-only SynapsAI operations for AI Agents',
		defaults: { name: 'SynapsAI Tool (read-only)' },
		usableAsTool: true,
		inputs: [],
		outputs: [],
		credentials: [{ name: CREDENTIAL_NAME, required: true }],
		properties: toolProperties(),
	};
}
