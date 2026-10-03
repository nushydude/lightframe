export interface ComfyLoraSetting {
  name: string;
  strength: string;
}

export interface ComfySamplerSettings {
  nodeId: string;
  nodeType: string;
  prompt: string | null;
  promptStatus: 'supported' | 'unresolved' | 'ambiguous';
  seed?: string;
  steps?: string;
  cfg?: string;
  sampler?: string;
  scheduler?: string;
  denoise?: string;
  width?: string;
  height?: string;
  batchSize?: string;
  model?: string;
  textEncoder?: string;
  vae?: string;
  loras: ComfyLoraSetting[];
}

export interface ParsedComfyPrompt {
  status: 'supported' | 'unsupported' | 'malformed';
  samplers: ComfySamplerSettings[];
  rawWorkflow: string | null;
  message?: string;
}

type JsonRecord = Record<string, unknown>;
type ApiNode = { class_type: string; inputs: JsonRecord };

const MAX_JSON_LENGTH = 2 * 1024 * 1024;
const MAX_NODES = 5000;
const SAMPLERS = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom']);
const TEXT_ENCODERS = new Set(['CLIPTextEncode']);
const CONDITIONING_INPUTS: Record<string, string[]> = {
  ConditioningAverage: ['conditioning_to', 'conditioning_from'],
  ConditioningCombine: ['conditioning_1', 'conditioning_2'],
  ConditioningConcat: ['conditioning_to', 'conditioning_from'],
  ConditioningSetArea: ['conditioning'],
  ConditioningSetAreaPercentage: ['conditioning'],
  ConditioningSetMask: ['conditioning'],
  ConditioningSetTimestepRange: ['conditioning'],
};

interface ComfyLink {
  nodeId: string;
  outputIndex: number;
}

interface PromptSource {
  nodeId: string;
  text: string;
  node: ApiNode;
}

