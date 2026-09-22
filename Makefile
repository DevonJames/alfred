# Alfred local stack
#
#   make alfred                 # desktop + cascaded voice
#   make alfred VOICE=live      # desktop + GPT-Live experimental voice
#   make alfred VOICE=live2     # desktop + ElevenLabs Speech Engine (Alfred voice)
#   make alfred IOS=1           # desktop + voice + Expo Dev Client (tunnel)
#
# Ctrl+C stops all child processes.

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
IOS ?= 0
# cascade (default) | live (GPT-Live / Ripple) | live2 (ElevenLabs Speech Engine)
VOICE ?= cascade

.PHONY: alfred alfred-ios alfred-live alfredbot help

help:
	@echo "make alfred              Start pnpm desktop + pnpm voice (cascade)"
	@echo "make alfred VOICE=live   Start desktop + pnpm voice:live (GPT-Live / Ripple)"
	@echo "make alfred VOICE=live2  Desktop + ElevenLabs Speech Engine (needs ELEVENLABS_SPEECH_ENGINE_ID)"
	@echo "make alfred IOS=1        Also start Expo Dev Client with --tunnel"
	@echo "make alfred-live         Alias for make alfred VOICE=live"
	@echo "make alfred-ios          Alias for make alfred IOS=1"
	@echo "make alfredbot           AlfredBot kiosk host (http://127.0.0.1:3200)"

alfred:
	@cd "$(ROOT)" && \
	trap 'echo ""; echo "Stopping Alfred…"; kill 0' INT TERM EXIT; \
	if [ "$(VOICE)" != "live" ] && [ "$(VOICE)" != "live2" ] && [ "$(uname -s)" = "Darwin" ]; then \
		echo "→ build Apple on-device STT helper"; \
		pnpm --filter @alfred/provider-apple-stt run build:native || \
		  echo "  (Apple STT helper build failed — Deepgram still used if keyed)"; \
	fi; \
	echo "→ desktop (http://127.0.0.1:3000)"; \
	if [ "$(VOICE)" = "live" ]; then \
		echo "→ voice:live (GPT-Live / Ripple)  ALFRED_VOICE_STACK=live"; \
		export ALFRED_VOICE_STACK=live LIVEKIT_AGENT_NAME=$${LIVEKIT_AGENT_NAME:-alfred-live}; \
		ALFRED_VOICE_STACK=live LIVEKIT_AGENT_NAME=$${LIVEKIT_AGENT_NAME:-alfred-live} pnpm desktop & \
		ALFRED_VOICE_STACK=live LIVEKIT_AGENT_NAME=$${LIVEKIT_AGENT_NAME:-alfred-live} pnpm voice:live & \
	elif [ "$(VOICE)" = "live2" ]; then \
		echo "→ speech engine (ElevenLabs / Alfred voice)  ALFRED_VOICE_STACK=live2"; \
		echo "  no LiveKit voice worker — Talk audio is /voice/ via Speech Engine"; \
		ALFRED_VOICE_STACK=live2 pnpm desktop & \
	else \
		echo "→ voice (cascade)"; \
		pnpm desktop & \
		pnpm voice & \
	fi; \
	if [ "$(IOS)" = "1" ]; then \
		echo "→ iOS Expo Dev Client (--tunnel)"; \
		( cd "$(ROOT)/apps/iOS-client" && npx expo start --dev-client --tunnel ) & \
	fi; \
	wait

alfred-live:
	@$(MAKE) alfred VOICE=live IOS=$(IOS)

alfred-ios:
	@$(MAKE) alfred IOS=1

alfredbot:
	@cd "$(ROOT)" && pnpm alfredbot
