import type { INodeProperties, INodePropertyOptions, INodeType, INodeTypeDescription } from 'n8n-workflow';
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
	const result: INodeProperties[] = [];
	for (const property of mainProperties) {
		const shown = property.displayOptions?.show;
		if (!shown?.resource) {
			if (property.name !== 'resource') continue;
			const options = (property.options ?? []) as INodePropertyOptions[];
			result.push({
				...property,
				options: options.filter((option) => typeof option.value === 'string' && allowed[option.value] !== undefined),
			});
			continue;
		}
		const resources = shown.resource.filter((resource): resource is string => typeof resource === 'string').flatMap((resource) => {
			const operations = allowed[resource];
			if (!operations) return [];
			if (!shown.operation) return [resource];
			return shown.operation.some((operation) => typeof operation === 'string' && operations.includes(operation)) ? [resource] : [];
		});
		if (!resources.length) continue;
		if (property.name === 'operation') {
			const resource = resources[0];
			const options = (property.options ?? []) as INodePropertyOptions[];
			result.push({
				...property,
				options: options.filter((option) => typeof option.value === 'string' && allowed[resource]?.includes(option.value)),
			});
			continue;
		}
		result.push({ ...property, displayOptions: { ...property.displayOptions, show: { ...shown, resource: resources } } });
	}
	return result;
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
