#!/usr/bin/env node
// src/gcode/cli.js — CLI tool for G-code transformation
// Usage: node src/gcode/cli.js --profile <name> <input> <output> [--report <path>]

import { program } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { transformGcode, DEFAULT_PROFILE } from './GcodeTransformer.js';

program
    .name('ag-gcode-transform')
    .description('Antigravity G-code Transform CLI — Make any sliced G-code automation-ready')
    .version('1.0.0')
    .argument('<input>', 'Input G-code file path')
    .argument('[output]', 'Output G-code file path (default: <input>.AG.gcode)')
    .option('-p, --profile <name>', 'Profile name (a1_default, p1s_default, x1c_default, universal)', 'universal')
    .option('-r, --report <path>', 'Write JSON report to file')
    .option('--no-prime-removal', 'Skip prime/purge line removal')
    .option('--no-markers', 'Skip AG automation marker insertion')
    .option('--no-parking', 'Skip parking move insertion')
    .option('--park-x <mm>', 'Park X position', parseFloat)
    .option('--park-y <mm>', 'Park Y position', parseFloat)
    .option('--park-z <mm>', 'Park Z position', parseFloat)
    .option('--release-temp <c>', 'Release bed temperature (°C)', parseFloat)
    .option('--job-id <id>', 'Job ID for AG markers')
    .action((input, output, opts) => {
        try {
            // Validate input
            if (!fs.existsSync(input)) {
                console.error(`Error: Input file not found: ${input}`);
                process.exit(1);
            }

            // Build profile from defaults + options
            const profile = {
                ...DEFAULT_PROFILE,
                name: opts.profile,
            };

            if (!opts.primeRemoval) profile.remove_front_prime_line = false;
            if (!opts.markers) profile.insert_automation_tags = false;
            if (!opts.parking) profile.park_before_eject = false;
            if (opts.parkX !== undefined) profile.park_x_mm = opts.parkX;
            if (opts.parkY !== undefined) profile.park_y_mm = opts.parkY;
            if (opts.parkZ !== undefined) profile.park_z_mm = opts.parkZ;
            if (opts.releaseTemp !== undefined) profile.release_bed_temp_c = opts.releaseTemp;

            // Read input
            const content = fs.readFileSync(input, 'utf-8');
            console.log(`Input: ${input} (${content.split('\n').length} lines)`);

            // Transform
            const meta = {
                filename: path.basename(input),
                job_id: opts.jobId || 'CLI',
            };
            const result = transformGcode(content, profile, meta);

            // Write output
            const outputPath = output || result.outputFilename;
            fs.writeFileSync(outputPath, result.output, 'utf-8');
            console.log(`Output: ${outputPath} (${result.report.transformed_line_count} lines)`);

            // Print summary
            console.log('\n--- Transform Report ---');
            if (result.report.prime_line) {
                console.log(`Prime line: method=${result.report.prime_line.method_used}, disabled=${result.report.prime_line.lines_disabled_count}`);
            }
            if (result.report.markers) {
                console.log(`AG markers: inserted at line ${result.report.markers.insertedAt}`);
            }
            if (result.report.parking?.inserted) {
                console.log(`Parking: inserted at line ${result.report.parking.insertedAt}`);
            }
            console.log(`Validation: ${result.report.validation.valid ? 'PASS' : 'FAIL'}`);
            if (result.report.warnings.length) {
                console.log(`Warnings: ${result.report.warnings.join('; ')}`);
            }
            console.log(`Hash: ${result.report.hash}`);
            console.log(`Time: ${result.report.transform_time_ms}ms`);

            // Write report
            if (opts.report) {
                fs.writeFileSync(opts.report, JSON.stringify(result.report, null, 2), 'utf-8');
                console.log(`Report: ${opts.report}`);
            }

        } catch (err) {
            console.error(`Transform failed: ${err.message}`);
            process.exit(1);
        }
    });

program.parse();
