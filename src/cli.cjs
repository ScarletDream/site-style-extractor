const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { captureSelectedInteraction } = require('./capture-selected-interaction.cjs');
const { finalizeScan } = require('./finalize-scan.cjs');
const { replaceGeneratedDecisionBlock, renderDecisionBlock } = require('./render-analysis-decisions.cjs');
const { collectScan } = require('./scan-site.cjs');
const { validateCapturePackage, validateDeliveryPackage } = require('./validate-package.cjs');
const { runDoctor } = require('./doctor.cjs');

const HELP = `Usage:
  stylejuicer doctor [--json]
  stylejuicer scan <url> --run <directory> [--timeout-ms <1000-900000>] [--json]
  stylejuicer interact <url> --run <directory> --selection <selection.json> [--json]
  stylejuicer finalize --run <directory> --selection <selection.json> --out <directory> [--json]
  stylejuicer render --profile <style-profile.yaml> --analysis <analysis.md> [--json]
  stylejuicer validate <capture|delivery> <directory> [--json]
`;

class UsageError extends Error {}

function parseArguments(argv) {
  const values = [];
  const flags = {};
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') {
      json = true;
    } else if (value.startsWith('--')) {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new UsageError(`${value} requires a value.`);
      flags[value.slice(2)] = next;
      index += 1;
    } else {
      values.push(value);
    }
  }
  return { values, flags, json };
}

function requireFlag(flags, name) {
  if (!flags[name]) throw new UsageError(`--${name} is required.`);
  return flags[name];
}

function assertAllowedFlags(flags, allowed) {
  const unknown = Object.keys(flags).find((name) => !allowed.includes(name));
  if (unknown) throw new UsageError(`Unknown flag for this command: --${unknown}.`);
}

function optionalTimeoutMs(flags) {
  if (flags['timeout-ms'] === undefined) return undefined;
  if (!/^\d+$/.test(flags['timeout-ms'])) {
    throw new UsageError('--timeout-ms must be a whole number from 1000 to 900000.');
  }
  const value = Number(flags['timeout-ms']);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 900000) {
    throw new UsageError('--timeout-ms must be a whole number from 1000 to 900000.');
  }
  return value;
}

function statusExitCode(status) {
  return ['partial', 'blocked'].includes(status) ? 3 : 0;
}

function captureStatusFromDirectory(directory) {
  const evidence = JSON.parse(fs.readFileSync(path.join(path.resolve(directory), 'evidence.json'), 'utf8'));
  return evidence.captureStatus?.status || 'blocked';
}

async function renderProfile(options) {
  const profilePath = path.resolve(options.profile);
  const analysisPath = path.resolve(options.analysis);
  const profile = YAML.parse(fs.readFileSync(profilePath, 'utf8'));
  const markdown = fs.readFileSync(analysisPath, 'utf8');
  fs.writeFileSync(
    analysisPath,
    replaceGeneratedDecisionBlock(markdown, renderDecisionBlock(profile)),
    'utf8',
  );
  return { status: 'complete', analysis: analysisPath };
}

function defaultDependencies() {
  return {
    doctor: runDoctor,
    scan: collectScan,
    interact: captureSelectedInteraction,
    finalize: finalizeScan,
    render: renderProfile,
    validate: async ({ stage, directory }) => {
      const result = stage === 'capture'
        ? validateCapturePackage(path.resolve(directory))
        : validateDeliveryPackage(path.resolve(directory));
      return {
        ...result,
        captureStatus: result.ok ? captureStatusFromDirectory(directory) : undefined,
      };
    },
  };
}

function writeResult(io, result, json) {
  if (json) {
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const status = result.status
    || result.captureStatus?.status
    || result.captureStatus
    || result.manifest?.scanStatus?.status
    || (result.ok === true ? 'complete' : 'failed');
  io.stdout.write(`${status}\n`);
}

async function runCli(argv, io = { stdout: process.stdout, stderr: process.stderr }, dependencies = defaultDependencies()) {
  const args = Array.from(argv);
  if (args.length === 0 || ['--help', '-h', 'help'].includes(args[0])) {
    io.stdout.write(HELP);
    return 0;
  }

  const command = args.shift();
  try {
    const parsed = parseArguments(args);
    let result;
    let code;
    if (command === 'doctor') {
      assertAllowedFlags(parsed.flags, []);
      if (parsed.values.length) throw new UsageError('doctor does not accept positional arguments.');
      result = await dependencies.doctor({});
      code = result.status === 'complete' ? 0 : 1;
    } else if (command === 'scan') {
      assertAllowedFlags(parsed.flags, ['run', 'timeout-ms']);
      if (parsed.values.length !== 1) throw new UsageError('scan requires one public URL.');
      result = await dependencies.scan({
        url: parsed.values[0],
        outputDirectory: requireFlag(parsed.flags, 'run'),
        totalTimeoutMs: optionalTimeoutMs(parsed.flags),
      });
      code = statusExitCode(result.manifest.scanStatus.status);
    } else if (command === 'interact') {
      assertAllowedFlags(parsed.flags, ['run', 'selection']);
      if (parsed.values.length !== 1) throw new UsageError('interact requires one public URL.');
      result = await dependencies.interact({
        url: parsed.values[0],
        runDirectory: requireFlag(parsed.flags, 'run'),
        selectionPath: requireFlag(parsed.flags, 'selection'),
      });
      code = statusExitCode(result.status);
    } else if (command === 'finalize') {
      assertAllowedFlags(parsed.flags, ['run', 'selection', 'out']);
      if (parsed.values.length) throw new UsageError('finalize accepts flags only.');
      result = await dependencies.finalize(
        requireFlag(parsed.flags, 'run'),
        requireFlag(parsed.flags, 'selection'),
        requireFlag(parsed.flags, 'out'),
      );
      code = statusExitCode(result.captureStatus.status);
    } else if (command === 'render') {
      assertAllowedFlags(parsed.flags, ['profile', 'analysis']);
      if (parsed.values.length) throw new UsageError('render accepts flags only.');
      result = await dependencies.render({
        profile: requireFlag(parsed.flags, 'profile'),
        analysis: requireFlag(parsed.flags, 'analysis'),
      });
      code = 0;
    } else if (command === 'validate') {
      assertAllowedFlags(parsed.flags, []);
      if (parsed.values.length !== 2 || !['capture', 'delivery'].includes(parsed.values[0])) {
        throw new UsageError('validate requires <capture|delivery> <directory>.');
      }
      result = await dependencies.validate({ stage: parsed.values[0], directory: parsed.values[1] });
      code = result.ok ? statusExitCode(result.captureStatus) : 1;
    } else {
      throw new UsageError(`Unknown command: ${command}`);
    }
    writeResult(io, result, parsed.json);
    return code;
  } catch (error) {
    if (error.siteStyleResult?.manifest?.scanStatus) {
      writeResult(io, error.siteStyleResult, args.includes('--json'));
      if (!args.includes('--json')) {
        for (const reason of error.siteStyleResult.manifest.scanStatus.reasons || []) io.stderr.write(`${reason}\n`);
      }
      return statusExitCode(error.siteStyleResult.manifest.scanStatus.status);
    }
    io.stderr.write(`${error.message || error}\n`);
    if (error instanceof UsageError) io.stderr.write(HELP);
    return error instanceof UsageError ? 2 : 1;
  }
}

module.exports = {
  HELP,
  UsageError,
  captureStatusFromDirectory,
  defaultDependencies,
  optionalTimeoutMs,
  parseArguments,
  runCli,
  statusExitCode,
};
