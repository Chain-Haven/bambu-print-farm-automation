import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

export function loadCloudSmokeEnv({
    cwd = process.cwd(),
    env = process.env,
    files = ['.env', '.env.local'],
} = {}) {
    for (const file of files) {
        const envPath = path.join(cwd, file);
        if (!fs.existsSync(envPath)) continue;

        const parsed = dotenv.parse(fs.readFileSync(envPath));
        for (const [key, value] of Object.entries(parsed)) {
            if (env[key] === undefined) {
                env[key] = value;
            }
        }
    }

    return env;
}
