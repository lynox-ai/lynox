import type { ToolEntry, IAgent } from '../../types/index.js';

interface ArtifactSaveInput {
  title: string;
  content: string;
  type?: 'html' | 'mermaid' | 'svg' | 'markdown' | 'csv' | 'tsv' | 'json' | 'text' | undefined;
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
    description: 'Save, create, or update a persistent document, note, file, or artifact. Displays inline in the chat AND persists to the Artifacts gallery. PREFER `type: "markdown"` for comparison tables, tier overviews, recommendations, structured prose. Use a data type — `csv`/`tsv` for tabular/spreadsheet data, `json` for structured data, `text` for plain-text files/logs — for anything the user will open in another program (renders as a downloadable file). Reserve `type: "html"` ONLY for genuinely interactive output: dashboards with charts, clickable prototypes, time-series visualizations, mini-apps. Use `id` to update an existing artifact.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short descriptive title for the artifact' },
        content: { type: 'string', description: 'Markdown (for type markdown — preferred default), full HTML (for type html), Mermaid syntax (for type mermaid), SVG markup (for type svg), or the raw file body for a data type (csv/tsv/json/text)' },
        type: { type: 'string', enum: ['markdown', 'html', 'mermaid', 'svg', 'csv', 'tsv', 'json', 'text'], description: 'Artifact type. Default: markdown. Use html only for interactive output (dashboards, prototypes, charts). Use csv/tsv/json/text for data the user will download as a file.' },
        description: { type: 'string', description: 'Optional one-line description' },
        id: { type: 'string', description: 'Existing artifact ID to update. Omit to create new.' },
      },
      required: ['title', 'content'],
    },
  },
  detailedGuidance:
    'markdown renders fast and costs far fewer tokens than hand-written HTML, and the user already gets a polished, shareable view — prefer it for anything prose-shaped. Never wrap raw CSV/TSV/JSON in a markdown or html artifact; emit it as the matching data type so it downloads as a file. When you DO use html (incl. slide decks): make it mobile-ready — fluid %/max-width, never a fixed page-px width — and light unless the user asked for dark. Never embed Web Speech API, TTS, audio controls, or media players in html artifacts — the chat UI already provides audio output.',
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
    const path = store.pathFor(artifact.id);
    const lines = [
      `${action} artifact "${artifact.title}" (id: ${artifact.id}, v${artifact.version}).`,
      `File: ${path}`,
    ];

    // Make an overwrite VISIBLE (it replaced existing content) and recoverable,
    // instead of silently clobbering a good version (rafael 2026-06-04).
    const ow = artifact.overwrite;
    if (ow) {
      const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
      const pct = ow.previousBytes > 0
        ? ` (${ow.newBytes >= ow.previousBytes ? '+' : ''}${Math.round((ow.newBytes - ow.previousBytes) / ow.previousBytes * 100)}%)`
        : '';
      lines.push(
        `Replaced v${ow.previousVersion}: ${kb(ow.previousBytes)} → ${kb(ow.newBytes)}${pct}.` +
        (ow.backupPath ? ` Previous version backed up to ${ow.backupPath} — read_file it to recover.` : ''),
      );
      if (ow.significant) {
        lines.push(
          `⚠ Large rewrite — the new content is less than half the previous size. ` +
          `If you meant to make a targeted change rather than replace the whole document, ` +
          `recover from the backup above and apply a find/replace edit instead.`,
        );
      }
    }

    lines.push(
      `To revise it, read_file this path and apply a targeted edit (find/replace) instead of ` +
      `re-sending the whole document — the gallery picks up the change automatically.`,
    );
    return lines.join('\n');
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

    // Include the on-disk path so a revise/read doesn't guess it wrong — the
    // agent burned two failed read_file calls + a `find` guessing the path in
    // the lynox Marktanalyse thread (rafael 2026-06-04).
    return artifacts.map(a =>
      `[${a.type}] ${a.id} "${a.title}" (v${a.version}, updated ${a.updatedAt.slice(0, 10)})` +
      `${a.description ? ` — ${a.description}` : ''}\n  path: ${store.pathFor(a.id)}`
    ).join('\n');
  },
};

export const artifactDeleteTool: ToolEntry<ArtifactDeleteInput> = {
  destructive: { mode: 'data' },
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

interface ArtifactHistoryInput {
  id: string;
}

interface ArtifactRestoreInput {
  id: string;
  version: number;
}

export const artifactHistoryTool: ToolEntry<ArtifactHistoryInput> = {
  definition: {
    name: 'artifact_history',
    description: "List an artifact's prior versions (newest first) so you can recover an earlier draft after an overwrite. Roll back with artifact_restore.",
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Artifact ID' },
      },
      required: ['id'],
    },
  },
  handler: async (input: ArtifactHistoryInput, agent: IAgent): Promise<string> => {
    const store = agent.toolContext.artifactStore;
    if (!store) return 'Artifact store not available.';
    const current = store.get(input.id);
    if (!current) return `Artifact ${input.id} not found.`;
    const hist = store.history(input.id);
    if (hist.length === 0) {
      return `Artifact "${current.title}" is at v${current.version} with no earlier versions stored yet.`;
    }
    const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
    const lines = hist.map(h => `  v${h.version} · ${kb(h.bytes)} · saved ${h.savedAt.slice(0, 16).replace('T', ' ')}`);
    return (
      `"${current.title}" (id: ${input.id}) — current v${current.version}.\n` +
      `Prior versions (newest first):\n${lines.join('\n')}\n` +
      `Roll back with artifact_restore { id: "${input.id}", version: <n> }.`
    );
  },
};

export const artifactRestoreTool: ToolEntry<ArtifactRestoreInput> = {
  definition: {
    name: 'artifact_restore',
    description: 'Restore an artifact to a prior version (from artifact_history). Reversible — the current content is snapshotted first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Artifact ID' },
        version: { type: 'number', description: 'Version number to restore (from artifact_history)' },
      },
      required: ['id', 'version'],
    },
  },
  handler: async (input: ArtifactRestoreInput, agent: IAgent): Promise<string> => {
    const store = agent.toolContext.artifactStore;
    if (!store) return 'Artifact store not available.';
    const restored = store.restore(input.id, input.version);
    if (!restored) {
      return `Could not restore — artifact ${input.id} or version ${String(input.version)} not found. Use artifact_history to see available versions.`;
    }
    return (
      `Restored "${restored.title}" to the content of v${input.version} ` +
      `(now saved as v${restored.version}, id: ${restored.id}). The previous content is kept in history, so this is reversible.`
    );
  },
};
