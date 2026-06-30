#!/usr/bin/env node
// src/cli/automate.js — CLI entry point for the G-code Automator
//
// Usage:
//   node src/cli/automate.js --input model.gcode.3mf --model P1S --loops 5 --release-temp 27 --max-wait 60
//
// Output:
//   model_AUTOMATED_P1S_5LOOPS_RELEASE27_SWEEPZ4.gcode.3mf

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { automate, MODEL_DEFAULTS } from '../gcode/Automator.js';
import { extractGcodeFrom3mf, repack3mf } from '../gcode/AutomatorZip.js';

// ============================================================
// ARGUMENT PARSING
// ============================================================

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const key = argv[i];
        const val = argv[i + 1];
        switch (key) {
            case '--input':
            case '-i':
                args.input = val; i++; break;
            case '--model':
            case '-m':
                args.model = val?.toUpperCase(); i++; break;
            case '--loops':
            case '-n':
                args.loops = parseInt(val, 10); i++; break;
            case '--release-temp':
            case '-t':
                args.releaseTemp = parseInt(val, 10); i++; break;
            case '--max-wait':
            case '-w':
                args.maxWait = parseInt(val, 10); i++; break;
            case '--sweep-z':
                args.sweepZ = parseFloat(val); i++; break;
            case '--z-clear':
                args.zClear = parseFloat(val); i++; break;
            case '--output':
            case '-o':
                args.output = val; i++; break;
            case '--help':
            case '-h':
                printHelp(); process.exit(0);
            default:
                console.error(`Unknown argument: ${key}`);
                printHelp();
                process.exit(1);
        }
    }
    return args;
}

function printHelp() {
    console.log(`
G-code Automator — Bambu Studio .gcode.3mf Automation Tool

Usage:
  node src/cli/automate.js --input <file> [options]

Options:
  --input, -i      Input .gcode.3mf file (required)
  --model, -m      Printer model: P1S, X1, A1, A1_MINI (default: P1S)
  --loops, -n      Number of loops (default: 1)
  --release-temp, -t  Target bed release temp in °C (default: 27)
  --max-wait, -w   Max cooldown wait in minutes (default: 60)
  --sweep-z        Sweep height in mm (default: 4)
  --z-clear        Safe travel Z after sweep (default: 200)
  --output, -o     Output filename (auto-generated if omitted)
  --help, -h       Show this help

Supported models: ${Object.keys(MODEL_DEFAULTS).join(', ')}

Examples:
  node src/cli/automate.js -i model.gcode.3mf -m P1S -n 5
  node src/cli/automate.js -i model.gcode.3mf -m A1 -n 3 -t 25 -w 45
`);
}

// ============================================================
// MAIN
// ============================================================

function main() {
    const args = parseArgs(process.argv);

    if (!args.input) {
        console.error('Error: --input is required');
        printHelp();
        process.exit(1);
    }

    const model = args.model || 'P1S';
    if (!MODEL_DEFAULTS[model]) {
        console.error(`Error: Unknown printer model "${model}". Valid models: ${Object.keys(MODEL_DEFAULTS).join(', ')}`);
        process.exit(1);
    }

    const loops = args.loops || 1;
    const releaseTemp = args.releaseTemp ?? 27;
    const maxWait = args.maxWait ?? 60;
    const sweepZ = args.sweepZ ?? 4;
    const zClear = args.zClear ?? 200;

    console.log('╔══════════════════════════════════════════╗');
    console.log('║  Antigravity G-code Automator            ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`  Input:        ${args.input}`);
    console.log(`  Model:        ${model}`);
    console.log(`  Loops:        ${loops}`);
    console.log(`  Release Temp: ${releaseTemp}°C`);
    console.log(`  Wait Temp:    ${releaseTemp - 3}°C (after -3°C early exit offset)`);
    console.log(`  Max Wait:     ${maxWait} min`);
    console.log(`  M190 repeats: ${Math.ceil((maxWait * 60) / 90)}`);
    console.log(`  Sweep Z:      ${sweepZ}mm`);
    console.log(`  Z Clear:      ${zClear}mm`);
    console.log('');

    // Read input
    const inputBuf = readFileSync(args.input);
    console.log(`Read ${inputBuf.length} bytes from ${args.input}`);

    // Extract gcode from 3MF
    const { gcodeText, gcodeEntryName } = extractGcodeFrom3mf(inputBuf);
    console.log(`Extracted ${gcodeEntryName} (${gcodeText.length} chars)`);

    // Run automator
    const { output, report } = automate(gcodeText, {
        printerModel: model,
        loopsN: loops,
        releaseTempC: releaseTemp,
        maxWaitMin: maxWait,
        sweepZMm: sweepZ,
        zClearTravelMm: zClear,
    });

    console.log('');
    console.log('Transform Report:');
    console.log(`  Purge removal: ${report.purgeRemoval.found ? report.purgeRemoval.method : 'not found (safe)'}`);
    console.log(`  Insertion:     ${report.insertionPoint.method} (line ${report.insertionPoint.line})`);
    console.log(`  M190 repeats:  ${report.m190RepeatCount}`);
    console.log(`  Wait temp:     ${report.waitTempC}°C`);
    console.log(`  Sweep Z:       ${report.sweepZMm}mm`);
    console.log(`  Z Clear:       ${report.zClearClamped}mm`);
    console.log(`  Warnings:      ${report.warnings.length > 0 ? report.warnings.join('; ') : 'none'}`);
    console.log(`  Time:          ${report.transformTimeMs}ms`);
    console.log(`  Output lines:  ${output.split('\n').length}`);
    console.log('');

    // Repack 3MF
    const repackedBuf = repack3mf(inputBuf, gcodeEntryName, output);

    // Generate output filename
    const inputBase = basename(args.input)
        .replace(/\.gcode\.3mf$/i, '')
        .replace(/\.3mf$/i, '');
    const outputName = args.output ||
        join(dirname(args.input),
            `${inputBase}_AUTOMATED_${model}_${loops}LOOPS_RELEASE${releaseTemp}_SWEEPZ${sweepZ}.gcode.3mf`);

    writeFileSync(outputName, repackedBuf);
    console.log(`Output written: ${outputName} (${repackedBuf.length} bytes)`);

    // Also write plain gcode for debugging
    const debugGcodeName = outputName.replace(/\.gcode\.3mf$/i, '.debug.gcode');
    writeFileSync(debugGcodeName, output, 'utf-8');
    console.log(`Debug gcode:    ${debugGcodeName}`);

    console.log('');
    console.log('Done!');
}

main();
