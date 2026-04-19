# Changelog

All notable changes to cc-judge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.0.1] - 2026-04-19

### Added

- Extended trace format with optional `events`, `phases`, `agents`, `context`, and `judgeRubric` fields for multi-agent game evaluation
- Pluggable judge rubrics: pass a rubric file via `--judge-rubric` CLI option to customize judge scoring criteria
- Three layers of judge customization: declarative `judgeRubric` in trace/scenario, `systemPrompt` override on AnthropicJudgeBackend, and full JudgeBackend interface
- Directory and glob trace resolution: point `score` at a directory or glob pattern instead of a single file
- Event rendering in judge prompt: message, phase, action, and state events are formatted for the LLM judge
- Example conversation game rubric at `rubrics/conversation-game.md`
- 8 new tests for extended trace format (events, phases, agents, context, judgeRubric, backward compat, validation)

### Changed

- Judge prompt now conditionally renders events timeline instead of turns when events are present
- `resolveTraceFiles` expanded from single-file to glob/directory/single-file resolution
