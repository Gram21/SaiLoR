.DEFAULT_GOAL := help
CARGO := cargo

.PHONY: help setup install dev web build build-debug probe test test-js test-rust test-integration \
        lint fmt typecheck check clean trace report docker-linux docker-gui-build docker-gui

help: ## Show this help
	@awk 'BEGIN{FS=":.*## "} /^[a-zA-Z_-]+:.*## /{printf "  %-18s %s\n",$$1,$$2}' $(MAKEFILE_LIST)

setup: ## Install build prerequisites (Rust, Node, system libraries), asks first
	@if [ "$$OS" = Windows_NT ]; then powershell -ExecutionPolicy Bypass -File scripts/setup.ps1; else bash scripts/setup.sh; fi

install: ## Install Node dependencies
	npm ci

dev: ## Start the desktop app (Tauri) with hot reload
	npx tauri dev --config src-tauri/tauri.conf.json

web: ## Start the renderer only in a browser
	npm run dev

build: ## Build the release installer for this OS
	npx tauri build --config src-tauri/tauri.conf.json

build-debug: ## Build a debug app without installer bundles
	npx tauri build --debug --no-bundle --config src-tauri/tauri.conf.json

probe: ## Build the CI probe app (e2e/ page, probe commands) without bundles
	npx tauri build --no-bundle --features probe --config src-tauri/tauri.probe.conf.json

test: test-js test-rust ## Run all unit tests

test-js: ## Run renderer unit tests
	npm test

test-rust: ## Run Rust unit tests
	$(CARGO) test --manifest-path src-tauri/Cargo.toml

test-integration: ## Run integration tests
	npm run test:integration

lint: ## Run clippy and the format check
	$(CARGO) fmt --manifest-path src-tauri/Cargo.toml --check
	$(CARGO) clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings

fmt: ## Format Rust code
	$(CARGO) fmt --manifest-path src-tauri/Cargo.toml

typecheck: ## Run the TypeScript type check
	npm run typecheck

check: typecheck lint test ## Run type check, lint and all unit tests

clean: ## Remove build output
	rm -rf dist dist-probe
	$(CARGO) clean --manifest-path src-tauri/Cargo.toml

OFT_VERSION := 4.11.0
OFT_SHA256 := f094cd314f0fc4236f513f66fb39260a16f72e2320beb6b4fdeb7940b9b8cf87
OFT_DIR := .cache/oft
OFT_JAR := $(OFT_DIR)/openfasttrace-$(OFT_VERSION).jar
OFT_SOURCES := src src-tauri/src samples/git-scenarios e2e

$(OFT_JAR):
	mkdir -p $(@D)
	curl -fsSL -o $@.part https://repo1.maven.org/maven2/org/itsallcode/openfasttrace/openfasttrace/$(OFT_VERSION)/openfasttrace-$(OFT_VERSION).jar
	echo "$(OFT_SHA256)  $@.part" | shasum -a 256 -c -
	mv $@.part $@

# The OFT command line reads no .tsx files, so each one is linked as .tsx.ts under $(OFT_DIR)/tsx.
trace: $(OFT_JAR) ## Check requirement trace links with OpenFastTrace (report in .cache/oft/)
	@test -d docs/requirements-oft || { echo "docs/requirements-oft is missing: run python3 scripts/oft/convert-requirements.py"; exit 1; }
	rm -rf $(OFT_DIR)/tsx
	find $(OFT_SOURCES) -name '*.tsx' | while read -r f; do mkdir -p "$(OFT_DIR)/tsx/$$(dirname "$$f")"; ln -s "$(CURDIR)/$$f" "$(OFT_DIR)/tsx/$$f.ts"; done
	java -jar $(OFT_JAR) trace -o html -f $(OFT_DIR)/trace.html docs/requirements-oft $(OFT_SOURCES) $(OFT_DIR)/tsx || true
	java -jar $(OFT_JAR) trace -c BLACK_AND_WHITE -f $(OFT_DIR)/trace.txt docs/requirements-oft $(OFT_SOURCES) $(OFT_DIR)/tsx; s=$$?; tail -n 1 $(OFT_DIR)/trace.txt; exit $$s

report: ## Build the technical report PDF
	$(MAKE) -C technical-report

docker-linux: ## Build Linux bundles (AppImage, deb, rpm) in Docker
	docker compose -f docker-compose.dev.yml run --rm --build tauri-linux

docker-gui-build: ## Build the container image that runs SaiLoR in a browser
	docker compose -f docker-compose.dev.yml build tauri-linux-gui

docker-gui: ## Run SaiLoR in a container, open http://localhost:6080
	mkdir -p projects
	docker compose -f docker-compose.dev.yml up --build tauri-linux-gui
