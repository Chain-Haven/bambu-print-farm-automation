import 'dotenv/config';
import { initDb, saveDb, closeDb } from './src/db/database.js';
import { PrinterModel } from './src/models/Printer.js';

async function main() {
    await initDb();
    const id = '5314e01d-b85e-49fe-8c2e-3b1ad615842f';

    // Update IP
    PrinterModel.update(id, { ip_hostname: process.env.PRINTER_IP || '192.168.1.50' });

    // Update auth with the configured access code and serial
    PrinterModel.update(id, {
        auth: {
            access_code: process.env.PRINTER_ACCESS_CODE || '12345678',
            serial: process.env.PRINTER_SERIAL || '00M00A123456789'
        }
    });

    // EXPLICITLY SAVE TO DISK
    saveDb();

    // Verify
    const printer = PrinterModel.findById(id);
    const auth = PrinterModel.getAuth(id);
    console.log('Updated printer:');
    console.log(`  Name: ${printer.name}`);
    console.log(`  IP: ${printer.ip_hostname}`);
    console.log(`  Auth: ${JSON.stringify(auth)}`);

    closeDb();
    console.log('✅ Saved and closed DB');
}

main().catch(console.error);
