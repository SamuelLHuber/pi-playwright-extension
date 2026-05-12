# pi-playwright-extension

Headless Playwright browser extension for pi.

## What it provides

This extension makes browser automation a first-class pi capability with a persistent headless browser session and browser-specific tools:

### Browser Tools
- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_press_key`
- `browser_wait_for`
- `browser_evaluate`
- `browser_console`
- `browser_network`
- `browser_screenshot`
- `browser_video_start`
- `browser_video_stop`
- `browser_video_status`
- `browser_run_summary`
- `browser_tabs`
- `browser_close`

### Wallet Tools (Web3)
- `wallet_enable` - Enable Pi Wallet provider in the browser
- `wallet_import` - Import a private key for signing
- `wallet_status` - Get wallet status and pending approvals
- `wallet_approve` - Approve a wallet request
- `wallet_reject` - Reject a wallet request

### Commands
- `/browser` - Show browser status
- `/browser-open <url>` - Open URL
- `/browser-reset` - Reset browser
- `/browser-close` - Close browser
- `/browser-video-start` - Start video recording
- `/browser-video-stop` - Stop video recording
- `/browser-clean` - Clean artifacts

### Wallet Commands
- `/wallet-enable` - Enable Pi Wallet in current page
- `/wallet-import <private-key>` - Import wallet
- `/wallet-generate` - Generate test wallet
- `/wallet-status` - Show wallet status
- `/wallet-approve [id]` - Approve request
- `/wallet-reject <id>` - Reject request

## Install locally in pi

From this directory:

```bash
npm install
```

Then load it from pi:

```bash
pi -e /absolute/path/to/pi-playwright-extension
```

Or add it to your pi package list/settings.

## Install from GitHub

This repo is intended for git-based installation in pi.

### HTTPS install

```bash
pi install git:github.com/SamuelLHuber/pi-playwright-extension
```

To pin a tag or commit:

```bash
pi install git:github.com/SamuelLHuber/pi-playwright-extension@<tag-or-commit>
```

### SSH install

If your environment already has GitHub SSH access configured:

```bash
pi install git:git@github.com:SamuelLHuber/pi-playwright-extension.git
```

Or pinned:

```bash
pi install git:git@github.com:SamuelLHuber/pi-playwright-extension.git@<tag-or-commit>
```

### Clone and load directly

If you prefer to keep the repo checked out locally:

```bash
git clone git@github.com:SamuelLHuber/pi-playwright-extension.git
cd pi-playwright-extension
npm install
pi -e .
```

### Project-local install

To install it only for the current project:

```bash
pi install -l git:github.com/SamuelLHuber/pi-playwright-extension
```

## Why this exists

This extension takes inspiration from Playwright MCP, but presents a pi-native tool surface instead of exposing a generic MCP bridge. The main goal is reliable headless webpage testing with a stable browser session across turns.

## Runtime behavior

- Headless by default
- Chromium by default
- Persistent browser session within the current pi session
- Browser reset on pi session switch, fork, or tree navigation
- Snapshot output includes stable element refs for later clicks and typing
- Screenshots and finalized video artifacts are written to the output directory
- Video recording can be enabled per session or at startup
- Artifact cleanup is handled by the extension using retention settings
- A consolidated run summary can bundle screenshot, video, logs, and a markdown report

## Flags

- `--browser-headless` - defaults to `true`
- `--browser-engine` - `chromium`, `firefox`, or `webkit`
- `--browser-output-dir` - defaults to `.pi/browser`
- `--browser-storage-state` - optional Playwright storage state JSON file
- `--browser-viewport` - defaults to `1440x960`
- `--browser-record-video` - defaults to `false`
- `--browser-video-size` - defaults to `1440x960`
- `--browser-retention-max-artifacts` - defaults to `50`
- `--browser-retention-max-bytes` - defaults to `536870912` (512MB)
- `--browser-retention-max-days` - defaults to `7`
- `--browser-timeout-action` - defaults to `5000`
- `--browser-timeout-navigation` - defaults to `30000`

## Recommended workflow

1. `browser_navigate`
2. `browser_snapshot`
3. `browser_click` / `browser_type` using returned refs
4. `browser_wait_for`
5. `browser_console` / `browser_network` when debugging
6. `browser_screenshot` when a file artifact is needed
7. `browser_video_start` before a flow and `browser_video_stop` after it when you want a full replay artifact
8. `browser_run_summary` at the end when you want one bundled artifact block with screenshot, video paths, diagnostics, and a markdown report
9. `/browser-clean` when you want to force pruning immediately

## Development

```bash
npm run check
npm test
```

## Retention and cleanup

Artifacts are written into the browser output directory, which defaults to `.pi/browser`.

The extension owns cleanup. When it writes screenshots, videos, or summary artifacts, it prunes old files using the configured retention policy.

Cleanup controls:

- `--browser-retention-max-artifacts`
- `--browser-retention-max-bytes`
- `--browser-retention-max-days`
- `/browser-clean`

This keeps browser output from growing without bound while still preserving recent evidence for debugging.

## Run summaries

`browser_run_summary` is an end-of-run packaging tool.

It can:

- capture a final screenshot
- optionally finalize active video recording
- include console output
- include network output
- optionally include a fresh browser snapshot
- write a markdown summary artifact
- return the key artifact paths in one compact tool result

Use it when the user asks for a report, evidence, or a bundled summary of a browser run.

## Verification

The test suite launches a real headless Chromium instance against a local HTTP server and verifies:

- navigation
- snapshot generation
- stable refs
- typing and clicking
- console capture
- network capture
- tab management
- video recording and artifact finalization
- bundled run summary generation
- artifact cleanup
- extension registration

## Pi Wallet (Web3)

Pi can act as a browser extension wallet like MetaMask, allowing you to connect to dApps and sign transactions.

### How it works

Pi Wallet uses the EIP-6963 standard (Multi-Provider Discovery) - the same standard MetaMask uses. When enabled, Pi injects a wallet provider into the page that dApps can discover.

### Usage Workflow

1. **Navigate to a dApp**:
   ```
   browser_navigate to https://app.uniswap.org
   ```

2. **Enable Pi Wallet**:
   ```
   wallet_enable
   ```

3. **Import your wallet**:
   ```
   wallet_import with privateKey=0x...
   ```
   Or generate a test wallet:
   ```
   /wallet-generate
   ```

4. **Connect on the dApp**:
   - Click "Connect Wallet" on the dApp
   - Select "Pi Wallet" from the options
   - Approve the connection request via `wallet_approve`

5. **Sign transactions**:
   - When the dApp requests a transaction or signature, Pi will pause
   - Use `wallet_status` to see pending requests
   - Use `wallet_approve` to sign, or `wallet_reject` to decline

### Security

- Private keys are stored only in memory for the session
- Every transaction requires explicit approval
- Keys are cleared when the pi session ends
- Never commit private keys to version control

### Supported Chains

- Ethereum Mainnet
- Sepolia (testnet)
- Polygon
- Optimism
- Arbitrum
- Base

Configure with `--wallet-default-chain` flag or pass chain to `wallet_enable`.

## Known limitations

- Optimized for headless automation, not interactive desktop browsing.
- Snapshot refs are intended to be used soon after `browser_snapshot`; page changes can invalidate them.
- Video recording recreates the browser context to ensure clean recordings.
- Browser state is intentionally reset on pi session switch, fork, or tree navigation.
