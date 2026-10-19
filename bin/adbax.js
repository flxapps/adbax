#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (typeof err.code === 'number') {
      process.stderr.write(`adbax: ${err.message}\n`);
      process.exit(err.code);
    }
    process.stderr.write(`adbax: ${err.stack || err}\n`);
    process.exit(1);
  },
);
