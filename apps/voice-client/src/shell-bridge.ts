export type ShellVoiceState = {
  linked: boolean;
  speaking: boolean;
  muted: boolean;
  rms: number;
  caption: string;
};

export const SHELL_CHANNEL = "alfred.shell";
const CHANNEL = SHELL_CHANNEL;

let lastPostMs = 0;
let lastLinked = false;
let lastSpeaking = false;
let lastMuted = false;

export function isEmbedded(): boolean {
  return window.parent !== window;
}

export function postShellState(state: ShellVoiceState): void {
  if (!isEmbedded()) return;
  const now = Date.now();
  const linkedChanged = state.linked !== lastLinked;
  const speakingChanged = state.speaking !== lastSpeaking;
  const mutedChanged = state.muted !== lastMuted;
  if (!linkedChanged && !speakingChanged && !mutedChanged && now - lastPostMs < 50) return;
  lastPostMs = now;
  lastLinked = state.linked;
  lastSpeaking = state.speaking;
  lastMuted = state.muted;
  window.parent.postMessage({ channel: CHANNEL, type: "state", ...state }, window.location.origin);
}

/** Switch the desktop shell tab (Agenda, Reminders, …) when Talk is embedded. */
export function navigateShell(screen: string): void {
  if (!isEmbedded()) {
    const match = location.pathname.match(/^(\/proxy\/[^/]+)/);
    const prefix = match?.[1] ?? "";
    if (screen === "agenda") location.assign(`${prefix}/agenda`);
    else if (screen === "reminders") location.assign(`${prefix}/reminders`);
    return;
  }
  window.parent.postMessage({ channel: CHANNEL, type: "navigate", screen }, window.location.origin);
}
