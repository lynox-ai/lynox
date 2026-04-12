/**
 * Ambient declarations for optional LLM provider SDKs.
 * These packages are optional peer dependencies — only installed when needed.
 */

declare module '@anthropic-ai/vertex-sdk' {
  import type Anthropic from '@anthropic-ai/sdk';
  export class AnthropicVertex extends Anthropic {
    constructor(opts?: {
      projectId?: string | undefined;
      region?: string | undefined;
      accessToken?: string | undefined;
    });
  }
  export default AnthropicVertex;
}
