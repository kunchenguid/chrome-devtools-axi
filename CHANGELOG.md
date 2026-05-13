# Changelog

## [0.1.22](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.21...chrome-devtools-axi-v0.1.22) (2026-05-13)


### Bug Fixes

* enable Codex hooks with hooks feature flag ([#59](https://github.com/kunchenguid/chrome-devtools-axi/issues/59)) ([e67a5ec](https://github.com/kunchenguid/chrome-devtools-axi/commit/e67a5ec723eff9756e391641754472a0e8896e37))

## [0.1.21](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.20...chrome-devtools-axi-v0.1.21) (2026-05-07)


### Bug Fixes

* **cli:** make type all clear prior filters ([#53](https://github.com/kunchenguid/chrome-devtools-axi/issues/53)) ([8001534](https://github.com/kunchenguid/chrome-devtools-axi/commit/8001534b03d5dd070fc15d90ca0ecd8486e7d7e4))
* handle function eval input wrapping ([#56](https://github.com/kunchenguid/chrome-devtools-axi/issues/56)) ([d9e6d9f](https://github.com/kunchenguid/chrome-devtools-axi/commit/d9e6d9f1b530a4a67e14e66859caed0215d472be))
* reject stale generation-tagged refs ([#55](https://github.com/kunchenguid/chrome-devtools-axi/issues/55)) ([ccac521](https://github.com/kunchenguid/chrome-devtools-axi/commit/ccac521cf649479cab2a1cad147a3526bb7b7bca))

## [0.1.20](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.19...chrome-devtools-axi-v0.1.20) (2026-05-06)


### Bug Fixes

* recycle stale bridge processes ([#51](https://github.com/kunchenguid/chrome-devtools-axi/issues/51)) ([9a97fbf](https://github.com/kunchenguid/chrome-devtools-axi/commit/9a97fbf6871637c07c6db5552c45ae9465a7c5bd))

## [0.1.19](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.18...chrome-devtools-axi-v0.1.19) (2026-05-03)


### Features

* add CHROME_DEVTOOLS_AXI_MCP_PATH + BRIDGE_TIMEOUT_MS to unblock slow npx bootstrap ([#47](https://github.com/kunchenguid/chrome-devtools-axi/issues/47)) ([6252b56](https://github.com/kunchenguid/chrome-devtools-axi/commit/6252b5601e5cb1f0f8275c5590f815530afec2f9))

## [0.1.18](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.17...chrome-devtools-axi-v0.1.18) (2026-04-25)


### Miscellaneous Chores

* release 0.1.18 ([cdb5c4b](https://github.com/kunchenguid/chrome-devtools-axi/commit/cdb5c4be015e03d62478db2fc5ea12e69c2b8c44))

## [0.1.17](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.16...chrome-devtools-axi-v0.1.17) (2026-04-16)


### Bug Fixes

* **ws:** support websocket browser endpoints and validate ws headers ([#37](https://github.com/kunchenguid/chrome-devtools-axi/issues/37)) ([8376a4f](https://github.com/kunchenguid/chrome-devtools-axi/commit/8376a4fd8c5bbc22d19598b64d25da6de7587eae))

## [0.1.16](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.15...chrome-devtools-axi-v0.1.16) (2026-04-16)


### Features

* add CHROME_DEVTOOLS_AXI_AUTO_CONNECT for Chrome 144+ autoConnect ([#33](https://github.com/kunchenguid/chrome-devtools-axi/issues/33)) ([542f176](https://github.com/kunchenguid/chrome-devtools-axi/commit/542f1762b8d63aacbfe19019c07c58758ab7517b))
* support ws:// and wss:// browser URLs plus CHROME_DEVTOOLS_AXI_WS_HEADERS ([c8710d5](https://github.com/kunchenguid/chrome-devtools-axi/commit/c8710d5ca958e08985180e4e5cf48c7ba8db0530))

## [0.1.15](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.14...chrome-devtools-axi-v0.1.15) (2026-04-11)


### Features

* add BROWSER_URL and USER_DATA_DIR env vars for persistent sessions ([#30](https://github.com/kunchenguid/chrome-devtools-axi/issues/30)) ([400fdda](https://github.com/kunchenguid/chrome-devtools-axi/commit/400fddad94545a9b7e353dab57892b2351c8574c))

## [0.1.14](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.13...chrome-devtools-axi-v0.1.14) (2026-04-10)


### Features

* add headed mode, custom Chrome args, and GPU docs ([#25](https://github.com/kunchenguid/chrome-devtools-axi/issues/25)) ([a917c1a](https://github.com/kunchenguid/chrome-devtools-axi/commit/a917c1af14b4e937f5f52bdb0d89e8a4eabe8948))

## [0.1.13](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.12...chrome-devtools-axi-v0.1.13) (2026-04-10)


### Bug Fixes

* **homeview:** reduce verbosity in home view ([#26](https://github.com/kunchenguid/chrome-devtools-axi/issues/26)) ([df709e9](https://github.com/kunchenguid/chrome-devtools-axi/commit/df709e98f1e06e90226b1ba95d29981de8ff5c17))

## [0.1.12](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.11...chrome-devtools-axi-v0.1.12) (2026-04-03)


### Features

* migrate CLI to axi-sdk-js ([#21](https://github.com/kunchenguid/chrome-devtools-axi/issues/21)) ([257c953](https://github.com/kunchenguid/chrome-devtools-axi/commit/257c953e101bb176e52c1eb874f46553dac67085))

## [0.1.11](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.10...chrome-devtools-axi-v0.1.11) (2026-04-01)


### Bug Fixes

* **cli:** add metadata to home view ([#19](https://github.com/kunchenguid/chrome-devtools-axi/issues/19)) ([8900215](https://github.com/kunchenguid/chrome-devtools-axi/commit/8900215983f79915fc1d4527b620003a9b900f0b))

## [0.1.10](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.9...chrome-devtools-axi-v0.1.10) (2026-04-01)


### Bug Fixes

* skip hook install for dev entrypoints ([#18](https://github.com/kunchenguid/chrome-devtools-axi/issues/18)) ([b12e043](https://github.com/kunchenguid/chrome-devtools-axi/commit/b12e043c731b66cf7246cb2fbd541dd70255bc39))
* trim no-session help text ([#16](https://github.com/kunchenguid/chrome-devtools-axi/issues/16)) ([a6c9820](https://github.com/kunchenguid/chrome-devtools-axi/commit/a6c9820798a5b466d6920592c68c52b60bc7e6a6))

## [0.1.9](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.8...chrome-devtools-axi-v0.1.9) (2026-03-31)


### Bug Fixes

* **snapshot:** improve truncation handling ([#13](https://github.com/kunchenguid/chrome-devtools-axi/issues/13)) ([7ebca68](https://github.com/kunchenguid/chrome-devtools-axi/commit/7ebca6867ff9bd950f63bc8fad7efc7913ccdcd5))
* **snapshot:** skip truncation when marker adds overhead ([#15](https://github.com/kunchenguid/chrome-devtools-axi/issues/15)) ([5ae7d62](https://github.com/kunchenguid/chrome-devtools-axi/commit/5ae7d6230e7b9fab5ac83933c6f067202dcc7742))

## [0.1.8](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.7...chrome-devtools-axi-v0.1.8) (2026-03-30)


### Bug Fixes

* **bridge:** handle exit and orphan cleanup ([#11](https://github.com/kunchenguid/chrome-devtools-axi/issues/11)) ([ea32d9b](https://github.com/kunchenguid/chrome-devtools-axi/commit/ea32d9b7fdc3f25da26e235e9f3677e5cbeee410))

## [0.1.7](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.6...chrome-devtools-axi-v0.1.7) (2026-03-30)


### Bug Fixes

* **cli:** support function input in eval ([#9](https://github.com/kunchenguid/chrome-devtools-axi/issues/9)) ([cb37c3d](https://github.com/kunchenguid/chrome-devtools-axi/commit/cb37c3d9c04ed98ade1fa053574dbb2be18fcf98))

## [0.1.6](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.5...chrome-devtools-axi-v0.1.6) (2026-03-30)


### Features

* **run-cmd:** add script runner command ([#7](https://github.com/kunchenguid/chrome-devtools-axi/issues/7)) ([5361cc2](https://github.com/kunchenguid/chrome-devtools-axi/commit/5361cc2d512beea2061b7511c9638308feb5abd2))


### Bug Fixes

* **hooks:** guard installHooks against unrelated execPath ([61c64e7](https://github.com/kunchenguid/chrome-devtools-axi/commit/61c64e7ffe6abcdaab0ee07487d019a494ac6bbe))

## [0.1.5](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.4...chrome-devtools-axi-v0.1.5) (2026-03-29)


### Bug Fixes

* code cleanup ([#5](https://github.com/kunchenguid/chrome-devtools-axi/issues/5)) ([4c435fe](https://github.com/kunchenguid/chrome-devtools-axi/commit/4c435fedf713bba367fc666520cab995c7e21740))

## [0.1.4](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.3...chrome-devtools-axi-v0.1.4) (2026-03-28)


### Bug Fixes

* enable codex hooks in config.toml ([1c7a38a](https://github.com/kunchenguid/chrome-devtools-axi/commit/1c7a38a6684edab81acf6ffcc831270792f7f191))

## [0.1.3](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.2...chrome-devtools-axi-v0.1.3) (2026-03-28)


### Bug Fixes

* small correction in README ([73c4780](https://github.com/kunchenguid/chrome-devtools-axi/commit/73c47806e56b3c1cc256e8c15bc88224637ebadd))

## [0.1.2](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.1...chrome-devtools-axi-v0.1.2) (2026-03-28)


### Features

* **cli:** add --full flag and session hooks ([25c3f53](https://github.com/kunchenguid/chrome-devtools-axi/commit/25c3f5300410c3144fba523f012a42ac454b139c))
* **cli:** add page management commands and tests ([32cc1f1](https://github.com/kunchenguid/chrome-devtools-axi/commit/32cc1f1171d1ec05f3e98979d93522543a7f8c7c))

## [0.1.1](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.0...chrome-devtools-axi-v0.1.1) (2026-03-27)


### Features

* initial commit ([ac8389b](https://github.com/kunchenguid/chrome-devtools-axi/commit/ac8389b7182a0a121b33589216b8eed60378c5f4))
