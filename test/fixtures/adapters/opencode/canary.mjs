// Fake canary child, no MCP protocol or network. Positive and negative control logic only.
import { appendFileSync } from 'node:fs';
import process from 'node:process';
appendFileSync(process.argv[2], 'started\n');
