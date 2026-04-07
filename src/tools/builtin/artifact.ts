import type { ToolEntry, IAgent } from '../../types/index.js';

interface ArtifactSaveInput {
  title: string;
  content: string;
  type?: 'html' | 'mermaid' | 'svg' | undefined;
  description?: string | undefined;
  id?: string | undefined;
}

interface ArtifactListInput {
  /* no params */
}

interface ArtifactDeleteInput {
  id: string;
}

export const artifactSaveTool: ToolEntry<ArtifactSaveInput> = {
  definition: {
    name: 'artifact_save',
    description: 'Save or update a persistent artifact (dashboard, diagram, report, chart). Displays the artifact inline in the chat AND persists it to the Artifacts gallery. You do NOT need to include the HTML as a code block in your text — this tool handles display automatically. Use `id` to update an existing artifact.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short descriptive title for the artifact' },
        content: { type: 'string', description: 'Full HTML content (for type html), Mermaid syntax (for type mermaid), or SVG markup (for type svg)' },
        type: { type: 'string', enum: ['html', 'mermaid', 'svg'], description: 'Artifact type. Default: html' },
        description: { type: 'string', description: 'Optional one-line description' },
        id: { type: 'string', description: 'Existing artifact ID to update. Omit to create new.' },
      },
      required: ['title', 'content'],
    },
  },
  handler: async (input: ArtifactSaveInput, agent: IAgent): Promise<string> => {
    const store = agent.toolContext.artifactStore;
    if (!store) return 'Artifact store not available.';

    const artifact = store.save({
      title: input.title,
      content: input.content,
      ...(input.type ? { type: input.type } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.id ? { id: input.id } : {}),
    });

    const action = input.id ? 'Updated' : 'Saved';
    return `${action} artifact "${artifact.title}" (id: ${artifact.id})`;
  },
};

export const artifactListTool: ToolEntry<ArtifactListInput> = {
  definition: {
    name: 'artifact_list',
    description: 'List all saved artifacts.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  handler: async (_input: ArtifactListInput, agent: IAgent): Promise<string> => {
    const store = agent.toolContext.artifactStore;
    if (!store) return 'Artifact store not available.';

    const artifacts = store.list();
    if (artifacts.length === 0) return 'No saved artifacts.';

    return artifacts.map(a =>
      `[${a.type}] ${a.id} "${a.title}"${a.description ? ` — ${a.description}` : ''} (updated ${a.updatedAt.slice(0, 10)})`
    ).join('\n');
  },
};

export const artifactDeleteTool: ToolEntry<ArtifactDeleteInput> = {
  definition: {
    name: 'artifact_delete',
    description: 'Delete a saved artifact by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Artifact ID to delete' },
      },
      required: ['id'],
    },
  },
  handler: async (input: ArtifactDeleteInput, agent: IAgent): Promise<string> => {
    const store = agent.toolContext.artifactStore;
    if (!store) return 'Artifact store not available.';

    const deleted = store.delete(input.id);
    return deleted ? `Deleted artifact ${input.id}.` : `Artifact ${input.id} not found.`;
  },
};
