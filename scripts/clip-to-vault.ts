// Clip a URL via runRealClip and write the markdown to a vault path.
// Usage: clip-to-vault.ts <URL> <vault-md-abs-path> [--wait <selector>]

import { runRealClip } from './e2e-clip-runner';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
  const out = args.find((a) => a !== url && !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
  const waitIdx = args.indexOf('--wait');
  const wait = waitIdx >= 0 ? args[waitIdx + 1] : '.bd_detail_name';

  if (!url || !out) {
    console.error('Usage: clip-to-vault.ts <URL> <vault-md-abs-path> [--wait <selector>]');
    process.exit(2);
  }

  console.log(`[clip] ${url} → ${out} (wait=${wait})`);
  const clip = await runRealClip(url, { wait, timeout: 120_000 });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, clip.markdown, 'utf-8');
  console.log(`[clip] wrote ${clip.markdown.length}B in ${clip.durationMs}ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
