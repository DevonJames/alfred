# Alfred local stack
#
#   make alfred              # desktop + voice
#   make alfred IOS=1        # desktop + voice + Expo Dev Client (tunnel)
#
# Ctrl+C stops all child processes.

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
IOS ?= 0

.PHONY: alfred alfred-ios help

help:
	@echo "make alfred          Start pnpm desktop + pnpm voice"
	@echo "make alfred IOS=1    Also start Expo Dev Client with --tunnel"
	@echo "make alfred-ios      Alias for make alfred IOS=1"

alfred:
	@cd "$(ROOT)" && \
	trap 'echo ""; echo "Stopping Alfred…"; kill 0' INT TERM EXIT; \
	echo "→ desktop (http://127.0.0.1:3000)"; \
	pnpm desktop & \
	echo "→ voice"; \
	pnpm voice & \
	if [ "$(IOS)" = "1" ]; then \
		echo "→ iOS Expo Dev Client (--tunnel)"; \
		( cd "$(ROOT)/apps/iOS-client" && npx expo start --dev-client --tunnel ) & \
	fi; \
	wait

alfred-ios:
	@$(MAKE) alfred IOS=1
