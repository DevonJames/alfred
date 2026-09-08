export type ShellVoiceState = {
  linked: boolean;
  speaking: boolean;
  rms: number;
  caption: string;
};

const CHANNEL = "alfred.shell";

let lastPostMs = 0;
let lastLinked = false;
let lastSpeaking = false;

export function isEmbedded(): boolean {
  return window.parent !== window;
}

export function postShellState(state: ShellVoiceState): void {
  if (!isEmbedded()) return;
  const now = Date.now();
  const linkedChanged = state.linked !== lastLinked;
  const speakingChanged = state.speaking !== lastSpeaking;
  if (!linkedChanged && !speakingChanged && now - lastPostMs < 50) return;
  lastPostMs = now;
  lastLinked = state.linked;
  lastSpeaking = state.speaking;
  window.parent.postMessage({ channel: CHANNEL, type: "state", ...state }, window.location.origin);
}
