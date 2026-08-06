import type {
  LLMProvider,
  ProviderManifest,
  STTProvider,
  TTSProvider,
  UnifiedRealtimeProvider,
} from "@alfred/contracts";
import type { ProviderRegistryPort } from "@alfred/core";

export class ProviderRegistry implements ProviderRegistryPort {
  private readonly llms = new Map<string, LLMProvider>();
  private readonly stts = new Map<string, STTProvider>();
  private readonly ttss = new Map<string, TTSProvider>();
  private readonly unified = new Map<string, UnifiedRealtimeProvider>();

  registerLlm(provider: LLMProvider): void {
    this.llms.set(provider.manifest.id, provider);
  }
  registerStt(provider: STTProvider): void {
    this.stts.set(provider.manifest.id, provider);
  }
  registerTts(provider: TTSProvider): void {
    this.ttss.set(provider.manifest.id, provider);
  }
  registerUnified(provider: UnifiedRealtimeProvider): void {
    this.unified.set(provider.manifest.id, provider);
  }

  getLlm(id: string): LLMProvider {
    const p = this.llms.get(id);
    if (!p) throw new Error(`Unknown LLM provider: ${id}`);
    return p;
  }
  getStt(id: string): STTProvider {
    const p = this.stts.get(id);
    if (!p) throw new Error(`Unknown STT provider: ${id}`);
    return p;
  }
  getTts(id: string): TTSProvider {
    const p = this.ttss.get(id);
    if (!p) throw new Error(`Unknown TTS provider: ${id}`);
    return p;
  }
  getUnified(id: string): UnifiedRealtimeProvider {
    const p = this.unified.get(id);
    if (!p) throw new Error(`Unknown unified provider: ${id}`);
    return p;
  }

  listManifests(): Map<string, ProviderManifest> {
    const map = new Map<string, ProviderManifest>();
    for (const p of this.llms.values()) map.set(p.manifest.id, p.manifest);
    for (const p of this.stts.values()) map.set(p.manifest.id, p.manifest);
    for (const p of this.ttss.values()) map.set(p.manifest.id, p.manifest);
    for (const p of this.unified.values()) map.set(p.manifest.id, p.manifest);
    return map;
  }
}
