function requiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

async function getRequiredWorker(localPrinterId, deps) {
    const worker = await deps.getWorker?.(localPrinterId);
    if (!worker) throw new Error(`Local printer worker not found: ${localPrinterId}`);
    return worker;
}

async function executePrinterAction(command, deps) {
    const localPrinterId = requiredString(command.payload?.local_printer_id, 'payload.local_printer_id');
    const worker = await getRequiredWorker(localPrinterId, deps);

    switch (command.command_type) {
        case 'printer.status':
            return {
                state: worker.state,
                connected: !!worker.connected,
                status: worker.latestStatus || {},
                preflight: typeof worker.getPreflightStatus === 'function' ? worker.getPreflightStatus() : null,
            };
        case 'printer.pause':
            return worker._pausePrint();
        case 'printer.resume':
            return worker._resumePrint();
        case 'printer.stop':
            return worker._stopPrint();
        case 'printer.gcode':
            return worker._sendGcode(requiredString(command.payload?.gcode, 'payload.gcode'));
        default:
            throw new Error(`Unsupported printer command: ${command.command_type}`);
    }
}

async function executeJobAction(command, deps) {
    if (command.command_type !== 'job.start') {
        throw new Error(`Unsupported job command: ${command.command_type}`);
    }
    const localJobId = requiredString(command.payload?.local_job_id, 'payload.local_job_id');
    if (typeof deps.startJob !== 'function') throw new Error('startJob dependency is required');
    return deps.startJob(localJobId);
}

function getDefaultDeps() {
    return {
        async getWorker(printerId) {
            const { RuntimeSupervisor } = await import('../runtime/RuntimeSupervisor.js');
            return RuntimeSupervisor.getInstance()?.getWorker(printerId) || null;
        },
        async startJob(jobId) {
            const { JobOrchestrator } = await import('../services/JobOrchestrator.js');
            return JobOrchestrator.startJob(jobId);
        },
    };
}

export async function executeCloudCommand(command, deps = {}) {
    const effectiveDeps = { ...getDefaultDeps(), ...deps };
    const commandType = requiredString(command?.command_type, 'command.command_type');

    if (commandType.startsWith('printer.')) {
        return executePrinterAction({ ...command, command_type: commandType }, effectiveDeps);
    }

    if (commandType.startsWith('job.')) {
        return executeJobAction({ ...command, command_type: commandType }, effectiveDeps);
    }

    throw new Error(`Unsupported cloud command: ${commandType}`);
}
