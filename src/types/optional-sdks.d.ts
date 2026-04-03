/**
 * Ambient declarations for optional LLM provider SDKs.
 * These packages are optional peer dependencies — only installed when needed.
 */

declare module '@anthropic-ai/bedrock-sdk' {
  import type Anthropic from '@anthropic-ai/sdk';
  export class AnthropicBedrock extends Anthropic {
    constructor(opts?: {
      awsRegion?: string | undefined;
      awsAccessKey?: string | undefined;
      awsSecretKey?: string | undefined;
      awsSessionToken?: string | undefined;
    });
  }
  export default AnthropicBedrock;
}

declare module '@anthropic-ai/vertex-sdk' {
  import type Anthropic from '@anthropic-ai/sdk';
  export class AnthropicVertex extends Anthropic {
    constructor(opts?: {
      region?: string | undefined;
      projectId?: string | undefined;
    });
  }
  export default AnthropicVertex;
}
