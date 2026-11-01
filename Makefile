.DEFAULT_GOAL := help
CARGO := cargo

.PHONY: help install dev web build build-debug test test-js test-rust test-integration \
        lint fmt typecheck check clean report

help: ## Show this help
	@awk 'BEGIN{FS=":.*## "} /^[a-zA-Z_-]+:.*## /{printf "  %-18s %s\n",$$1,$$2}' $(MAKEFILE_LIST)

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

test: test-js test-rust ## Run all unit tests

test-js: ## Run renderer unit tests
	npm test

test-rust: ## Run Rust unit tests
	$(CARGO) test --manifest-path src-tauri/Cargo.toml

test-integration: ## Run integration tests
	npm run test:integration

lint: ## Run clippy and the format check
	$(CARGO) fmt --manifest-path src-tauri/Cargo.toml --check
	$(CARGO) clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

fmt: ## Format Rust code
	$(CARGO) fmt --manifest-path src-tauri/Cargo.toml

typecheck: ## Run the TypeScript type check
	npm run typecheck

check: typecheck lint test ## Run type check, lint and all unit tests

clean: ## Remove build output
	rm -rf dist dist-spike
	$(CARGO) clean --manifest-path src-tauri/Cargo.toml

report: ## Build the technical report PDF
	$(MAKE) -C technical-report
