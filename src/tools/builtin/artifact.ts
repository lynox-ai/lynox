import type { ToolEntry, IAgent } from '../../types/index.js';

interface ArtifactSaveInput {
  title: string;
  content: string;
  type?: 'html' | 'mermaid' | 'svg' | 'markdown' | undefined;
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
    description: 'Save or update a persistent artifact. Displays inline in the chat AND persists to the Artifacts gallery. PREFER `type: "markdown"` for comparison tables, tier overviews, recommendations, structured prose — it renders fast, costs far fewer tokens than hand-written HTML, and the user already gets a polished, shareable view. Reserve `type: "html"` ONLY for genuinely interactive output: clickable prototypes, dashboards with charts, time-series visualizations, mini-apps. Never embed Web Speech API, TTS, audio controls, or media players in HTML artifacts — the chat UI already provides audio output. Use `id` to update an existing artifact.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short descriptive title for the artifact' },
        content: { type: 'string', description: 'Markdown (for type markdown — preferred default), full HTML (for type html), Mermaid syntax (for type mermaid), or SVG markup (for type svg)' },
        type: { type: 'string', enum: ['markdown', 'html', 'mermaid', 'svg'], description: 'Artifact type. Default: markdown. Use html only for interactive output (dashboards, prototypes, charts).' },
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