interface PositiveResolution {
  sources: PromptSource[];
  hasUnsupportedPath: boolean;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function printable(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length <= 4096) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function link(value: unknown): ComfyLink | null {
  return Array.isArray(value) &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number' &&
    Number.isInteger(value[1]) &&
    value[1] >= 0
    ? { nodeId: value[0], outputIndex: value[1] }
    : null;
}

function walkUpstream(
  nodes: Record<string, ApiNode>,
  start: unknown,
  inputNames: string[],
  visit: (id: string, node: ApiNode, outputIndex: number) => boolean,
  depth = 0,
  visited = new Set<string>()
): void {
  const reference = link(start);
  if (!reference || depth > 64 || visited.has(reference.nodeId)) return;
  visited.add(reference.nodeId);
  const node = nodes[reference.nodeId];
  if (!node) return;
  const shouldContinue = visit(reference.nodeId, node, reference.outputIndex);
  if (!shouldContinue) return;
  for (const inputName of inputNames) {
    const value = node.inputs[inputName];
    if (link(value)) walkUpstream(nodes, value, inputNames, visit, depth + 1, visited);
  }
}

function conditioningInputs(node: ApiNode, outputIndex: number): string[] | null {
  if (node.class_type === 'ControlNetApplyAdvanced') {
    return outputIndex === 0 ? ['positive'] : null;
  }
  return outputIndex === 0 ? (CONDITIONING_INPUTS[node.class_type] ?? null) : null;
}

function collectPromptSources(
  nodes: Record<string, ApiNode>,
  input: unknown,
  result: PositiveResolution,
  visited: Set<string>,
  depth: number
): void {
  const reference = link(input);
  if (!reference || depth > 64) {
    result.hasUnsupportedPath = true;
    return;
  }
  if (visited.has(reference.nodeId)) return;
  visited.add(reference.nodeId);
  const node = nodes[reference.nodeId];
  if (!node) {
    result.hasUnsupportedPath = true;
    return;
  }
  if (TEXT_ENCODERS.has(node.class_type)) {
    const text = reference.outputIndex === 0 ? printable(node.inputs.text) : undefined;
    if (text === undefined) result.hasUnsupportedPath = true;
    else result.sources.push({ nodeId: reference.nodeId, text, node });
    return;
  }
  const inputNames = conditioningInputs(node, reference.outputIndex);
  if (!inputNames) {
    result.hasUnsupportedPath = true;
    return;
  }
  for (const name of inputNames) {
    if (node.inputs[name] !== undefined) {
      collectPromptSources(nodes, node.inputs[name], result, visited, depth + 1);
    }
  }
}

function resolvePositivePrompts(
  nodes: Record<string, ApiNode>,
  positive: unknown
): PositiveResolution {
  const result: PositiveResolution = { sources: [], hasUnsupportedPath: false };
  collectPromptSources(nodes, positive, result, new Set(), 0);
  return result;
}

function upstreamNamed(
  nodes: Record<string, ApiNode>,
  start: unknown,
  types: Set<string>,
  inputNames: string[],
  expectedOutputIndices: Record<string, number> = {}
) {
  const found: Array<{ id: string; node: ApiNode }> = [];
  walkUpstream(nodes, start, inputNames, (id, node, outputIndex) => {
    const expectedOutputIndex = expectedOutputIndices[node.class_type] ?? 0;
    if (outputIndex !== expectedOutputIndex) return false;
    if (types.has(node.class_type)) found.push({ id, node });
    return true;
  });
  return found;
}

function extractSampler(
  nodes: Record<string, ApiNode>,
  nodeId: string,
  node: ApiNode
): ComfySamplerSettings {
  const prompt = resolvePromptInfo(nodes, node.inputs.positive);
  const latent = findUniqueUpstreamNode(
    nodes,
    node.inputs.latent_image,
    ['EmptyLatentImage'],
    ['latent_image']
  );
  const model = resolveModelInfo(nodes, node.inputs.model);
  const textEncoder = resolveTextEncoder(nodes, prompt.textNode);
  const vae = resolveVae(nodes, nodeId);
  return {
    nodeId,
    nodeType: node.class_type,
    prompt: prompt.text,
    promptStatus: prompt.status,
    seed: printable(node.inputs.seed ?? node.inputs.noise_seed),
    steps: printable(node.inputs.steps),
    cfg: printable(node.inputs.cfg),
    sampler: printable(node.inputs.sampler_name),
    scheduler: printable(node.inputs.scheduler),
    denoise: printable(node.inputs.denoise),
    width: printable(latent?.inputs.width),
    height: printable(latent?.inputs.height),
    batchSize: printable(latent?.inputs.batch_size),
    model: model.name,
    textEncoder,
    vae,
    loras: model.loras,
  };
}

function findUniqueUpstreamNode(
  nodes: Record<string, ApiNode>,
  start: unknown,
  types: string[],
  inputNames: string[],
  outputIndices: Record<string, number> = {}
): ApiNode | undefined {
  const matches = upstreamNamed(nodes, start, new Set(types), inputNames, outputIndices);
  return matches.length === 1 ? matches[0].node : undefined;
}

function resolvePromptInfo(
  nodes: Record<string, ApiNode>,
  input: unknown
): { text: string | null; status: ComfySamplerSettings['promptStatus']; textNode?: ApiNode } {
  const resolution = resolvePositivePrompts(nodes, input);
  const uniqueSource = resolution.sources.length === 1 ? resolution.sources[0] : undefined;
  if (resolution.sources.length > 1) return { text: null, status: 'ambiguous' };
  if (!uniqueSource || resolution.hasUnsupportedPath) return { text: null, status: 'unresolved' };
  return { text: uniqueSource.text, status: 'supported', textNode: uniqueSource.node };
}

function resolveModelInfo(
  nodes: Record<string, ApiNode>,
  input: unknown
): { name?: string; loras: ComfyLoraSetting[] } {
  const outputIndices = {
    UNETLoader: 0,
    CheckpointLoaderSimple: 0,
    LoraLoader: 0,
    LoraLoaderModelOnly: 0,
  };
  const modelNode = findUniqueUpstreamNode(
    nodes,
    input,
    ['UNETLoader', 'CheckpointLoaderSimple'],
    ['model'],
    outputIndices
  );
  const loraNodes = upstreamNamed(
    nodes,
    input,
    new Set(['LoraLoader', 'LoraLoaderModelOnly', 'LoraLoader|pysssss']),
    ['model'],
    outputIndices
  );
  return {
    name: printable(modelNode?.inputs.unet_name ?? modelNode?.inputs.ckpt_name),
    loras: loraNodes.flatMap(({ node }) => {
      const name = printable(node.inputs.lora_name);
      if (!name) return [];
      return [
        {
          name,
          strength:
            printable(node.inputs.strength_model ?? node.inputs.strength) ??
            'strength not recorded',
        },
      ];
    }),
  };
}

function resolveTextEncoder(
  nodes: Record<string, ApiNode>,
  textNode?: ApiNode
): string | undefined {
  if (!textNode) return undefined;
  const clipNode = findUniqueUpstreamNode(
    nodes,
    textNode.inputs.clip,
    ['CLIPLoader', 'CheckpointLoaderSimple'],
    ['clip'],
    { CLIPLoader: 0, CheckpointLoaderSimple: 1, LoraLoader: 1 }
  );
  return printable(clipNode?.inputs.clip_name ?? clipNode?.inputs.ckpt_name);
}

function resolveVae(nodes: Record<string, ApiNode>, samplerId: string): string | undefined {
  const decoder = Object.values(nodes).find(
    (candidate) =>
      candidate.class_type === 'VAEDecode' && link(candidate.inputs.samples)?.nodeId === samplerId
  );
  if (!decoder) return undefined;
  const vaeNode = findUniqueUpstreamNode(
    nodes,
    decoder.inputs.vae,
    ['VAELoader', 'CheckpointLoaderSimple'],
    ['vae'],
    { VAELoader: 0, CheckpointLoaderSimple: 2 }
  );
  return printable(vaeNode?.inputs.vae_name ?? vaeNode?.inputs.ckpt_name);
}

export function parseComfyPrompt(
  promptJson: string | null | undefined,
  workflowJson: string | null | undefined = null
): ParsedComfyPrompt {
  const rawWorkflow = workflowJson && workflowJson.length <= MAX_JSON_LENGTH ? workflowJson : null;
  if (!promptJson) return { status: 'unsupported', samplers: [], rawWorkflow };
  if (promptJson.length > MAX_JSON_LENGTH) {
    return {
      status: 'malformed',
      samplers: [],
      rawWorkflow,
      message: 'Embedded prompt exceeds the 2 MB limit.',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(promptJson);
  } catch {
    return {
      status: 'malformed',
      samplers: [],
      rawWorkflow,
      message: 'Embedded ComfyUI prompt is not valid JSON.',
    };
  }
  const graph = record(parsed);
  if (!graph || Object.keys(graph).length > MAX_NODES) {
    return {
      status: 'malformed',
      samplers: [],
      rawWorkflow,
      message: 'Embedded ComfyUI prompt has an unsupported shape.',
    };
  }
  const nodes: Record<string, ApiNode> = {};
  for (const [id, value] of Object.entries(graph)) {
    const candidate = record(value);
    const inputs = record(candidate?.inputs);
    if (candidate && typeof candidate.class_type === 'string' && inputs) {
      nodes[id] = { class_type: candidate.class_type, inputs };
    }
  }
  const samplers = Object.entries(nodes)
    .filter(([, node]) => SAMPLERS.has(node.class_type))
    .map(([id, node]) => extractSampler(nodes, id, node));
  return {
    status: samplers.length ? 'supported' : 'unsupported',
    samplers,
    rawWorkflow,
    message: samplers.length ? undefined : 'No supported ComfyUI sampler nodes were found.',
  };
}
