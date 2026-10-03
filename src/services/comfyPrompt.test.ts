import { describe, expect, it } from 'vitest';
import { parseComfyPrompt } from './comfyPrompt';

const promptJson = `{"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "krea2_turbo_fp8_scaled.safetensors", "weight_dtype": "default"}}, "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_4b_fp8_scaled.safetensors", "type": "krea2", "device": "default"}}, "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}}, "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": "ohwx woman with long waist-length jet-black side-parted hair, clear of her face and mouth, medium size natural breasts, fair light-tanned skin, and a patch of pubic hair. She stands in a quiet courtyard during Carnival in Salvador at dusk. Soft golden light and distant blocos. A thin sequined top is open and hanging. The energy of the street continues just beyond. She looks toward the camera with heated, playful intensity. Medium shot, Brazilian carnival atmosphere, photorealistic."}}, "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}}, "6": {"class_type": "EmptyLatentImage", "inputs": {"width": 1536, "height": 2048, "batch_size": 1}}, "7": {"class_type": "KSampler", "inputs": {"model": ["LX2", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0], "seed": 1282697391, "steps": 8, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}}, "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}}, "L1": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "ama_character_krea_v22_ohwx_rank64_768.safetensors", "strength_model": 1.0}}, "LX1": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["L1", 0], "lora_name": "Krea2_TextFusion_Refusal_Reduction.safetensors", "strength_model": 1.0}}, "LX2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["LX1", 0], "lora_name": "nsfw_helper_slider_loraholic.safetensors", "strength_model": 1.5}}, "save": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "krea2_eval/ohwx-v22-outdoor-a-abc71e82_krea2_pohwx-woman-festival-sensual-travel-p001-0239022_seed1282697391"}}}`;

const expectedPrompt =
  'ohwx woman with long waist-length jet-black side-parted hair, clear of her face and mouth, medium size natural breasts, fair light-tanned skin, and a patch of pubic hair. She stands in a quiet courtyard during Carnival in Salvador at dusk. Soft golden light and distant blocos. A thin sequined top is open and hanging. The energy of the street continues just beyond. She looks toward the camera with heated, playful intensity. Medium shot, Brazilian carnival atmosphere, photorealistic.';

