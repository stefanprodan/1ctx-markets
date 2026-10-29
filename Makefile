# 1ctx-markets - Makefile
#
# Thin wrapper over the package.json scripts: each task runs the script of the
# same name, so `make <task>` and `bun run <task>` are interchangeable. The
# actual commands live in package.json, edit them there.

export VERSION

.DEFAULT_GOAL := help

.PHONY: help start dev test lint build clean smoke staging-deploy staging-status staging-secrets

help: ## Show available tasks
	@grep -hE '^[a-z][a-z-]*:.*## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

start: ## Run from source (make start ARGS="--listen 127.0.0.1:1234")
	@bun run start $(ARGS)

dev: ## Run from source and restart on changes (make dev ARGS="...")
	@bun run dev $(ARGS)

test: ## Run tests
	@bun run test $(ARGS)

lint: ## Format and lint with Biome, then type-check with bun check
	@bun run lint

build: ## Compile a standalone binary into bin/ (release: VERSION=v1.2.3)
	@bun run build

smoke: ## Start the compiled binary, check its keys and MCP answer, stop it
	@bun run smoke

clean: ## Remove the build artifacts
	@bun run clean

staging-deploy: ## Build main, back the staging db up, swap the binary and restart its service
	@bun run staging-deploy

staging-status: ## What the staging service says
	@bun run staging-status

staging-secrets: ## Copy the source keys staging lacks (DIR=<dir>)
	@bun run staging-secrets $(DIR)
