// Update the existing printer's auth and verify it
import 'dotenv/config';
import { initDb } from './src/db/database.js';
import { PrinterModel } from './src/models/Printer.js';
import { encrypt } from './src/utils/crypto.js';
import { dbRun } from './src/db/database.js';

async function main() {
    await initDb();

    // List printers
    const printers = PrinterModel.findAll();
    console.log('=== Current Printers ===');
    for (const p of printers) {
        console.log(`ID: ${p.printer_id}`);
        console.log(`  Name: ${p.name}`);
        console.log(`  Model: ${p.model}`);
        console.log(`  IP: ${p.ip_hostname}`);
        console.log(`  Auth configured: ${p.auth?.configured}`);

        // Read actual auth
        const auth = PrinterModel.getAuth(p.printer_id);
        console.log(`  Auth contents: ${JSON.stringify(auth)}`);
        console.log('---');
    }
}

main().catch(console.error);