describe('parseComfyPrompt', () => {
  it('extracts the sampler-linked positive prompt and reproducible settings from the supplied API graph', () => {
    const result = parseComfyPrompt(promptJson);
    expect(result.status).toBe('supported');
    expect(result.samplers).toHaveLength(1);
    expect(result.samplers[0]).toMatchObject({
      nodeId: '7',
      prompt: expectedPrompt,
      promptStatus: 'supported',
      seed: '1282697391',
      steps: '8',
      cfg: '1',
      sampler: 'euler',
      scheduler: 'simple',
      denoise: '1',
      width: '1536',
      height: '2048',
      batchSize: '1',
      model: 'krea2_turbo_fp8_scaled.safetensors',
      textEncoder: 'qwen3vl_4b_fp8_scaled.safetensors',
      vae: 'qwen_image_vae.safetensors',
      loras: [
        { name: 'nsfw_helper_slider_loraholic.safetensors', strength: '1.5' },
        { name: 'Krea2_TextFusion_Refusal_Reduction.safetensors', strength: '1' },
        { name: 'ama_character_krea_v22_ohwx_rank64_768.safetensors', strength: '1' },
      ],
    });
  });

  it('ignores negative and unconnected text encoders and keeps separate sampler paths', () => {
    const graph = JSON.parse(promptJson) as Record<string, Record<string, unknown>>;
    graph['9'] = {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['2', 0], text: 'unconnected text that must not be shown' },
    };
    graph['10'] = {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['2', 0], text: 'second sampler prompt' },
    };
    graph['11'] = {
      class_type: 'KSampler',
      inputs: {
        model: ['LX2', 0],
        positive: ['10', 0],
        negative: ['9', 0],
        latent_image: ['6', 0],
        seed: 4,
      },
    };

    const result = parseComfyPrompt(JSON.stringify(graph));
    expect(result.samplers.map(({ nodeId, prompt }) => [nodeId, prompt])).toEqual([
      ['7', expectedPrompt],
      ['11', 'second sampler prompt'],
    ]);
  });

  it('follows model and clip inputs independently through a regular LoRA loader', () => {
    const graph = JSON.parse(promptJson) as Record<string, Record<string, unknown>>;
    graph['20'] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'clip-only-checkpoint.safetensors' },
    };
    graph['21'] = {
      class_type: 'LoraLoader',
      inputs: {
        model: ['1', 0],
        clip: ['20', 0],
        lora_name: 'regular-lora.safetensors',
        strength_model: 0.75,
      },
    };
    const sampler = graph['7'] as { inputs: Record<string, unknown> };
    sampler.inputs.model = ['21', 0];

    expect(parseComfyPrompt(JSON.stringify(graph)).samplers[0]).toMatchObject({
      model: 'krea2_turbo_fp8_scaled.safetensors',
      loras: [{ name: 'regular-lora.safetensors', strength: '0.75' }],
    });
  });

  it('marks multiple connected positive text sources ambiguous instead of choosing one', () => {
    const graph = JSON.parse(promptJson) as Record<string, Record<string, unknown>>;
    graph['9'] = { class_type: 'CLIPTextEncode', inputs: { text: 'additional positive' } };
    graph['12'] = {
      class_type: 'ConditioningCombine',
      inputs: { conditioning_1: ['4', 0], conditioning_2: ['9', 0] },
    };
    const sampler = graph['7'] as { inputs: Record<string, unknown> };
    sampler.inputs.positive = ['12', 0];

    const result = parseComfyPrompt(JSON.stringify(graph));
    expect(result.samplers[0]).toMatchObject({ prompt: null, promptStatus: 'ambiguous' });
  });

  it('does not report encoder text or settings through ConditioningZeroOut', () => {
    const graph = JSON.parse(promptJson) as Record<string, Record<string, unknown>>;
    const sampler = graph['7'] as { inputs: Record<string, unknown> };
    sampler.inputs.positive = ['5', 0];

    expect(parseComfyPrompt(JSON.stringify(graph)).samplers[0]).toMatchObject({
      prompt: null,
      promptStatus: 'unresolved',
      textEncoder: undefined,
    });
  });

  it('preserves ControlNet output identity and never treats its negative output as positive', () => {
    const graph = JSON.parse(promptJson) as Record<string, Record<string, unknown>>;
    graph['9'] = {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['2', 0], text: 'negative branch text' },
    };
    graph['12'] = {
      class_type: 'ControlNetApplyAdvanced',
      inputs: { positive: ['4', 0], negative: ['9', 0] },
    };
    const sampler = graph['7'] as { inputs: Record<string, unknown> };
    sampler.inputs.positive = ['12', 0];
    expect(parseComfyPrompt(JSON.stringify(graph)).samplers[0]).toMatchObject({
      prompt: expectedPrompt,
      promptStatus: 'supported',
    });

    sampler.inputs.positive = ['12', 1];
    expect(parseComfyPrompt(JSON.stringify(graph)).samplers[0]).toMatchObject({
      prompt: null,
      promptStatus: 'unresolved',
    });
    sampler.inputs.positive = ['12', 2];
    expect(parseComfyPrompt(JSON.stringify(graph)).samplers[0]).toMatchObject({
      prompt: null,
      promptStatus: 'unresolved',
    });
  });

  it('marks identical text from distinct encoder paths ambiguous and withholds encoder settings', () => {
    const graph = JSON.parse(promptJson) as Record<string, Record<string, unknown>>;
    graph['13'] = {
      class_type: 'CLIPLoader',
      inputs: { clip_name: 'other-encoder.safetensors' },
    };
    graph['14'] = {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['13', 0], text: expectedPrompt },
    };
    graph['15'] = {
      class_type: 'ConditioningCombine',
      inputs: { conditioning_1: ['4', 0], conditioning_2: ['14', 0] },
    };
    const sampler = graph['7'] as { inputs: Record<string, unknown> };
    sampler.inputs.positive = ['15', 0];

    expect(parseComfyPrompt(JSON.stringify(graph)).samplers[0]).toMatchObject({
      prompt: null,
      promptStatus: 'ambiguous',
      textEncoder: undefined,
    });
  });

  it('does not render guider/custom-advanced nodes as supported sampler cards', () => {
    const result = parseComfyPrompt(
      JSON.stringify({
        '1': { class_type: 'CFGGuider', inputs: { positive: ['2', 0] } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'prompt' } },
        '3': { class_type: 'SamplerCustomAdvanced', inputs: { guider: ['1', 0] } },
      })
    );
    expect(result).toMatchObject({ status: 'unsupported', samplers: [] });
  });

  it('treats CLIPTextEncodeSDXL paths as unsupported instead of displaying only one text input', () => {
    const result = parseComfyPrompt(
      JSON.stringify({
        '1': {
          class_type: 'CLIPTextEncodeSDXL',
          inputs: { text_g: 'global text', text_l: 'local text' },
        },
        '2': {
          class_type: 'KSampler',
          inputs: { positive: ['1', 0] },
        },
      })
    );
    expect(result.samplers[0]).toMatchObject({ prompt: null, promptStatus: 'unresolved' });
  });

  it('returns safe unavailable states for absent, malformed, oversized, and unsupported metadata', () => {
    expect(parseComfyPrompt(null).status).toBe('unsupported');
    expect(parseComfyPrompt('{bad').status).toBe('malformed');
    expect(parseComfyPrompt(' '.repeat(2 * 1024 * 1024 + 1)).status).toBe('malformed');
    expect(
      parseComfyPrompt(JSON.stringify({ node: { class_type: 'Other', inputs: {} } }))
    ).toMatchObject({
      status: 'unsupported',
      samplers: [],
    });
  });

  it('keeps an exact-size raw editor workflow available for copy while bounding oversized data', () => {
    expect(parseComfyPrompt(promptJson, '{"nodes":[]}').rawWorkflow).toBe('{"nodes":[]}');
    expect(parseComfyPrompt(promptJson, ' '.repeat(2 * 1024 * 1024 + 1)).rawWorkflow).toBeNull();
  });
});
