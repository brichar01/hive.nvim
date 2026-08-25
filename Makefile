.PHONY: test test-one lint format typecheck check dev clean measure-consumers measure-prefill

test:
	nvim -l tests/minit.lua --minitest $(FILE)

test-one:
	nvim -l tests/minit.lua --minitest tests/$(MODULE)_spec.lua

lint:
	stylua --check lua/ plugin/ tests/

format:
	stylua lua/ plugin/ tests/

typecheck:
	@export TMPFILE="/tmp/hive_vimruntime" && \
		nvim --headless -c 'lua io.open(os.getenv("TMPFILE"),"w"):write(vim.env.VIMRUNTIME or ""):close()' -c 'q' 2>/dev/null && \
		VIMRUNTIME="$$(cat "$$TMPFILE")" && rm -f "$$TMPFILE" && \
		test -n "$$VIMRUNTIME" && \
		export VIMRUNTIME && \
		lua-language-server --check_format=pretty --check lua/ --configpath="$$(pwd)/.luarc.json" --checklevel=Warning

check: lint typecheck test

# Re-measures §7.4 / [R§11.9]: which servers can say what calls the target,
# and by which request. Needs the language servers on PATH or in mason's bin;
# skips the ones that are absent. See scripts/measure/consumers.lua.
measure-consumers:
	nvim -l scripts/measure/consumers.lua

# Re-measures §8.3.1 / §8.3.4: prefill and decode throughput, what the prefix
# cache is worth, bytes per token, and what the server does past its window.
# Defaults to $HIVE_MEASURE_URL, else the local llama-server on :8080. Run the
# `decompose` mode first on a new server (§8.3.8). See
# scripts/measure/prefill.lua.
measure-prefill:
	nvim -l scripts/measure/prefill.lua all

dev:
	nvim -u repro/repro.lua

clean:
	find . -type d -name '.repro' -exec rm -rf {} +
	find . -type d -name '.tests' -exec rm -rf {} +
