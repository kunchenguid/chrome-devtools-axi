# Vision

`chrome-devtools-axi` is an agent-ergonomic interface to `chrome-devtools-mcp`.

## Scope

We aim for full functional parity with `chrome-devtools-mcp`.
Every capability available through the server should eventually be accessible through an AXI-native interface.

We accept contributions that expose existing server capabilities more ergonomically.
We do not add browser functionality that `chrome-devtools-mcp` cannot provide.

## Interface

The interface must follow validated AXI principles and optimize for autonomous agent use.

Output may be structured, but its structure exists for agent comprehension rather than as a stable API for imperative programs.
Human-oriented presentation and compatibility work primarily serving hand-written parsers are not goals.

The wrapper may reshape, combine, or simplify server operations when doing so improves agent ergonomics without expanding the underlying capability.

## Reliability

Improvements to bridge lifecycle, session isolation, reference integrity, and error recovery are welcome when they make the wrapper a more faithful and reliable interface to the server.
They must not become an independent browser-automation implementation.
