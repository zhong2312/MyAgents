#!/usr/bin/env node

import readline from 'node:readline';
import { createLogRedactor } from './redact-log-core.mjs';

async function runCli() {
  const redact = createLogRedactor();
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of input) {
    process.stdout.write(`${redact(line)}\n`);
  }
}

runCli().catch((error) => {
  process.stderr.write(
    `log redaction failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
