#!/usr/bin/env node
//
import { injectCommands as injectBuilderCommands } from '@aztec/builder';
import { injectCommands as injectWalletCommands } from '@aztec/cli-wallet';
import { injectCommands as injectContractCommands } from '@aztec/cli/contracts';
import { injectCommands as injectDevnetCommands } from '@aztec/cli/devnet';
import { injectCommands as injectInfrastructureCommands } from '@aztec/cli/infrastructure';
import { injectCommands as injectL1Commands } from '@aztec/cli/l1';
import { injectCommands as injectMiscCommands } from '@aztec/cli/misc';
import { injectCommands as injectPXECommands } from '@aztec/cli/pxe';
import { createConsoleLogger, createLogger } from '@aztec/foundation/log';

import { Command } from 'commander';

import { injectAztecCommands } from '../cli/index.js';
import { getCliVersion } from '../cli/release_version.js';

const userLog = createConsoleLogger();
const debugLogger = createLogger('cli');

/** CLI & full node main entrypoint */
async function main() {
  const shutdown = () => {
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const cliVersion = getCliVersion();
  let program = new Command('aztec');
  program.description('Aztec command line interface').version(cliVersion);
  program = injectAztecCommands(program, userLog, debugLogger);
  program = injectBuilderCommands(program);
  program = injectContractCommands(program, userLog, debugLogger);
  program = injectInfrastructureCommands(program, userLog, debugLogger);
  program = injectL1Commands(program, userLog, debugLogger);
  program = injectPXECommands(program, userLog, debugLogger);
  program = injectMiscCommands(program, userLog);
  program = injectDevnetCommands(program, userLog, debugLogger);
  program = injectWalletCommands(program, userLog, debugLogger);

  await program.parseAsync(process.argv);
}

main().catch(err => {
  debugLogger.error(`Error in command execution`);
  debugLogger.error(err + '\n' + err.stack);
  // See https://nodejs.org/api/process.html#processexitcode
  process.exitCode = 1;
  throw err;
});
