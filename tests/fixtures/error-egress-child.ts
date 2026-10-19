/**
 * Child for `error-egress-process.test.ts`: leaves an error nobody catches, with or without an
 * exact connection held, and with or without error reporting on.
 * argv: <uncaught|rejection> <held|free> [reporting|reporting-removed|reporting-late|listener].
 */
import { refuseDebug } from '../../src/core/exact-debug-refusal.js';
import { initErrorReporting, installGlobalHandlers, uninstallGlobalHandlers } from '../../src/core/error-reporting.js';

const [mode, held, reporting] = process.argv.slice(2);
if (reporting === 'reporting' || reporting === 'reporting-removed') {
  // The SDK's own process handlers print the whole stack; the client must keep them out.
  if (!(await initErrorReporting('https://key@bugs.example.invalid/1'))) throw new Error('error reporting did not start');
  installGlobalHandlers();
  // Its handlers gone again (the privacy toggle off): the reduced handlers are the only ones.
  if (reporting === 'reporting-removed') uninstallGlobalHandlers();
}
// Another listener (a test runner, say) decides the exit; the reduced handler only writes.
if (reporting === 'listener') {
  process.on('uncaughtException', () => {});
  process.on('unhandledRejection', () => {});
}
if (held === 'held') refuseDebug({});
// Error reporting switched on again after the marker (the privacy toggle, a config DSN): refused.
if (reporting === 'reporting-late') {
  process.stdout.write(`late-init:${String(await initErrorReporting('https://key@bugs.example.invalid/1'))}\n`);
  installGlobalHandlers();
}

const err = Object.assign(new Error('provider said: PROVIDER-BODY-7f3a order of Jane Roe'), { status: 400 });
if (mode === 'uncaught') {
  setTimeout(() => { throw err; }, 0);
} else {
  void Promise.reject(err);
  // A rejection does not end the process under the reduced handlers; this line says it ran on.
  setTimeout(() => { process.stdout.write('still-running\n'); }, 50);
}
