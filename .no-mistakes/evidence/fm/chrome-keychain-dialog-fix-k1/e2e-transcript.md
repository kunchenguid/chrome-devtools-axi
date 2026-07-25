# Keychain isolation end-to-end evidence

This check exercised the default isolated launch mode through the real CLI while
redirecting `HOME` to an empty directory inside the worktree. That recreates the
important environmental condition behind the macOS failure chain: the launched
process cannot resolve the machine owner's login keychain through its HOME.

## Open a real page

```console
$ HOME="<worktree>/.no-mistakes/evidence/fm/chrome-keychain-dialog-fix-k1/runtime-home" \
  CHROME_DEVTOOLS_AXI_SESSION=keychain-e2e \
  CHROME_DEVTOOLS_AXI_PORT=19324 \
  pnpm run dev open https://example.com

$ tsx bin/chrome-devtools-axi.ts open https://example.com
page:
  title: Example Domain
  url: "https://example.com"
  refs: 5
snapshot:
uid=g1:1_0 RootWebArea "Example Domain" url="https://example.com/"
  uid=g1:1_1 heading "Example Domain" level="1"
  uid=g1:1_2 StaticText "This domain is for use in documentation examples without needing permission. Avoid use in operations."
  uid=g1:1_3 link "Learn more" url="https://iana.org/domains/example"
    uid=g1:1_4 StaticText "Learn more"
```

The accompanying `example-domain.png` is the screenshot captured from this
same live browser session.

## Inspect the real Chrome launch arguments

The Chrome process descended from this test session's bridge had this relevant
argument sequence:

```text
Google Chrome
  ...
  --password-store=basic
  --use-mock-keychain
  ...
  --headless=new
  ...
  --use-mock-keychain
  --password-store=basic
  ...
  --remote-debugging-pipe
  --user-data-dir=<isolated-profile>
```

Both flags appear twice as intended: once from Puppeteer's current defaults and
once from chrome-devtools-axi's explicit defense-in-depth arguments. Chrome
tolerated the duplicates, opened the page successfully, and remained operable
long enough for the CLI to capture the screenshot.

No keychain command was run and no keychain, credential, cookie, password, or
owner Chrome profile data was accessed.
